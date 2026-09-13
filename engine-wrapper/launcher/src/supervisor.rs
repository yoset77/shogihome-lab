//! Serialized service supervisor.
//!
//! Fixes the `is_running`-flag races in `launcher.py` (`start_services` has
//! no guard during startup, spawn runs on a detached thread, stop neither
//! cancels nor joins it): every transition goes through one state machine
//! with generation identifiers, so stale async completions cannot overwrite
//! newer states, and partial-start failures roll back siblings.

use std::collections::HashMap;

/// Overall launcher lifecycle state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SupervisorState {
    Stopped,
    Starting,
    Running,
    Stopping,
    Failed,
    Quitting,
}

/// Per-service liveness inside a transition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServiceStatus {
    Pending,
    Ready,
    Failed,
}

/// UI requests. Spawning/killing happens only in the worker that owns the
/// generation returned by [`Supervisor::request`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SupervisorRequest {
    Start,
    Stop,
    Restart,
    Quit,
}

#[derive(Debug)]
pub struct Supervisor {
    state: SupervisorState,
    generation: u64,
    services: HashMap<String, ServiceStatus>,
}

impl Supervisor {
    pub fn new(service_names: &[&str]) -> Self {
        Self {
            state: SupervisorState::Stopped,
            generation: 0,
            services: service_names
                .iter()
                .map(|n| (n.to_string(), ServiceStatus::Pending))
                .collect(),
        }
    }

    pub fn state(&self) -> SupervisorState {
        self.state
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn service_status(&self, name: &str) -> Option<ServiceStatus> {
        self.services.get(name).copied()
    }

    /// Request a transition. Returns the generation the worker must present
    /// on completion, or `None` when the request is invalid for this state
    /// (e.g. double start).
    pub fn request(&mut self, req: SupervisorRequest) -> Option<u64> {
        let next = match (self.state, req) {
            (_, SupervisorRequest::Quit) if self.state != SupervisorState::Quitting => {
                SupervisorState::Quitting
            }
            (SupervisorState::Stopped | SupervisorState::Failed, SupervisorRequest::Start) => {
                SupervisorState::Starting
            }
            (
                SupervisorState::Running | SupervisorState::Failed,
                SupervisorRequest::Stop | SupervisorRequest::Restart,
            ) => SupervisorState::Stopping,
            (SupervisorState::Starting, SupervisorRequest::Stop) => SupervisorState::Stopping,
            (SupervisorState::Starting, SupervisorRequest::Restart) => SupervisorState::Starting,
            _ => return None,
        };
        self.generation += 1;
        self.state = next;
        for status in self.services.values_mut() {
            *status = ServiceStatus::Pending;
        }
        Some(self.generation)
    }

    /// Record one service becoming ready. Stale generations are ignored.
    pub fn service_ready(&mut self, generation: u64, name: &str) -> bool {
        if generation != self.generation || self.state != SupervisorState::Starting {
            return false;
        }
        if let Some(status) = self.services.get_mut(name) {
            *status = ServiceStatus::Ready;
            if self.services.values().all(|s| *s == ServiceStatus::Ready) {
                self.state = SupervisorState::Running;
            }
            true
        } else {
            false
        }
    }

    /// Report the worker's final result. `true` = transition goal reached.
    /// A failed start/stop lands in `Failed` with per-service detail kept;
    /// stale generations are ignored. Returns whether it was applied.
    pub fn complete(&mut self, generation: u64, success: bool) -> bool {
        if generation != self.generation {
            return false;
        }
        match self.state {
            SupervisorState::Starting | SupervisorState::Stopping | SupervisorState::Quitting => {
                self.state = if success {
                    match self.state {
                        SupervisorState::Starting => SupervisorState::Running,
                        _ => SupervisorState::Stopped,
                    }
                } else {
                    SupervisorState::Failed
                };
                true
            }
            _ => false,
        }
    }

    /// Mark one service failed during startup (partial-start rollback path).
    pub fn service_failed(&mut self, generation: u64, name: &str) -> bool {
        if generation != self.generation || self.state != SupervisorState::Starting {
            return false;
        }
        if let Some(status) = self.services.get_mut(name) {
            *status = ServiceStatus::Failed;
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn two() -> Supervisor {
        Supervisor::new(&["server", "wrapper"])
    }

    #[test]
    fn exit_during_startup_ignores_stale_success() {
        let mut s = two();
        let g1 = s.request(SupervisorRequest::Start).unwrap();
        let g2 = s.request(SupervisorRequest::Quit).unwrap();
        assert_eq!(s.state(), SupervisorState::Quitting);
        assert!(!s.complete(g1, true));
        assert!(s.complete(g2, true));
        assert_eq!(s.state(), SupervisorState::Stopped);
    }

    #[test]
    fn double_start_rejected_and_double_restart_serialized() {
        let mut s = two();
        assert!(s.request(SupervisorRequest::Start).is_some());
        assert!(s.request(SupervisorRequest::Start).is_none());
        let g = s.generation();
        assert!(s.request(SupervisorRequest::Restart).is_some());
        assert_ne!(s.generation(), g);
    }

    #[test]
    fn partial_start_failure_is_observable_per_service() {
        let mut s = two();
        let g = s.request(SupervisorRequest::Start).unwrap();
        assert!(s.service_ready(g, "wrapper"));
        assert_eq!(s.state(), SupervisorState::Starting);
        assert!(s.service_failed(g, "server"));
        assert_eq!(s.service_status("server"), Some(ServiceStatus::Failed));
        assert!(s.complete(g, false));
        assert_eq!(s.state(), SupervisorState::Failed);
        // Recovery is explicit.
        assert!(s.request(SupervisorRequest::Start).is_some());
    }

    #[test]
    fn all_ready_transitions_to_running() {
        let mut s = two();
        let g = s.request(SupervisorRequest::Start).unwrap();
        s.service_ready(g, "server");
        assert_eq!(s.state(), SupervisorState::Starting);
        s.service_ready(g, "wrapper");
        assert_eq!(s.state(), SupervisorState::Running);
    }

    #[test]
    fn stop_during_starting_moves_to_stopping() {
        let mut s = two();
        let g1 = s.request(SupervisorRequest::Start).unwrap();
        let g2 = s.request(SupervisorRequest::Stop).unwrap();
        assert_ne!(g1, g2);
        assert_eq!(s.state(), SupervisorState::Stopping);
        // Late startup completion for the old generation is dropped.
        assert!(!s.service_ready(g1, "server"));
        assert!(s.complete(g2, true));
        assert_eq!(s.state(), SupervisorState::Stopped);
    }
}
