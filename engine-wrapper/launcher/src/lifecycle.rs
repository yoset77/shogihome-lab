//! Native close/quit policy shared by all desktop shells. Service and probe
//! cleanup runs outside the event loop; only ReadyToExit permits process exit.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Running,
    Closing,
    ReadyToExit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MainCloseAction {
    Hide,
    Shutdown,
    Wait,
}

pub struct Lifecycle {
    pub phase: Phase,
    pub tray_active: bool,
}

impl Default for Lifecycle {
    fn default() -> Self {
        Self {
            phase: Phase::Running,
            tray_active: false,
        }
    }
}

impl Lifecycle {
    pub fn main_close_action(&self) -> MainCloseAction {
        if self.phase != Phase::Running {
            MainCloseAction::Wait
        } else if self.tray_active {
            MainCloseAction::Hide
        } else {
            MainCloseAction::Shutdown
        }
    }

    /// A close, menu quit, IPC quit, or OS quit must start at most one worker.
    pub fn request_exit(&mut self) -> bool {
        if self.phase != Phase::Running {
            return false;
        }
        self.phase = Phase::Closing;
        true
    }

    /// Standalone timeouts exit nonzero. A launcher timeout keeps the UI alive
    /// so the user can retry cleanup; it must never look like a clean exit.
    pub fn cleanup_finished(&mut self, drained: bool, standalone: bool) -> Option<i32> {
        if drained || standalone {
            self.phase = Phase::ReadyToExit;
            Some(if drained { 0 } else { 1 })
        } else {
            self.phase = Phase::Running;
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_tray_closes_by_draining_instead_of_hiding() {
        let lifecycle = Lifecycle::default();
        assert_eq!(lifecycle.main_close_action(), MainCloseAction::Shutdown);
    }

    #[test]
    fn only_a_live_tray_can_hide_and_repeated_quits_wait_for_cleanup() {
        let mut lifecycle = Lifecycle {
            tray_active: true,
            ..Default::default()
        };
        assert_eq!(lifecycle.main_close_action(), MainCloseAction::Hide);
        assert!(lifecycle.request_exit());
        assert!(!lifecycle.request_exit());
        assert_eq!(lifecycle.main_close_action(), MainCloseAction::Wait);
        assert_eq!(lifecycle.cleanup_finished(true, false), Some(0));
        assert_eq!(lifecycle.phase, Phase::ReadyToExit);
        assert!(!lifecycle.request_exit());
    }

    #[test]
    fn failed_cleanup_is_retryable_for_launcher_and_nonzero_for_editor() {
        let mut lifecycle = Lifecycle::default();
        assert!(lifecycle.request_exit());
        assert_eq!(lifecycle.cleanup_finished(false, false), None);
        assert!(lifecycle.request_exit());
        assert_eq!(lifecycle.cleanup_finished(false, true), Some(1));
    }
}
