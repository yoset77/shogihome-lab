//! End-to-end tree stop: a fake wrapper owns a fake engine in its own
//! process group (mirroring `spawn_async_engine`'s `setsid`), plus a helper
//! sharing the engine's group. `stop_all` must deliver SIGTERM so the
//! wrapper runs session cleanup, and afterwards neither the engine nor the
//! helper may survive — an immediate SIGKILL of the wrapper alone would
//! orphan both.
//!
//! Unix-only; `python3` is available on all desktop CI runners.

#![cfg(unix)]

use shogihome_launcher::service::{self, ServiceSpec};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const ENGINE_PY: &str = r#"
import pathlib, signal, subprocess, sys, time
d = pathlib.Path(sys.argv[1])
helper = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
(d / "helper.pid").write_text(str(helper.pid))

def on_term(*a):
    sys.exit(0)

signal.signal(signal.SIGTERM, on_term)
(d / "engine-ready").touch()
try:
    helper.wait()
except Exception:
    pass
"#;

const WRAPPER_PY: &str = r#"
import os, pathlib, signal, subprocess, sys, time
d = pathlib.Path(sys.argv[1])
engine = subprocess.Popen(
    [sys.executable, str(d / "engine.py"), str(d)], start_new_session=True
)
(d / "engine.pid").write_text(str(engine.pid))

def on_term(*a):
    # Mimic wrapper session cleanup: graceful engine-tree stop, then force.
    try:
        os.kill(-engine.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    time.sleep(2)
    try:
        os.kill(-engine.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        engine.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass
    sys.exit(0)

signal.signal(signal.SIGTERM, on_term)
(d / "ready").touch()
while True:
    time.sleep(1)
"#;

fn wait_for(path: &Path, what: &str) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !path.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(path.exists(), "{what} must appear before stop");
}

fn read_pid(path: &Path) -> i32 {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .trim()
        .parse()
        .expect("pid file must hold a PID")
}

fn is_alive(pid: i32) -> bool {
    // kill(pid, 0) probes existence without signalling.
    unsafe { libc::kill(pid, 0) == 0 }
}

fn wait_gone(pid: i32, what: &str) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while is_alive(pid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!is_alive(pid), "{what} (pid {pid}) must be gone after stop");
}

#[test]
fn stop_all_reaps_wrapper_engine_and_helper() {
    let dir: PathBuf = std::env::temp_dir().join(format!("svc-tree-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("engine.py"), ENGINE_PY).unwrap();
    std::fs::write(dir.join("wrapper.py"), WRAPPER_PY).unwrap();

    let spec = ServiceSpec {
        name: "fake-wrapper".to_string(),
        program: PathBuf::from("python3"),
        args: vec![
            str::to_string("wrapper.py"),
            dir.to_string_lossy().into_owned(),
        ],
        cwd: dir.clone(),
        env: vec![],
        inherit_env: true,
    };
    let log_dir = dir.join("logs");
    let svc = service::spawn_service(&spec, &log_dir).unwrap();
    let mut map = HashMap::from([(svc.name.clone(), svc)]);

    wait_for(&dir.join("ready"), "wrapper readiness");
    wait_for(&dir.join("engine-ready"), "engine readiness");
    let engine_pid = read_pid(&dir.join("engine.pid"));
    let helper_pid = read_pid(&dir.join("helper.pid"));
    assert!(is_alive(engine_pid), "engine must run before stop");
    assert!(is_alive(helper_pid), "helper must run before stop");

    service::stop_all_with_timeout(&mut map, Duration::from_secs(15));
    assert!(map.is_empty());
    wait_gone(engine_pid, "engine");
    wait_gone(helper_pid, "helper");
    std::fs::remove_dir_all(&dir).ok();
}
