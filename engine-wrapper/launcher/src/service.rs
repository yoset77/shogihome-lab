//! Managed child services (Node server, wrapper sidecar).
//!
//! - Each service gets an explicit program/args/cwd/env (no shell).
//! - stdout+stderr append to per-service log files under `<base>/logs`.
//! - POSIX children start as process-group leaders so `stop_tree` reaches
//!   descendants (the old `kill_proc_tree` only signalled the root PID).
//!   Engines spawned by the wrapper form their own groups, so `stop_all`
//!   SIGTERMs first (wrapper session cleanup) and only then SIGKILLs.
//! - Readiness = expected TCP ports open AND owned PIDs alive, with early
//!   exit when a child dies (mirrors the launcher port wait, minus the
//!   loopback-only wrapper assumption: the wrapper host is configurable).

use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::error::LauncherError;

/// How long startup waits for all services to become ready.
pub const READY_TIMEOUT: Duration = Duration::from_secs(10);

/// Wrapper `.env` keys forwarded to the supervised wrapper process. The
/// wrapper's `.env` file is wrapper configuration only: anything outside
/// this list is ignored and never reaches engines (matching standalone
/// `shogihome-wrapper`, which resolves the same three keys). Engines inherit
/// the OS/launcher environment (PATH, system GPU/library setup), not
/// wrapper config extras.
pub const WRAPPER_ENV_FORWARD: &[&str] = &["BIND_ADDRESS", "LISTEN_PORT", "WRAPPER_ACCESS_TOKEN"];
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

pub struct ServicePlan {
    pub specs: Vec<ServiceSpec>,
    pub expectations: HashMap<String, ReadyExpectation>,
    pub log_dir: PathBuf,
}

/// Build one configuration snapshot for both spawning and readiness checks.
pub fn portable_services(root: &Path) -> Result<ServicePlan, LauncherError> {
    use crate::env_codec::{parse_env, read_env_file};
    if crate::migration::MigrationPaths::new(root)
        .pending_source()
        .is_some()
    {
        return Err(LauncherError::msg(
            "finish the pending migration before starting services",
        ));
    }
    let paths = crate::paths::PortablePaths::new(root)?;
    let server_dir = paths.server_dir();
    let wrapper_dir = paths.config_dir();
    let mut specs = Vec::new();
    let mut expectations = HashMap::new();
    for (name, cwd, program, args, port_key, default_port, default_host) in [
        (
            "server",
            server_dir.clone(),
            paths.server_program(),
            vec![server_dir
                .join("dist/server/server.js")
                .to_string_lossy()
                .into_owned()],
            "PORT",
            "8140",
            "0.0.0.0",
        ),
        (
            "wrapper",
            wrapper_dir.clone(),
            paths.wrapper_program(),
            vec![
                "--config-dir".into(),
                wrapper_dir.to_string_lossy().into_owned(),
                // The launcher owns the resolved snapshot (file values are
                // already merged into `env` below); the wrapper must not
                // re-read the file and drift from the readiness check.
                "--no-env-file".into(),
            ],
            "LISTEN_PORT",
            "4082",
            "127.0.0.1",
        ),
    ] {
        let env = parse_env(
            &read_env_file(&cwd.join(".env"))
                .map_err(|e| LauncherError::io(format!("reading {}", cwd.display()), e))?,
        );
        let value = |key: &str, default: &str| {
            env.get(key)
                .cloned()
                .or_else(|| std::env::var(key).ok())
                .unwrap_or_else(|| default.to_string())
        };
        let bind = value("BIND_ADDRESS", default_host);
        let host = match bind.as_str() {
            "0.0.0.0" => "127.0.0.1".into(),
            "::" => "::1".into(),
            _ => bind,
        };
        let port = value(port_key, default_port)
            .parse::<u16>()
            .map_err(|e| LauncherError::msg(format!("invalid {port_key}: {e}")))?;
        expectations.insert(name.to_string(), ReadyExpectation { host, port });
        // The wrapper only forwards its three known keys so standalone and
        // supervised launches observe the same engine environment. The
        // server keeps its full snapshot (it consumes many keys itself).
        let snapshot: Vec<(String, String)> = if name == "wrapper" {
            env.into_iter()
                .filter(|(k, _)| WRAPPER_ENV_FORWARD.contains(&k.as_str()))
                .collect()
        } else {
            env.into_iter().collect()
        };
        specs.push(ServiceSpec {
            name: name.into(),
            program,
            args,
            cwd,
            env: snapshot,
            inherit_env: true,
        });
    }
    Ok(ServicePlan {
        specs,
        expectations,
        log_dir: paths.log_dir(),
    })
}

#[derive(Debug)]
pub struct RunningService {
    pub name: String,
    pub child: crate::process::ManagedChild,
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

    let mut child = crate::process::spawn(cmd)?;
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
    wait_ready_until(services, expectations, timeout, || false)
}

pub fn wait_ready_until(
    services: &mut HashMap<String, RunningService>,
    expectations: &HashMap<String, ReadyExpectation>,
    timeout: Duration,
    cancelled: impl Fn() -> bool,
) -> Result<(), Vec<String>> {
    let deadline = Instant::now() + timeout;
    let probe = Duration::from_millis(200);
    loop {
        if cancelled() {
            return Err(expectations.keys().cloned().collect());
        }
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

/// How long graceful stop waits after SIGTERM before escalating to SIGKILL.
/// Normal exits return early; the full wait only applies to stuck children.
/// Must cover the wrapper's session drain (its own 10s shutdown deadline).
pub const STOP_GRACEFUL_TIMEOUT: Duration = Duration::from_secs(12);

/// Stop every service gracefully, then force-kill survivors and reap.
///
/// SIGTERM first so the wrapper runs its session cleanup (`quit` → engine
/// tree SIGTERM/SIGKILL) and reaps grandchildren in their own process
/// groups; an immediate SIGKILL would skip that handler and orphan engines.
/// Survivors past the timeout are SIGKILLed and reaped as before.
pub fn stop_all(services: &mut HashMap<String, RunningService>) {
    stop_all_with_timeout(services, STOP_GRACEFUL_TIMEOUT);
}

pub fn stop_all_with_timeout(services: &mut HashMap<String, RunningService>, timeout: Duration) {
    for svc in services.values_mut() {
        let _ = svc.child.terminate_tree(true);
    }
    let deadline = Instant::now() + timeout;
    let probe = Duration::from_millis(50);
    for svc in services.values_mut() {
        while svc.child.try_wait().map(|s| s.is_none()).unwrap_or(false) {
            if Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(probe);
        }
        // Escalate anything still alive, then reap below.
        if svc.child.try_wait().map(|s| s.is_none()).unwrap_or(false) {
            let _ = svc.child.kill();
        }
    }
    for (_, mut svc) in services.drain() {
        let _ = svc.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_spec(name: &str, dir: &Path) -> ServiceSpec {
        // Python is available on all desktop CI runners, unlike POSIX sleep.
        ServiceSpec {
            name: name.to_string(),
            program: PathBuf::from(if cfg!(windows) { "python" } else { "python3" }),
            args: vec!["-c".into(), "import time; time.sleep(30)".into()],
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
        svc.child.kill().unwrap();
        let status = svc.child.wait().unwrap();
        assert!(!status.success());
        std::fs::remove_dir_all(&log_dir).ok();
    }

    #[test]
    fn wait_ready_reports_dead_child() {
        let dir = std::env::temp_dir();
        let log_dir = dir.join(format!("svc-dead-{}", std::process::id()));
        let mut spec = test_spec("short", &dir);
        spec.args = vec!["-c".into(), "pass".into()];
        // The child exits immediately; spawn may catch it at exec check or here.
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

    #[cfg(unix)]
    #[test]
    fn stop_all_delivers_sigterm_before_sigkill() {
        // A service that traps SIGTERM must observe it: immediate SIGKILL
        // (the old behavior) would never run the handler.
        let dir = std::env::temp_dir().join(format!("svc-term-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("got-sigterm");
        let ready = dir.join("ready");
        let mut spec = test_spec("trap", &dir);
        spec.args = vec![
            "-c".into(),
            format!(
                "import signal,time,pathlib;signal.signal(signal.SIGTERM,lambda *a:(pathlib.Path({:?}).touch(),exit(0)));pathlib.Path({:?}).touch();time.sleep(30)",
                marker.to_string_lossy().into_owned(),
                ready.to_string_lossy().into_owned(),
            ),
        ];
        // Readiness is signalled after the SIGTERM handler is installed, so
        // the stop below cannot land in the pre-handler window.
        let log_dir = dir.join("logs");
        let svc = spawn_service(&spec, &log_dir).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !ready.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(ready.exists(), "child must start before stop");
        let mut map = HashMap::from([(svc.name.clone(), svc)]);
        stop_all_with_timeout(&mut map, Duration::from_secs(10));
        assert!(map.is_empty());
        assert!(marker.exists(), "SIGTERM handler must have run before exit");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn stop_all_force_kills_sigterm_ignorers() {
        let dir = std::env::temp_dir().join(format!("svc-ign-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let ready = dir.join("ready");
        let log_dir = dir.join("logs");
        let mut spec = test_spec("ignore", &dir);
        spec.args = vec![
            "-c".into(),
            format!(
                "import signal,time,pathlib;signal.signal(signal.SIGTERM,signal.SIG_IGN);pathlib.Path({:?}).touch();time.sleep(30)",
                ready.to_string_lossy().into_owned(),
            ),
        ];
        let svc = spawn_service(&spec, &log_dir).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !ready.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(ready.exists(), "child must ignore SIGTERM before stop");
        let mut map = HashMap::from([(svc.name.clone(), svc)]);
        // Short timeout keeps the test fast; escalation must still reap.
        // Duration bounds prove the escalation path: near-instant return
        // would mean no graceful wait, while ~30s would mean waiting out
        // the natural exit instead of SIGKILLing.
        let timeout = Duration::from_millis(500);
        let start = Instant::now();
        stop_all_with_timeout(&mut map, timeout);
        let elapsed = start.elapsed();
        assert!(map.is_empty());
        assert!(
            elapsed >= timeout - Duration::from_millis(100),
            "must wait out the graceful period before escalating, took {elapsed:?}"
        );
        assert!(
            elapsed < Duration::from_secs(20),
            "must escalate to SIGKILL instead of awaiting natural exit, took {elapsed:?}"
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
