use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[test]
fn standalone_reads_registry_next_to_executable() {
    let dir = std::env::temp_dir().join(format!("wrapper-config-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let binary = dir.join(if cfg!(windows) {
        "wrapper.exe"
    } else {
        "wrapper"
    });
    std::fs::copy(env!("CARGO_BIN_EXE_shogihome-wrapper"), &binary).unwrap();
    std::fs::write(dir.join("engines.json"), r#"[{"id":"next-to-exe"}]"#).unwrap();
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
    std::fs::remove_dir_all(dir).unwrap();
    assert!(line.contains("(1 engines,"), "{line}");
}
