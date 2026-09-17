//! One edit-session lock and its in-flight probes. The same mutex gates probe
//! registration and cancellation so no late worker can escape window shutdown.
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::error::LauncherError;

#[derive(Default)]
pub struct EditorSession {
    generation: u64,
    next_probe: u64,
    lock: Option<crate::session_lock::SessionLock>,
    closing: bool,
    probes: HashMap<u64, Arc<AtomicBool>>,
}

impl EditorSession {
    pub fn open(&mut self, config_dir: &Path) -> Result<(), LauncherError> {
        if self.lock.is_none() {
            self.lock = Some(crate::session_lock::acquire(config_dir)?);
        }
        self.generation += 1;
        self.closing = false;
        Ok(())
    }

    pub fn begin_probe(session: &Arc<Mutex<Self>>) -> Result<ProbeRegistration, LauncherError> {
        let mut state = session
            .lock()
            .map_err(|e| LauncherError::msg(e.to_string()))?;
        state.ensure_open()?;
        state.next_probe += 1;
        let id = state.next_probe;
        let cancel = Arc::new(AtomicBool::new(false));
        state.probes.insert(id, cancel.clone());
        Ok(ProbeRegistration {
            id,
            cancel,
            session: session.clone(),
        })
    }

    pub fn ensure_open(&self) -> Result<(), LauncherError> {
        if self.closing || self.lock.is_none() {
            Err(crate::native_text::text("editorClosing").into())
        } else {
            Ok(())
        }
    }

    pub fn cancel(&self, id: u64) {
        if let Some(cancel) = self.probes.get(&id) {
            cancel.store(true, Ordering::SeqCst);
        }
    }

    pub fn close(&mut self) -> u64 {
        self.closing = true;
        for cancel in self.probes.values() {
            cancel.store(true, Ordering::SeqCst);
        }
        self.generation
    }

    /// Whether a failed window build is allowed to tear this session down.
    /// `owned_generation` is the generation the failing request opened.
    /// Concurrent open requests can both pass the window-existence check and
    /// race on the same window label; the loser must not close the winner's
    /// session. Only the request that still owns the current generation,
    /// with no live window, may close.
    pub fn should_release_after_build_failure(
        &self,
        window_exists: bool,
        owned_generation: u64,
    ) -> bool {
        !window_exists && self.lock.is_some() && self.generation == owned_generation
    }

    pub fn is_idle(&self) -> bool {
        self.probes.is_empty()
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// A timer for an older window must neither unlock a reopened editor nor
    /// release a lock while cancelled probes still own processes.
    pub fn release_if_idle(&mut self, generation: u64) -> bool {
        if self.closing && self.generation == generation && self.is_idle() {
            self.lock.take();
            true
        } else {
            false
        }
    }
}

pub struct ProbeRegistration {
    pub id: u64,
    pub cancel: Arc<AtomicBool>,
    session: Arc<Mutex<EditorSession>>,
}

impl Drop for ProbeRegistration {
    fn drop(&mut self) {
        // This guard belongs to the blocking worker, not its IPC future.
        let mut session = self.session.lock().unwrap();
        session.probes.remove(&self.id);
        let generation = session.generation();
        // Also handles a worker completing after the UI's drain deadline.
        session.release_if_idle(generation);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closing_rejects_late_probes_and_holds_lock_until_workers_finish() {
        let dir = std::env::temp_dir().join(format!("editor-session-{}", std::process::id()));
        let session = Arc::new(Mutex::new(EditorSession::default()));
        session.lock().unwrap().open(&dir).unwrap();
        let probe = EditorSession::begin_probe(&session).unwrap();
        let generation = session.lock().unwrap().close();
        assert!(probe.cancel.load(Ordering::SeqCst));
        assert!(EditorSession::begin_probe(&session).is_err());
        assert!(!session.lock().unwrap().release_if_idle(generation));
        assert!(crate::session_lock::acquire(&dir).is_err());
        // A reopened editor retains the same lock, but invalidates old timers.
        session.lock().unwrap().open(&dir).unwrap();
        assert!(!session.lock().unwrap().release_if_idle(generation));
        drop(probe);
        assert!(crate::session_lock::acquire(&dir).is_err());
        let generation = session.lock().unwrap().close();
        assert!(session.lock().unwrap().release_if_idle(generation));
        drop(crate::session_lock::acquire(&dir).unwrap());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_late_worker_releases_a_closed_session_without_a_ui_timer() {
        let dir = std::env::temp_dir().join(format!("editor-late-worker-{}", std::process::id()));
        let session = Arc::new(Mutex::new(EditorSession::default()));
        session.lock().unwrap().open(&dir).unwrap();
        let probe = EditorSession::begin_probe(&session).unwrap();
        session.lock().unwrap().close();
        assert!(session.lock().unwrap().ensure_open().is_err());
        assert!(crate::session_lock::acquire(&dir).is_err());
        drop(probe);
        drop(crate::session_lock::acquire(&dir).unwrap());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_build_cleanup_never_closes_a_live_session() {
        // Interleaving from the concurrent-open race: two requests pass the
        // window-existence check, both open() the shared session, one window
        // build fails. The loser must leave the winner's session open.
        let dir = std::env::temp_dir().join(format!("editor-race-{}", std::process::id()));
        let session = Arc::new(Mutex::new(EditorSession::default()));
        session.lock().unwrap().open(&dir).unwrap();
        let generation_a = session.lock().unwrap().generation();
        session.lock().unwrap().open(&dir).unwrap();
        let generation_b = session.lock().unwrap().generation();
        // Loser A: the winner's window exists, so no teardown even though A
        // still sees its own generation as current-or-older.
        assert!(!session
            .lock()
            .unwrap()
            .should_release_after_build_failure(true, generation_a));
        assert!(session.lock().unwrap().ensure_open().is_ok());
        // Stale failure: superseded by B's open, so it must not close either.
        assert!(!session
            .lock()
            .unwrap()
            .should_release_after_build_failure(false, generation_a));
        assert!(session.lock().unwrap().ensure_open().is_ok());
        // Sole owner B with no window: teardown is allowed.
        assert!(session
            .lock()
            .unwrap()
            .should_release_after_build_failure(false, generation_b));
        let generation = session.lock().unwrap().close();
        assert!(session.lock().unwrap().ensure_open().is_err());
        assert!(session.lock().unwrap().release_if_idle(generation));
        drop(crate::session_lock::acquire(&dir).unwrap());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
