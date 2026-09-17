//! Shutdown regression tests: every connection phase must observe listener
//! shutdown so the 10s drain deadline in `main.rs` is never the exit path.
//!
//! Intentional layering: per-phase drain here, tree kill in
//! `launcher/tests/stop_tree.rs`, FIN behavior in the wrapper contract suite.
//!
//! Unix-only: graceful shutdown needs SIGTERM (Windows `Child::kill` is an
//! uncancellable terminate), and the blocked-stdin case uses a shell script
//! engine. The relay code under test is platform-independent.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

/// Must stay below the wrapper's 10s forced-exit deadline with margin.
const GRACE: Duration = Duration::from_secs(9);

struct Wrapper {
    child: Child,
    port: u16,
    dir: PathBuf,
}

impl Drop for Wrapper {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        std::fs::remove_dir_all(&self.dir).ok();
    }
}

fn prepare_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("wrapper-shutdown-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Reserve a loopback port first: the wrapper logs its configured port, so
/// an ephemeral `--port 0` would leave the actual port undiscoverable.
fn reserve_port() -> u16 {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("loopback must bind");
    listener
        .local_addr()
        .expect("socket must have a port")
        .port()
}

fn spawn_wrapper(dir: &std::path::Path, token: Option<&str>) -> Wrapper {
    let port = reserve_port();
    let log_path = dir.join("wrapper.log");
    let log_file = std::fs::File::create(&log_path).expect("log file must be writable");
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_shogihome-wrapper"));
    cmd.args([
        "--config-dir",
        &dir.to_string_lossy(),
        "--bind-address",
        "127.0.0.1",
        "--port",
        &port.to_string(),
        "--no-env-file",
    ])
    .stderr(log_file)
    .stdout(Stdio::null())
    .env("WRAPPER_ACCESS_TOKEN", token.unwrap_or_default());
    let mut child = cmd.spawn().expect("wrapper must spawn");
    // Wait until the listener is up (the log line only confirms config).
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = child.try_wait().expect("try_wait must work") {
            let log = std::fs::read_to_string(&log_path).unwrap_or_default();
            panic!("wrapper exited early with {status}:\n{log}");
        }
        let log = std::fs::read_to_string(&log_path).unwrap_or_default();
        if log.contains("listening on") {
            break;
        }
        assert!(Instant::now() < deadline, "wrapper did not start:\n{log}");
        std::thread::sleep(Duration::from_millis(50));
    }
    Wrapper {
        child,
        port,
        dir: dir.to_path_buf(),
    }
}

fn wrapper_log(wrapper: &Wrapper) -> String {
    std::fs::read_to_string(wrapper.dir.join("wrapper.log")).unwrap_or_default()
}

fn connect(wrapper: &Wrapper) -> TcpStream {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match TcpStream::connect(("127.0.0.1", wrapper.port)) {
            Ok(stream) => return stream,
            Err(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => panic!("cannot connect to wrapper: {e}"),
        }
    }
}

fn sigterm(child: &mut Child) {
    let pid = child.id() as i32;
    // SAFETY: kill(2) with SIGTERM on our own spawned child.
    let ret = unsafe { libc::kill(pid, libc::SIGTERM) };
    assert_eq!(ret, 0, "SIGTERM must be deliverable");
}

fn wait_exit(child: &mut Child, timeout: Duration) -> ExitStatus {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait().expect("try_wait must work") {
            Some(status) => return status,
            None if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            None => panic!("wrapper did not exit within {timeout:?}"),
        }
    }
}

/// An idle connection waiting for its first command must not outlive a
/// graceful shutdown (previously it blocked the drain until exit(1)).
#[test]
fn idle_command_wait_exits_cleanly_on_shutdown() {
    let dir = prepare_dir("idle");
    std::fs::write(dir.join("engines.json"), "[]").unwrap();
    let mut wrapper = spawn_wrapper(&dir, None);
    let stream = connect(&wrapper);
    // Hold the connection open with nothing sent: the server sits in the
    // pre-spawn command wait.
    std::thread::sleep(Duration::from_millis(300));
    let started = Instant::now();
    sigterm(&mut wrapper.child);
    let status = wait_exit(&mut wrapper.child, Duration::from_secs(15));
    drop(stream);
    assert!(
        status.success(),
        "idle wait must exit 0, got {status}:\n{}",
        wrapper_log(&wrapper)
    );
    assert!(
        started.elapsed() < GRACE,
        "shutdown must beat the forced-exit deadline"
    );
}

/// A connection parked mid-handshake (nonce sent, digest never arrives)
/// must also drain on shutdown.
#[test]
fn auth_wait_exits_cleanly_on_shutdown() {
    let dir = prepare_dir("auth");
    std::fs::write(dir.join("engines.json"), "[]").unwrap();
    let mut wrapper = spawn_wrapper(&dir, Some("secret-token"));
    let stream = connect(&wrapper);
    let mut log = BufReader::new(stream.try_clone().unwrap());
    let mut challenge = String::new();
    log.read_line(&mut challenge).unwrap();
    assert!(
        challenge.starts_with("auth_cram_sha256 "),
        "expected auth challenge, got {challenge:?}"
    );
    // Never answer: the server sits in the handshake response wait.
    std::thread::sleep(Duration::from_millis(300));
    let started = Instant::now();
    sigterm(&mut wrapper.child);
    let status = wait_exit(&mut wrapper.child, Duration::from_secs(15));
    drop(stream);
    drop(log);
    assert!(
        status.success(),
        "auth wait must exit 0, got {status}:\n{}",
        wrapper_log(&wrapper)
    );
    assert!(
        started.elapsed() < GRACE,
        "shutdown must beat the forced-exit deadline"
    );
}

/// A relay blocked writing to an engine that never reads stdin must still
/// terminate on shutdown (stdin writes race shutdown since the last fix;
/// this pins the whole path including `quit`-bounded cleanup).
#[test]
fn blocked_stdin_relay_exits_cleanly_on_shutdown() {
    let dir = prepare_dir("stdin");
    // An engine that ignores stdin and stays silent: the stdin pipe fills
    // up and further relay writes block.
    let script = dir.join("sleeper.sh");
    std::fs::write(&script, "#!/bin/sh\nexec sleep 30\n").unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let engines = format!(
        r#"[{{"id":"sleeper","name":"Sleeper","path":{},"type":["research"]}}]"#,
        serde_json::to_string(&script.to_string_lossy()).unwrap()
    );
    std::fs::write(dir.join("engines.json"), engines).unwrap();
    let mut wrapper = spawn_wrapper(&dir, None);
    let mut stream = connect(&wrapper);
    stream
        .write_all(b"run sleeper\n")
        .expect("run must be accepted");
    // Flood stdin with newline-terminated lines well under the 1MiB relay
    // limit (8KiB each): the bounded reader accepts them, but the engine
    // never reads, so the 64KB pipe fills and the relay blocks inside a
    // cancellable stdin write. Newline-less floods would instead hit the
    // oversize path and never exercise backpressure.
    let mut flood = stream.try_clone().unwrap();
    let flooder = std::thread::spawn(move || {
        let mut line = vec![b'x'; 8191];
        line.push(b'\n');
        for _ in 0..1024 {
            if flood.write_all(&line).is_err() {
                break;
            }
        }
    });
    // Let the pipe fill so the relay is stuck inside a cancellable write.
    std::thread::sleep(Duration::from_secs(1));
    let started = Instant::now();
    sigterm(&mut wrapper.child);
    let status = wait_exit(&mut wrapper.child, Duration::from_secs(20));
    drop(stream);
    flooder.join().expect("flood thread must finish");
    assert!(
        status.success(),
        "blocked relay must exit 0, got {status}:\n{}",
        wrapper_log(&wrapper)
    );
    assert!(
        started.elapsed() < GRACE,
        "shutdown must beat the forced-exit deadline"
    );
}
