//! Serialized service operations with nonblocking status snapshots.
//! Tauri runs these blocking operations off its event loop. The operation
//! lock also excludes migration from startup and restart.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use crate::service::{self, RunningService, ServicePlan};
use crate::supervisor::{StatusSnapshot, Supervisor, SupervisorRequest, SupervisorState};

pub struct Controller {
    operation: Mutex<()>,
    supervisor: Mutex<Supervisor>,
    services: Mutex<HashMap<String, RunningService>>,
    quitting: AtomicBool,
}

impl Controller {
    pub fn new(names: &[&str]) -> Self {
        Self {
            operation: Mutex::new(()),
            supervisor: Mutex::new(Supervisor::new(names)),
            services: Mutex::new(HashMap::new()),
            quitting: AtomicBool::new(false),
        }
    }

    pub fn status(&self) -> StatusSnapshot {
        self.supervisor.lock().unwrap().snapshot()
    }

    pub fn start(&self, plan: impl FnOnce() -> Result<ServicePlan, String>) -> Result<u64, String> {
        let _operation = self.operation.lock().unwrap();
        self.start_inner(plan)
    }

    fn start_inner(
        &self,
        plan: impl FnOnce() -> Result<ServicePlan, String>,
    ) -> Result<u64, String> {
        if self.quitting.load(Ordering::SeqCst) {
            return Err("launcher is quitting".into());
        }
        let generation = self
            .supervisor
            .lock()
            .unwrap()
            .request(SupervisorRequest::Start)
            .ok_or("already running")?;
        let result = (|| {
            let plan = plan()?;
            crate::logs::rotate_logs(&plan.log_dir)?;
            let mut services = self.services.lock().unwrap();
            for spec in &plan.specs {
                if self.quitting.load(Ordering::SeqCst) {
                    return Err("startup cancelled".into());
                }
                match service::spawn_service(spec, &plan.log_dir) {
                    Ok(child) => {
                        services.insert(spec.name.clone(), child);
                    }
                    Err(error) => {
                        self.supervisor
                            .lock()
                            .unwrap()
                            .service_failed(generation, &spec.name);
                        return Err(format!("{}: {error}", spec.name));
                    }
                }
            }
            match service::wait_ready_until(
                &mut services,
                &plan.expectations,
                service::READY_TIMEOUT,
                || self.quitting.load(Ordering::SeqCst),
            ) {
                Ok(()) => {
                    let mut supervisor = self.supervisor.lock().unwrap();
                    for name in services.keys() {
                        supervisor.service_ready(generation, name);
                    }
                    Ok(())
                }
                Err(failed) => {
                    let mut supervisor = self.supervisor.lock().unwrap();
                    for name in &failed {
                        supervisor.service_failed(generation, name);
                    }
                    Err(format!("services not ready: {}", failed.join(", ")))
                }
            }
        })();
        if result.is_err() {
            service::stop_all(&mut self.services.lock().unwrap());
        }
        self.supervisor
            .lock()
            .unwrap()
            .complete(generation, result.is_ok());
        result.map(|()| generation)
    }

    pub fn stop(&self) -> Result<(), String> {
        let _operation = self.operation.lock().unwrap();
        self.stop_inner()
    }

    fn stop_inner(&self) -> Result<(), String> {
        if self.status().state == SupervisorState::Stopped {
            return Ok(());
        }
        let generation = self
            .supervisor
            .lock()
            .unwrap()
            .request(SupervisorRequest::Stop)
            .ok_or("cannot stop")?;
        service::stop_all(&mut self.services.lock().unwrap());
        self.supervisor.lock().unwrap().complete(generation, true);
        Ok(())
    }

    pub fn restart(
        &self,
        plan: impl FnOnce() -> Result<ServicePlan, String>,
    ) -> Result<u64, String> {
        let _operation = self.operation.lock().unwrap();
        self.stop_inner()?;
        std::thread::sleep(service::RESTART_SETTLE);
        self.start_inner(plan)
    }

    pub fn quit(&self) {
        self.quitting.store(true, Ordering::SeqCst);
        let _operation = self.operation.lock().unwrap();
        let generation = self
            .supervisor
            .lock()
            .unwrap()
            .request(SupervisorRequest::Quit);
        service::stop_all(&mut self.services.lock().unwrap());
        if let Some(generation) = generation {
            self.supervisor.lock().unwrap().complete(generation, true);
        }
    }

    /// Poll on a background timer; never wait behind startup or shutdown.
    pub fn check_health(&self) {
        let Ok(_operation) = self.operation.try_lock() else {
            return;
        };
        if self.status().state != SupervisorState::Running {
            return;
        }
        let mut services = self.services.lock().unwrap();
        let failed: Vec<String> = services
            .iter_mut()
            .filter_map(|(name, service)| match service.child.try_wait() {
                Ok(None) => None,
                _ => Some(name.clone()),
            })
            .collect();
        if !failed.is_empty() {
            self.supervisor.lock().unwrap().runtime_failure(&failed);
            service::stop_all(&mut services);
        }
    }

    pub fn while_stopped<T>(
        &self,
        action: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let _operation = self.operation.lock().unwrap();
        if !matches!(
            self.status().state,
            SupervisorState::Stopped | SupervisorState::Failed
        ) || self.quitting.load(Ordering::SeqCst)
        {
            return Err("stop services before migrating".into());
        }
        action()
    }
}

impl Drop for Controller {
    fn drop(&mut self) {
        service::stop_all(self.services.get_mut().unwrap());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::supervisor::ServiceStatus;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    fn fixture(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("controller-{name}-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("shogihome")).unwrap();
        std::fs::create_dir_all(dir.join("engine-wrapper")).unwrap();
        let mut reservations = Vec::new();
        for (folder, key, bind) in [
            ("shogihome", "PORT", "127.0.0.1"),
            ("engine-wrapper", "LISTEN_PORT", "0.0.0.0"),
        ] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            std::fs::write(
                dir.join(folder).join(".env"),
                format!("{key}={port}\nBIND_ADDRESS={bind}\nWRAPPER_ACCESS_TOKEN=fixture-token\n"),
            )
            .unwrap();
            reservations.push(listener);
        }
        dir
    }

    fn plan(dir: &Path, listening: bool) -> Result<ServicePlan, String> {
        let mut plan = service::portable_services(dir)?;
        for spec in &mut plan.specs {
            let port_key = if spec.name == "server" {
                "PORT"
            } else {
                "LISTEN_PORT"
            };
            spec.program = PathBuf::from(if cfg!(windows) { "python" } else { "python3" });
            spec.args = vec![
                "-c".into(),
                if listening {
                    format!("import os,socket,time; print(os.environ['WRAPPER_ACCESS_TOKEN'], flush=True); time.sleep(.2); s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); s.bind((os.environ['BIND_ADDRESS'],int(os.environ['{port_key}']))); s.listen(); time.sleep(60)")
                } else {
                    "import time; time.sleep(60)".into()
                },
            ];
        }
        Ok(plan)
    }

    fn wait_until(check: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !check() {
            assert!(Instant::now() < deadline, "condition timed out");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn start_snapshot_restart_and_crash_detection_use_real_children() {
        let dir = fixture("lifecycle");
        let controller = Arc::new(Controller::new(&["server", "wrapper"]));
        let worker = {
            let controller = controller.clone();
            let dir = dir.clone();
            std::thread::spawn(move || controller.start(|| plan(&dir, true)))
        };
        wait_until(|| controller.status().state == SupervisorState::Starting);
        // Reading status during startup must not wait for readiness or recurse.
        assert!(serde_json::to_string(&controller.status())
            .unwrap()
            .contains("starting"));
        worker.join().unwrap().unwrap();
        assert_eq!(controller.status().state, SupervisorState::Running);
        assert!(controller.while_stopped(|| Ok(())).is_err());
        assert!(controller.start(|| plan(&dir, true)).is_err());
        let old_pid = controller.services.lock().unwrap()["wrapper"].pid;
        controller.restart(|| plan(&dir, true)).unwrap();
        assert_eq!(controller.status().state, SupervisorState::Running);
        assert_ne!(controller.services.lock().unwrap()["wrapper"].pid, old_pid);
        assert!(
            std::fs::read_to_string(dir.join("engine-wrapper/logs/wrapper.log"))
                .unwrap()
                .contains("fixture-token")
        );
        controller
            .services
            .lock()
            .unwrap()
            .get_mut("wrapper")
            .unwrap()
            .child
            .kill()
            .unwrap();
        wait_until(|| {
            controller.check_health();
            controller.status().state == SupervisorState::Failed
        });
        assert_eq!(
            controller.status().services["wrapper"],
            ServiceStatus::Failed
        );
        assert!(controller.services.lock().unwrap().is_empty());
        controller.stop().unwrap();
        assert_eq!(controller.status().state, SupervisorState::Stopped);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn quit_during_readiness_cancels_start_and_prevents_late_restart() {
        let dir = fixture("quit");
        let controller = Arc::new(Controller::new(&["server", "wrapper"]));
        let worker = {
            let controller = controller.clone();
            let dir = dir.clone();
            std::thread::spawn(move || controller.start(|| plan(&dir, false)))
        };
        wait_until(|| controller.status().state == SupervisorState::Starting);
        controller.quit();
        assert!(worker.join().unwrap().is_err());
        assert_eq!(controller.status().state, SupervisorState::Stopped);
        assert!(controller.services.lock().unwrap().is_empty());
        assert!(controller.restart(|| plan(&dir, true)).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn partial_spawn_failure_rolls_back_sibling() {
        let dir = fixture("rollback");
        let controller = Controller::new(&["server", "wrapper"]);
        assert!(controller
            .start(|| {
                let mut plan = plan(&dir, true)?;
                plan.specs[1].program = dir.join("nonexistent");
                Ok(plan)
            })
            .is_err());
        assert_eq!(controller.status().state, SupervisorState::Failed);
        assert!(controller.services.lock().unwrap().is_empty());
        controller.while_stopped(|| Ok(())).unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }
}
