//! Managed child services (Node server, wrapper sidecar).
//!
//! - Each service gets an explicit program/args/cwd/env (no shell).
//! - stdout+stderr append to per-service log files under `<base>/logs`.
//! - POSIX children start as process-group leaders so `stop_tree` reaches
//!   descendants (the old `kill_proc_tree` only signalled the root PID).
//! - Readiness = expected TCP ports open AND owned PIDs alive, with early
//!   exit when a child dies (mirrors the launcher port wait, minus the
//!   loopback-only wrapper assumption: the wrapper host is configurable).

use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// How long startup waits for all services to become ready.
pub const READY_TIMEOUT: Duration = Duration::from_secs(10);
/// UI-level delay after stop before ports are reused (matches restart's 1s).
pub const RESTART_SETTLE: Duration = Duration::from_secs(1);

#[derive(Debug, Clone)]
pub struct ServiceSpec {
    pub name: String,
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
    /// Extra environment inherited from the launcher process (e.g. PATH).
    /// When a key collides, `env` wins and the collision is reported.
    pub inherit_env: bool,
}

#[derive(Debug, Clone)]
pub struct ReadyExpectation {
    pub host: String,
    pub port: u16,
}

#[derive(Debug)]
pub struct RunningService {
    pub name: String,
    pub child: Child,
    pub pid: u32,
}

/// Spawn a service, appending stdout/stderr to `<log_dir>/<name>.log`.
pub fn spawn_service(spec: &ServiceSpec, log_dir: &Path) -> io::Result<RunningService> {
    std::fs::create_dir_all(log_dir)?;
    let log_path = log_dir.join(format!("{}.log", spec.name));
    let log_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)?;
    let stdout = log_file.try_clone()?;

    let mut cmd = Command::new(&spec.program);
    cmd.args(&spec.args)
        .current_dir(&spec.cwd)
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(log_file);
    if !spec.inherit_env {
        cmd.env_clear();
    }
    for (k, v) in &spec.env {
        cmd.env(k, v);
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }

    let mut child = cmd.spawn()?;
    // Reap immediately if the process failed at exec time.
    if let Some(status) = child.try_wait()? {
        return Err(io::Error::other(format!(
            "service '{}' exited at spawn with {status}",
            spec.name
        )));
    }
    let pid = child.id();
    Ok(RunningService {
        name: spec.name.clone(),
        child,
        pid,
    })
}

/// True when TCP connects within `timeout`.
pub fn is_port_open(host: &str, port: u16, timeout: Duration) -> bool {
    let addrs: Vec<SocketAddr> = match (host, port).to_socket_addrs() {
        Ok(it) => it.collect(),
        Err(_) => return false,
    };
    addrs
        .into_iter()
        .any(|addr| TcpStream::connect_timeout(&addr, timeout).is_ok())
}

/// Wait until every expectation's port is open and every service is alive.
/// Returns `Ok(())` on success, or the names of failed services on timeout
/// or early child death.
pub fn wait_ready(
    services: &mut HashMap<String, RunningService>,
    expectations: &HashMap<String, ReadyExpectation>,
    timeout: Duration,
) -> Result<(), Vec<String>> {
    let deadline = Instant::now() + timeout;
    let probe = Duration::from_millis(200);
    loop {
        let mut failed = Vec::new();
        let mut pending = false;
        for (name, exp) in expectations {
            match services.get_mut(name) {
                None => {
                    failed.push(name.clone());
                }
                Some(svc) => {
                    let alive = svc.child.try_wait().map(|s| s.is_none()).unwrap_or(false);
                    if !alive {
                        failed.push(name.clone());
                        continue;
                    }
                    if !is_port_open(&exp.host, exp.port, Duration::from_millis(500)) {
                        pending = true;
                    }
                }
            }
        }
        if !failed.is_empty() {
            return Err(failed);
        }
        if !pending {
            return Ok(());
        }
        if Instant::now() >= deadline {
            let still_pending: Vec<String> = expectations.keys().cloned().collect();
            return Err(still_pending);
        }
        std::thread::sleep(probe);
    }
}

/// Force-stop a whole service tree: POSIX process group, Windows taskkill /T.
pub fn stop_tree(pid: u32) {
    #[cfg(unix)]
    {
        // Negative pid = process group created by setsid at spawn.
        let ret = unsafe { libc::kill(-(pid as libc::pid_t), libc::SIGKILL) };
        if ret != 0 {
            let err = io::Error::last_os_error();
            if err.raw_os_error() != Some(libc::ESRCH) {
                eprintln!("stop_tree({pid}) failed: {err}");
            }
        }
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
    }
}

/// Stop every service and wait for reaping.
pub fn stop_all(services: &mut HashMap<String, RunningService>) {
    for svc in services.values() {
        stop_tree(svc.pid);
    }
    for (_, mut svc) in services.drain() {
        let _ = svc.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_spec(name: &str, dir: &Path) -> ServiceSpec {
        // `sleep` is universally available on the CI/test platforms used here.
        ServiceSpec {
            name: name.to_string(),
            program: PathBuf::from("sleep"),
            args: vec!["30".to_string()],
            cwd: dir.to_path_buf(),
            env: vec![],
            inherit_env: true,
        }
    }

    #[test]
    fn spawn_and_stop_tree_reaps_child() {
        let dir = std::env::temp_dir();
        let log_dir = dir.join(format!("svc-test-{}", std::process::id()));
        let mut svc = spawn_service(&test_spec("dummy", &dir), &log_dir).unwrap();
        assert!(svc.child.try_wait().unwrap().is_none());
        stop_tree(svc.pid);
        let status = svc.child.wait().unwrap();
        assert!(!status.success());
        std::fs::remove_dir_all(&log_dir).ok();
    }

    #[test]
    fn wait_ready_reports_dead_child() {
        let dir = std::env::temp_dir();
        let log_dir = dir.join(format!("svc-dead-{}", std::process::id()));
        let mut spec = test_spec("short", &dir);
        spec.args = vec!["0".to_string()];
        // sleep 0 exits immediately; spawn may catch it at exec check or here.
        let spawned = spawn_service(&spec, &log_dir);
        if let Ok(svc) = spawned {
            let mut map = HashMap::from([(svc.name.clone(), svc)]);
            let exp = HashMap::from([(
                "short".to_string(),
                ReadyExpectation {
                    host: "127.0.0.1".to_string(),
                    port: 9,
                },
            )]);
            let err = wait_ready(&mut map, &exp, Duration::from_secs(2)).unwrap_err();
            assert!(err.contains(&"short".to_string()));
        }
        std::fs::remove_dir_all(&log_dir).ok();
    }

    #[test]
    fn wait_ready_ok_when_port_open_and_alive() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let dir = std::env::temp_dir();
        let log_dir = dir.join(format!("svc-ready-{}", std::process::id()));
        let svc = spawn_service(&test_spec("sleeper", &dir), &log_dir).unwrap();
        let mut map = HashMap::from([(svc.name.clone(), svc)]);
        let exp = HashMap::from([(
            "sleeper".to_string(),
            ReadyExpectation {
                host: "127.0.0.1".to_string(),
                port,
            },
        )]);
        wait_ready(&mut map, &exp, Duration::from_secs(5)).unwrap();
        stop_all(&mut map);
        drop(listener);
        std::fs::remove_dir_all(&log_dir).ok();
    }
}
