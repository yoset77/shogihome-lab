//! Per-connection TCP relay between the server and one engine process.
//!
//! Protocol (see `docs/rust-rewrite.md` §1):
//! - optional CRAM-SHA256 auth, then one command line (`list` / `run <id>`
//!   / legacy `research` / `game`);
//! - `list` writes the full `engines.json` array and closes (server parses
//!   on EOF);
//! - after `run`, every client line is engine input; configured options are
//!   injected once immediately before the first forwarded `isready`;
//! - one buffered input stream survives all phases, so `run`+`usi` arriving
//!   in a single TCP read is never lost;
//! - any auth failure fails closed: buffered `run` lines are never processed
//!   and no engine is spawned.

use std::path::Path;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::TcpStream;
use tokio::sync::watch;

use crate::auth;
use crate::config::{find_engine, format_option, load_engines, log, resolve_engine_path};
use crate::encoding::{decode_line, MAX_LINE_BYTES};
use crate::process::{is_not_found, spawn_engine, EngineChild};

const QUIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
const TERM_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);
const DRAIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(1);
/// Upper bound for one socket/stdin write (including flush). Every relay
/// write races this timeout against listener shutdown so a peer that stops
/// reading can never wedge termination or cancellation.
const WRITE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Shared per-listener state cloned into each connection task.
#[derive(Clone)]
pub struct RelayContext {
    pub config_dir: Arc<Path>,
    pub access_token: Option<Arc<str>>,
    pub shutdown: watch::Receiver<bool>,
}

/// Serve one client connection until close. Owns the engine child (if any)
/// and runs exactly one cleanup at the end.
///
/// Every pre-spawn wait (auth challenge/response, first command, `list`
/// reply) races listener shutdown: no child is owned yet, so a shutdown
/// simply ends the connection and lets the listener drain finish.
pub async fn handle_connection(stream: TcpStream, ctx: RelayContext) {
    let (read_half, write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half);
    let mut writer = write_half;
    let mut shutdown = ctx.shutdown.clone();
    if *shutdown.borrow() {
        let _ = writer.shutdown().await;
        return;
    }

    if let Some(token) = ctx.access_token.clone() {
        if !handshake(&mut reader, &mut writer, &token, &mut shutdown).await {
            return;
        }
    }

    let command = match read_line_cancel(&mut reader, &mut shutdown).await {
        Some(line) => line,
        None => return, // EOF, error, or shutdown before command.
    };

    if command == "list" {
        let engines = load_engines(&ctx.config_dir);
        let body = serde_json::to_string(&engines).unwrap_or_else(|_| "[]".to_string());
        let mut payload = body.into_bytes();
        payload.push(b'\n');
        let _ = socket_write(&mut writer, &payload, &mut shutdown).await;
        let _ = writer.shutdown().await;
        return;
    }

    let engine_id = if let Some(id) = command.strip_prefix("run ") {
        id.trim().to_string()
    } else if command == "research" || command == "game" {
        command.clone()
    } else {
        write_error(
            &mut writer,
            "WRAPPER_ERROR: Invalid command. Use 'list' or 'run <id>'.",
            &mut shutdown,
        )
        .await;
        return;
    };

    let engines = load_engines(&ctx.config_dir);
    let Some(def) = find_engine(&engines, &engine_id) else {
        write_error(
            &mut writer,
            &format!("WRAPPER_ERROR: Engine ID '{engine_id}' not found."),
            &mut shutdown,
        )
        .await;
        return;
    };
    let Some(path_str) = def.get("path").and_then(|v| v.as_str()) else {
        write_error(
            &mut writer,
            "WRAPPER_ERROR: Engine path configuration error.",
            &mut shutdown,
        )
        .await;
        return;
    };
    let Some((engine_path, engine_dir)) = resolve_engine_path(&ctx.config_dir, path_str) else {
        write_error(
            &mut writer,
            "WRAPPER_ERROR: Engine path configuration error.",
            &mut shutdown,
        )
        .await;
        return;
    };

    // Snapshot configured options at spawn time (insertion order preserved).
    let option_lines: Vec<String> = def
        .get("options")
        .and_then(|v| v.as_object())
        .map(|map| {
            map.iter()
                .filter_map(|(name, value)| match format_option(name, value) {
                    Some(line) => Some(line),
                    None => {
                        log::warn_compat(&format!("skipping option with invalid value: {name}"));
                        None
                    }
                })
                .collect()
        })
        .unwrap_or_default();

    let mut child = match spawn_engine(&engine_path, &engine_dir) {
        Ok(child) => child,
        Err(e) => {
            log::warn_compat(&format!("failed to start engine '{engine_id}': {e}"));
            let msg = if is_not_found(&e) {
                "WRAPPER_ERROR: Engine executable not found."
            } else {
                "WRAPPER_ERROR: Failed to start engine process."
            };
            write_error(&mut writer, msg, &mut shutdown).await;
            return;
        }
    };
    log::info(&format!(
        "started engine '{engine_id}' path {} pid {:?}",
        engine_path.display(),
        child.id()
    ));

    let stdin = relay_loop(&mut reader, &mut writer, &mut child, option_lines, &ctx).await;
    cleanup(&mut writer, &mut child, stdin).await;
}

/// CRAM-SHA256 handshake. Returns true when the client may proceed.
/// Every wait races shutdown: aborting here owns no child, so there is
/// nothing to clean up beyond closing the socket.
async fn handshake(
    reader: &mut BufReader<OwnedReadHalf>,
    writer: &mut OwnedWriteHalf,
    token: &str,
    shutdown: &mut watch::Receiver<bool>,
) -> bool {
    let nonce = auth::generate_nonce();
    let challenge = format!("auth_cram_sha256 {nonce}\n");
    if socket_write(writer, challenge.as_bytes(), shutdown)
        .await
        .is_err()
    {
        return false;
    }
    let line = match read_line_cancel(reader, shutdown).await {
        Some(line) => line,
        None => return false,
    };
    if let Some(digest) = line.strip_prefix("auth ") {
        if auth::verify_digest(token, &nonce, digest.trim()) {
            return socket_write(writer, b"auth_ok\n", shutdown).await.is_ok();
        }
        log::warn_compat("authentication failed");
        write_error(writer, "WRAPPER_ERROR: Authentication failed", shutdown).await;
        return false;
    }
    log::warn_compat("unexpected command during auth");
    write_error(writer, "WRAPPER_ERROR: Authentication required", shutdown).await;
    false
}

/// Read one `\n`-terminated line, returning the trimmed text.
/// `None` on EOF (no bytes), read error, oversized line, or listener
/// shutdown. Buffered bytes stay in `reader`. Only used before an engine
/// is spawned, where ending the whole connection is always safe.
async fn read_line_cancel(
    reader: &mut BufReader<OwnedReadHalf>,
    shutdown: &mut watch::Receiver<bool>,
) -> Option<String> {
    let mut buf = Vec::new();
    tokio::select! {
        biased;
        _ = shutdown.changed() => None,
        result = reader.read_until(b'\n', &mut buf) => match result {
            Ok(0) => None,
            Ok(_) => {
                if buf.len() > MAX_LINE_BYTES {
                    return None;
                }
                let text = String::from_utf8_lossy(&buf);
                Some(text.trim_end_matches(['\r', '\n']).to_string())
            }
            Err(_) => None,
        },
    }
}

async fn write_error(writer: &mut OwnedWriteHalf, msg: &str, shutdown: &mut watch::Receiver<bool>) {
    let mut payload = msg.as_bytes().to_vec();
    payload.push(b'\n');
    let _ = socket_write(writer, &payload, shutdown).await;
    let _ = writer.shutdown().await;
}

/// Bidirectional relay until client EOF, engine exit, write failure, or
/// listener shutdown. All writes to the engine stdin and to the socket pass
/// through this single loop, so output bytes can never interleave.
///
/// Returns the engine stdin handle still open so cleanup can deliver `quit`
/// before closing it (closing stdin first would let the engine exit on EOF
/// without ever seeing `quit`, unlike both previous wrappers).
async fn relay_loop(
    reader: &mut BufReader<OwnedReadHalf>,
    writer: &mut OwnedWriteHalf,
    child: &mut EngineChild,
    option_lines: Vec<String>,
    ctx: &RelayContext,
) -> Option<tokio::process::ChildStdin> {
    let mut stdin = child.stdin().take();
    let mut stdout: Option<Box<dyn AsyncRead + Unpin + Send>> =
        child.stdout().take().map(|p| Box::new(p) as _);
    let mut stderr: Option<Box<dyn AsyncRead + Unpin + Send>> =
        child.stderr().take().map(|p| Box::new(p) as _);
    let mut options_applied = false;
    let mut shutdown = ctx.shutdown.clone();

    let mut cbuf: Vec<u8> = Vec::new();
    let mut obuf: Vec<u8> = Vec::new();
    let mut ebuf: Vec<u8> = Vec::new();
    let mut otmp = vec![0u8; 8192];
    let mut etmp = vec![0u8; 8192];
    let mut stdout_eof = stdout.is_none();
    let mut stderr_eof = stderr.is_none();

    loop {
        tokio::select! {
            biased;

            _ = shutdown.changed() => break,

            result = child.wait() => {
                match result {
                    Ok(status) => log::info(&format!("engine exited with {status}")),
                    Err(e) => log::warn_compat(&format!("engine wait failed: {e}")),
                }
                // Reaped leaders may leave helpers holding the inherited pipes.
                child.terminate_tree(false);
                // Preserve buffered terminal output, but never wait indefinitely
                // on a pipe or on a client that has stopped reading.
                let _ = tokio::time::timeout(DRAIN_TIMEOUT, async {
                    if let Some(out) = stdout.as_mut() {
                        drain_stream(out, &mut obuf, writer, &mut shutdown).await;
                    }
                    if let Some(err) = stderr.as_mut() {
                        drain_stream(err, &mut ebuf, writer, &mut shutdown).await;
                    }
                }).await;
                break;
            }

            result = reader.read_until(b'\n', &mut cbuf), if stdin.is_some() => {
                match result {
                    Ok(0) => break, // Client FIN: ordinary stop path.
                    Ok(_) => {
                        if cbuf.len() > MAX_LINE_BYTES {
                            break;
                        }
                        let text = String::from_utf8_lossy(&cbuf);
                        let command = text.trim_end_matches(['\r', '\n']).to_string();
                        cbuf.clear();
                        let Some(stdin) = stdin.as_mut() else { break };
                        if command == "isready" && !options_applied {
                            let mut failed = false;
                            for line in &option_lines {
                                let mut payload = line.as_bytes().to_vec();
                                payload.push(b'\n');
                                if stdin_write(stdin, &payload, &mut shutdown).await.is_err() {
                                    failed = true;
                                    break;
                                }
                            }
                            if failed {
                                break;
                            }
                            options_applied = true;
                        }
                        let mut payload = command.into_bytes();
                        payload.push(b'\n');
                        if stdin_write(stdin, &payload, &mut shutdown).await.is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }

            result = async {
                match stdout.as_mut() {
                    Some(out) => out.read(&mut otmp).await,
                    None => std::future::pending().await,
                }
            }, if !stdout_eof => {
                match result {
                    Ok(0) => {
                        stdout_eof = true;
                        if flush_remainder(&mut obuf, writer, &mut shutdown).await.is_err() {
                            break;
                        }
                    }
                    Ok(n) => {
                        if forward_bytes(&otmp[..n], &mut obuf, writer, &mut shutdown).await.is_err() {
                            break;
                        }
                    }
                    Err(_) => stdout_eof = true,
                }
            }

            result = async {
                match stderr.as_mut() {
                    Some(err) => err.read(&mut etmp).await,
                    None => std::future::pending().await,
                }
            }, if !stderr_eof => {
                match result {
                    Ok(0) => {
                        stderr_eof = true;
                        if flush_remainder(&mut ebuf, writer, &mut shutdown).await.is_err() {
                            break;
                        }
                    }
                    Ok(n) => {
                        if forward_bytes(&etmp[..n], &mut ebuf, writer, &mut shutdown).await.is_err() {
                            break;
                        }
                    }
                    Err(_) => stderr_eof = true,
                }
            }
        }

        // Both output streams closed while the client is still here: the
        // engine is going away; stop relaying and let cleanup reap it.
        if stdout_eof && stderr_eof {
            // Give the child a moment to report its exit status first.
            break;
        }
    }

    stdin
}

/// Write one payload to the socket, racing shutdown and a per-write timeout.
/// `Err(())` means the relay loop must stop: shutdown, timeout, or a write
/// failure (all route to the single cleanup path).
async fn socket_write(
    writer: &mut OwnedWriteHalf,
    data: &[u8],
    shutdown: &mut watch::Receiver<bool>,
) -> Result<(), ()> {
    tokio::select! {
        biased;
        _ = shutdown.changed() => Err(()),
        res = tokio::time::timeout(WRITE_TIMEOUT, writer.write_all(data)) => {
            match res {
                Ok(Ok(())) => Ok(()),
                _ => Err(()),
            }
        }
    }?;
    tokio::select! {
        biased;
        _ = shutdown.changed() => Err(()),
        res = tokio::time::timeout(WRITE_TIMEOUT, writer.flush()) => {
            match res {
                Ok(Ok(())) => Ok(()),
                _ => Err(()),
            }
        }
    }
}

/// Write one payload to the engine stdin under the same cancel/timeout
/// budget as socket writes.
async fn stdin_write(
    stdin: &mut tokio::process::ChildStdin,
    data: &[u8],
    shutdown: &mut watch::Receiver<bool>,
) -> Result<(), ()> {
    tokio::select! {
        biased;
        _ = shutdown.changed() => Err(()),
        res = tokio::time::timeout(WRITE_TIMEOUT, stdin.write_all(data)) => {
            match res {
                Ok(Ok(())) => Ok(()),
                _ => Err(()),
            }
        }
    }?;
    tokio::select! {
        biased;
        _ = shutdown.changed() => Err(()),
        res = tokio::time::timeout(WRITE_TIMEOUT, stdin.flush()) => {
            match res {
                Ok(Ok(())) => Ok(()),
                _ => Err(()),
            }
        }
    }
}

/// Append `chunk` to the pending buffer and forward complete lines.
/// A socket write failure aborts the relay (callers break to cleanup).
async fn forward_bytes(
    chunk: &[u8],
    pending: &mut Vec<u8>,
    writer: &mut OwnedWriteHalf,
    shutdown: &mut watch::Receiver<bool>,
) -> Result<(), ()> {
    if pending.len() + chunk.len() > MAX_LINE_BYTES * 2 {
        return Ok(()); // Shed overload instead of growing without bound.
    }
    pending.extend_from_slice(chunk);
    while let Some(pos) = pending.iter().position(|&b| b == b'\n') {
        let line: Vec<u8> = pending.drain(..=pos).collect();
        let text = decode_line(trim_newline(&line));
        let mut payload = text.into_bytes();
        payload.push(b'\n');
        socket_write(writer, &payload, shutdown).await?;
    }
    // Flush even with no complete line so partial output is not stuck behind
    // a full buffer; a failed flush is a failed client.
    tokio::select! {
        biased;
        _ = shutdown.changed() => Err(()),
        res = tokio::time::timeout(WRITE_TIMEOUT, writer.flush()) => {
            match res {
                Ok(Ok(())) => Ok(()),
                _ => Err(()),
            }
        }
    }
}

/// Forward an unterminated trailing line (Node parity: flush on EOF).
async fn flush_remainder(
    pending: &mut Vec<u8>,
    writer: &mut OwnedWriteHalf,
    shutdown: &mut watch::Receiver<bool>,
) -> Result<(), ()> {
    if pending.is_empty() {
        return Ok(());
    }
    let rest: Vec<u8> = std::mem::take(pending);
    let text = decode_line(trim_newline(&rest));
    let mut payload = text.into_bytes();
    payload.push(b'\n');
    socket_write(writer, &payload, shutdown).await
}

fn trim_newline(line: &[u8]) -> &[u8] {
    let mut end = line.len();
    while end > 0 && (line[end - 1] == b'\n' || line[end - 1] == b'\r') {
        end -= 1;
    }
    &line[..end]
}

/// Read a pipe to EOF, forwarding everything (used after engine exit).
/// Stops early on a dead client so the post-exit drain cannot wedge cleanup.
async fn drain_stream(
    pipe: &mut (dyn AsyncRead + Unpin + Send),
    pending: &mut Vec<u8>,
    writer: &mut OwnedWriteHalf,
    shutdown: &mut watch::Receiver<bool>,
) {
    let mut tmp = vec![0u8; 8192];
    loop {
        match pipe.read(&mut tmp).await {
            Ok(0) => break,
            Ok(n) => {
                if forward_bytes(&tmp[..n], pending, writer, shutdown)
                    .await
                    .is_err()
                {
                    pending.clear();
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let _ = flush_remainder(pending, writer, shutdown).await;
}

/// Idempotent end-of-session cleanup: `quit` -> 5s -> tree SIGTERM/taskkill
/// -> 3s -> tree SIGKILL, then close the client socket. Already-exited
/// engines skip escalation; every child is reaped with `wait()`.
async fn cleanup(
    writer: &mut OwnedWriteHalf,
    child: &mut EngineChild,
    mut stdin: Option<tokio::process::ChildStdin>,
) {
    match child.try_wait() {
        Ok(Some(status)) => {
            log::info(&format!("engine already exited with {status}"));
        }
        Ok(None) => {
            if stdin.is_none() {
                stdin = child.stdin().take();
            }
            // The whole quit handshake shares QUIT_TIMEOUT: the write itself
            // must not extend the documented "quit -> 5s -> terminate" bound.
            let quit_deadline = std::time::Instant::now() + QUIT_TIMEOUT;
            if let Some(mut stdin) = stdin {
                let remaining = quit_deadline.saturating_duration_since(std::time::Instant::now());
                if !remaining.is_zero() {
                    let _ = tokio::time::timeout(remaining, async {
                        stdin.write_all(b"quit\n").await?;
                        stdin.flush().await
                    })
                    .await;
                }
                drop(stdin);
            }
            let remaining = quit_deadline.saturating_duration_since(std::time::Instant::now());
            // When the quit write consumed the whole budget, skip straight to
            // escalation instead of waiting with a zero timeout.
            let graceful: bool = if remaining.is_zero() {
                false
            } else {
                match tokio::time::timeout(remaining, child.wait()).await {
                    Ok(Ok(status)) => {
                        log::info(&format!("engine exited gracefully with {status}"));
                        true
                    }
                    _ => false,
                }
            };
            // `graceful` replaces the old match arm; escalation below handles
            // the non-graceful case uniformly.
            match graceful {
                true => {}
                false => {
                    log::warn_compat("engine did not exit after quit; escalating");
                    child.terminate_tree(true);
                    match tokio::time::timeout(TERM_TIMEOUT, child.wait()).await {
                        Ok(Ok(status)) => {
                            log::info(&format!("engine exited after terminate with {status}"));
                        }
                        _ => {
                            log::warn_compat("engine did not terminate; killing");
                            child.terminate_tree(false);
                            let _ = child.wait().await;
                        }
                    }
                }
            }
        }
        Err(e) => {
            log::warn_compat(&format!("engine wait failed during cleanup: {e}"));
        }
    }
    child.terminate_tree(false);
    let _ = writer.shutdown().await;
}
