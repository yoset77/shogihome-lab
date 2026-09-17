//! Minimal fake USI engine for black-box wrapper contract tests.
//! Non-Python replacement for the removed tests/fixtures/fake_usi_engine.py.
//!
//! Protocol:
//! - `usi` -> `id name fake-engine`, `usiok`
//! - `isready` -> `readyok`
//! - `test_cp932` -> one raw CP932-encoded line (Japanese), then `test_cp932_ok`
//! - `test_background_exit` -> spawn a 60s sleeper (inheriting stdio),
//!   print `info string helper_pid <pid>`, write `bestmove resign`
//!   (no trailing newline; the wrapper flushes the final line), exit now
//! - `quit` -> exit promptly
//! - anything else starting with `setoption` is recorded; other lines are ignored.
//!
//! Every received stdin line is appended to the file named by FAKE_ENGINE_LOG
//! (when set), so tests can assert option injection ordering.
//!
//! `--sleep-helper` runs the 60s sleeper child (not a USI engine).

use std::env;
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::process::Command;
use std::time::Duration;

// "info string こんにちは\n" encoded in CP932.
const CP932_LINE: &[u8] = &[
    105, 110, 102, 111, 32, 115, 116, 114, 105, 110, 103, 32, 130, 177, 130, 241, 130, 201, 130,
    191, 130, 205, 10,
];

fn log_line(path: Option<&str>, line: &str) {
    if let Some(path) = path {
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(file, "{line}");
        }
    }
}

fn main() {
    if env::args().any(|arg| arg == "--sleep-helper") {
        std::thread::sleep(Duration::from_secs(60));
        return;
    }
    let log_path = env::var("FAKE_ENGINE_LOG").ok();
    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    for raw in BufReader::new(stdin.lock()).lines() {
        let line = match raw {
            Ok(line) => line,
            Err(_) => break,
        };
        let line = line.trim();
        log_line(log_path.as_deref(), line);
        match line {
            "usi" => {
                out.write_all(b"id name fake-engine\nusiok\n").unwrap();
                out.flush().unwrap();
            }
            "isready" => {
                out.write_all(b"readyok\n").unwrap();
                out.flush().unwrap();
            }
            "test_cp932" => {
                // Emit raw CP932 bytes, bypassing any stdout encoding layer.
                out.write_all(CP932_LINE).unwrap();
                out.flush().unwrap();
                out.write_all(b"test_cp932_ok\n").unwrap();
                out.flush().unwrap();
            }
            "test_background_exit" => {
                // The helper must outlive this process: it inherits the stdio
                // pipes so the wrapper's cleanup path is exercised. The parent
                // exits immediately (reparenting the helper) and the contract
                // test kills it, so never waiting here is intentional.
                #[allow(clippy::zombie_processes)]
                let helper = Command::new(env::current_exe().unwrap())
                    .arg("--sleep-helper")
                    .spawn()
                    .unwrap();
                writeln!(out, "info string helper_pid {}", helper.id()).unwrap();
                out.write_all(b"bestmove resign").unwrap();
                out.flush().unwrap();
                return;
            }
            "quit" => return,
            _ => {}
        }
    }
}
