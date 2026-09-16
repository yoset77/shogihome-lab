use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn spawn_wrapper_and_wait_listening(dir: &std::path::Path) -> String {
    let binary = dir.join(if cfg!(windows) {
        "wrapper.exe"
    } else {
        "wrapper"
    });
    std::fs::copy(env!("CARGO_BIN_EXE_shogihome-wrapper"), &binary).unwrap();
    let mut child = Command::new(binary)
        .args(["--bind-address", "127.0.0.1", "--port", "0"])
        .env_remove("WRAPPER_ACCESS_TOKEN")
        .current_dir(std::env::temp_dir())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    // The startup log reports the registry count even with an ephemeral port.
    let mut log = BufReader::new(child.stderr.take().unwrap());
    let mut line = String::new();
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        line.clear();
        if log.read_line(&mut line).unwrap() == 0 || line.contains("listening on") {
            break;
        }
    }
    child.kill().unwrap();
    child.wait().unwrap();
    line
}

#[test]
fn standalone_reads_registry_next_to_executable() {
    let dir = std::env::temp_dir().join(format!("wrapper-config-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("engines.json"), r#"[{"id":"next-to-exe"}]"#).unwrap();
    let line = spawn_wrapper_and_wait_listening(&dir);
    std::fs::remove_dir_all(dir).unwrap();
    assert!(line.contains("(1 engines,"), "{line}");
}

#[test]
fn standalone_prefers_sibling_engine_wrapper_dir() {
    // Portable ZIP layout: the executable sits next to `engine-wrapper/`,
    // so launching it without `--config-dir` (e.g. double-click) must pick
    // up the bundled registry and `.env`.
    let dir = std::env::temp_dir().join(format!("wrapper-bundled-{}", std::process::id()));
    std::fs::create_dir_all(dir.join("engine-wrapper")).unwrap();
    std::fs::write(
        dir.join("engine-wrapper").join("engines.json"),
        r#"[{"id":"bundled-marker"}]"#,
    )
    .unwrap();
    // A stray registry next to the executable must not shadow the bundle.
    std::fs::write(dir.join("engines.json"), r#"[{"id":"next-to-exe"}]"#).unwrap();
    let line = spawn_wrapper_and_wait_listening(&dir);
    std::fs::remove_dir_all(dir).unwrap();
    assert!(line.contains("(1 engines,"), "{line}");
    assert!(line.contains("engine-wrapper"), "{line}");
}
