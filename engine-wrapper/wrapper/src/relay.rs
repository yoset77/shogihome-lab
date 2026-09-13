//! Per-connection TCP relay between the server and one engine process.
//!
//! Protocol (see `docs/rust-rewrite/phase-0-compat.md`):
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
use tokio::process::Child;
use tokio::sync::watch;

use crate::auth;
use crate::config::{find_engine, format_option, load_engines, log, resolve_engine_path};
use crate::encoding::{decode_line, MAX_LINE_BYTES};
use crate::process::{is_not_found, spawn_engine, terminate_tree};

const QUIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
const TERM_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// Shared per-listener state cloned into each connection task.
#[derive(Clone)]
pub struct RelayContext {
    pub config_dir: Arc<Path>,
    pub access_token: Option<Arc<str>>,
    pub shutdown: watch::Receiver<bool>,
}

/// Serve one client connection until close. Owns the engine child (if any)
/// and runs exactly one cleanup at the end.
pub async fn handle_connection(stream: TcpStream, ctx: RelayContext) {
    let (read_half, write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half);
    let mut writer = write_half;

    if let Some(token) = ctx.access_token.clone() {
        if !handshake(&mut reader, &mut writer, &token).await {
            return;
        }
    }

    let command = match read_line(&mut reader).await {
        Some(line) => line,
        None => return, // EOF before command (e.g. health check).
    };

    if command == "list" {
        let engines = load_engines(&ctx.config_dir);
        let body = serde_json::to_string(&engines).unwrap_or_else(|_| "[]".to_string());
        let _ = writer.write_all(body.as_bytes()).await;
        let _ = writer.write_all(b"\n").await;
        let _ = writer.flush().await;
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
        )
        .await;
        return;
    };

    let engines = load_engines(&ctx.config_dir);
    let Some(def) = find_engine(&engines, &engine_id) else {
        write_error(
            &mut writer,
            &format!("WRAPPER_ERROR: Engine ID '{engine_id}' not found."),
        )
        .await;
        return;
    };
    let Some(path_str) = def.get("path").and_then(|v| v.as_str()) else {
        write_error(
            &mut writer,
            "WRAPPER_ERROR: Engine path configuration error.",
        )
        .await;
        return;
    };
    let Some((engine_path, engine_dir)) = resolve_engine_path(&ctx.config_dir, path_str) else {
        write_error(
            &mut writer,
            "WRAPPER_ERROR: Engine path configuration error.",
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
            write_error(&mut writer, msg).await;
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
async fn handshake(
    reader: &mut BufReader<OwnedReadHalf>,
    writer: &mut OwnedWriteHalf,
    token: &str,
) -> bool {
    let nonce = auth::generate_nonce();
    if writer
        .write_all(format!("auth_cram_sha256 {nonce}\n").as_bytes())
        .await
        .is_err()
    {
        return false;
    }
    if writer.flush().await.is_err() {
        return false;
    }
    let line = match read_line(reader).await {
        Some(line) => line,
        None => return false,
    };
    if let Some(digest) = line.strip_prefix("auth ") {
        if auth::verify_digest(token, &nonce, digest.trim()) {
            return writer.write_all(b"auth_ok\n").await.is_ok() && writer.flush().await.is_ok();
        }
        log::warn_compat("authentication failed");
        write_error(writer, "WRAPPER_ERROR: Authentication failed").await;
        return false;
    }
    log::warn_compat("unexpected command during auth");
    write_error(writer, "WRAPPER_ERROR: Authentication required").await;
    false
}

/// Read one `\n`-terminated line, returning the trimmed text.
/// `None` on EOF (no bytes) or read error. Buffered bytes stay in `reader`.
async fn read_line(reader: &mut BufReader<OwnedReadHalf>) -> Option<String> {
    let mut buf = Vec::new();
    match reader.read_until(b'\n', &mut buf).await {
        Ok(0) => None,
        Ok(_) => {
            if buf.len() > MAX_LINE_BYTES {
                return None;
            }
            let text = String::from_utf8_lossy(&buf);
            Some(text.trim_end_matches(['\r', '\n']).to_string())
        }
        Err(_) => None,
    }
}

async fn write_error(writer: &mut OwnedWriteHalf, msg: &str) {
    let _ = writer.write_all(msg.as_bytes()).await;
    let _ = writer.write_all(b"\n").await;
    let _ = writer.flush().await;
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
    child: &mut Child,
    option_lines: Vec<String>,
    ctx: &RelayContext,
) -> Option<tokio::process::ChildStdin> {
    let mut stdin = child.stdin.take();
    let mut stdout: Option<Box<dyn AsyncRead + Unpin + Send>> =
        child.stdout.take().map(|p| Box::new(p) as _);
    let mut stderr: Option<Box<dyn AsyncRead + Unpin + Send>> =
        child.stderr.take().map(|p| Box::new(p) as _);
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
                // Drain any terminal output before closing, so a final
                // bestmove is never lost to a cancelled relay task.
                if let Some(out) = stdout.as_mut() {
                    drain_stream(out, &mut obuf, writer).await;
                }
                if let Some(err) = stderr.as_mut() {
                    drain_stream(err, &mut ebuf, writer).await;
                }
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
                            for line in &option_lines {
                                if stdin.write_all(line.as_bytes()).await.is_err()
                                    || stdin.write_all(b"\n").await.is_err()
                                {
                                    break;
                                }
                            }
                            options_applied = true;
                        }
                        if stdin.write_all(command.as_bytes()).await.is_err()
                            || stdin.write_all(b"\n").await.is_err()
                        {
                            break;
                        }
                        let _ = stdin.flush().await;
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
                        flush_remainder(&mut obuf, writer).await;
                    }
                    Ok(n) => forward_bytes(&otmp[..n], &mut obuf, writer).await,
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
                        flush_remainder(&mut ebuf, writer).await;
                    }
                    Ok(n) => forward_bytes(&etmp[..n], &mut ebuf, writer).await,
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

/// Append `chunk` to the pending buffer and forward complete lines.
async fn forward_bytes(chunk: &[u8], pending: &mut Vec<u8>, writer: &mut OwnedWriteHalf) {
    if pending.len() + chunk.len() > MAX_LINE_BYTES * 2 {
        return; // Shed overload instead of growing without bound.
    }
    pending.extend_from_slice(chunk);
    while let Some(pos) = pending.iter().position(|&b| b == b'\n') {
        let line: Vec<u8> = pending.drain(..=pos).collect();
        let text = decode_line(trim_newline(&line));
        let _ = writer.write_all(text.as_bytes()).await;
        let _ = writer.write_all(b"\n").await;
    }
    let _ = writer.flush().await;
}

/// Forward an unterminated trailing line (Node parity: flush on EOF).
async fn flush_remainder(pending: &mut Vec<u8>, writer: &mut OwnedWriteHalf) {
    if pending.is_empty() {
        return;
    }
    let rest: Vec<u8> = std::mem::take(pending);
    let text = decode_line(trim_newline(&rest));
    let _ = writer.write_all(text.as_bytes()).await;
    let _ = writer.write_all(b"\n").await;
    let _ = writer.flush().await;
}

fn trim_newline(line: &[u8]) -> &[u8] {
    let mut end = line.len();
    while end > 0 && (line[end - 1] == b'\n' || line[end - 1] == b'\r') {
        end -= 1;
    }
    &line[..end]
}

/// Read a pipe to EOF, forwarding everything (used after engine exit).
async fn drain_stream(
    pipe: &mut (dyn AsyncRead + Unpin + Send),
    pending: &mut Vec<u8>,
    writer: &mut OwnedWriteHalf,
) {
    let mut tmp = vec![0u8; 8192];
    loop {
        match pipe.read(&mut tmp).await {
            Ok(0) => break,
            Ok(n) => forward_bytes(&tmp[..n], pending, writer).await,
            Err(_) => break,
        }
    }
    flush_remainder(pending, writer).await;
}

/// Idempotent end-of-session cleanup: `quit` -> 5s -> tree SIGTERM/taskkill
/// -> 3s -> tree SIGKILL, then close the client socket. Already-exited
/// engines skip escalation; every child is reaped with `wait()`.
async fn cleanup(
    writer: &mut OwnedWriteHalf,
    child: &mut Child,
    mut stdin: Option<tokio::process::ChildStdin>,
) {
    let pid = child.id();
    match child.try_wait() {
        Ok(Some(status)) => {
            log::info(&format!("engine already exited with {status}"));
        }
        Ok(None) => {
            if stdin.is_none() {
                stdin = child.stdin.take();
            }
            if let Some(mut stdin) = stdin {
                let _ = stdin.write_all(b"quit\n").await;
                let _ = stdin.flush().await;
                drop(stdin);
            }
            match tokio::time::timeout(QUIT_TIMEOUT, child.wait()).await {
                Ok(Ok(status)) => {
                    log::info(&format!("engine exited gracefully with {status}"));
                }
                _ => {
                    log::warn_compat("engine did not exit after quit; escalating");
                    if let Some(pid) = pid {
                        terminate_tree(pid, true);
                    }
                    match tokio::time::timeout(TERM_TIMEOUT, child.wait()).await {
                        Ok(Ok(status)) => {
                            log::info(&format!("engine exited after terminate with {status}"));
                        }
                        _ => {
                            log::warn_compat("engine did not terminate; killing");
                            if let Some(pid) = pid {
                                terminate_tree(pid, false);
                            }
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
    // The leader is reaped above, but backgrounded grandchildren (e.g. a
    // shell launcher whose `sleep` outlives the shell's stdin EOF) stay in
    // the process group. Sweep the group like the Node wrapper does on
    // engine close, so normal `quit`-then-EOF exits cannot leak strays.
    // (Windows `taskkill /T` cannot resolve a tree from a dead PID; full
    // containment there needs a Job Object in the launcher.)
    if let Some(pid) = pid {
        terminate_tree(pid, false);
    }
    let _ = writer.shutdown().await;
}
