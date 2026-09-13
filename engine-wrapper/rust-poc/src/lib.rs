//! Phase 0 process-supervision PoC for the Rust launcher rewrite.
//!
//! This crate intentionally has no Tauri dependency so the core lifecycle
//! logic can be tested on Linux CI. Tauri integration (windows, tray,
//! sidecar spawn) is documented in
//! `docs/rust-rewrite/phase-0-poc.md` and binds to this state machine.

use std::path::{Path, PathBuf};

/// Launcher service supervisor states (Phase 0 plan, section 3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SupervisorState {
    Stopped,
    Starting,
    Running,
    Stopping,
    Failed,
    Quitting,
}

/// A transition request from the UI layer. The UI never spawns or kills
/// processes directly; it only requests transitions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SupervisorRequest {
    Start,
    Stop,
    Restart,
    Quit,
}

/// Supervisor with generation guard so late async completions (e.g. a slow
/// spawn finishing after the user pressed Stop&Exit) cannot overwrite a
/// newer state. This is the direct fix for the `is_running` race in
/// `engine-wrapper/launcher.py:536-545,575-646`.
#[derive(Debug)]
pub struct Supervisor {
    state: SupervisorState,
    generation: u64,
}

impl Supervisor {
    pub fn new() -> Self {
        Self {
            state: SupervisorState::Stopped,
            generation: 0,
        }
    }

    pub fn state(&self) -> SupervisorState {
        self.state
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Validate a UI request against the current state and move to the
    /// transitional state. Returns the generation the async worker must
    /// present when reporting completion.
    pub fn request(&mut self, req: SupervisorRequest) -> Option<u64> {
        let next = match (self.state, req) {
            (_, SupervisorRequest::Quit) if !matches!(self.state, SupervisorState::Quitting) => {
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
        Some(self.generation)
    }

    /// Report async worker completion. Stale generations are ignored.
    /// Returns true when the completion was applied.
    pub fn complete(&mut self, generation: u64, success: bool) -> bool {
        if generation != self.generation {
            return false;
        }
        self.state = match self.state {
            SupervisorState::Starting => {
                if success {
                    SupervisorState::Running
                } else {
                    SupervisorState::Failed
                }
            }
            SupervisorState::Stopping | SupervisorState::Quitting => {
                if success {
                    SupervisorState::Stopped
                } else {
                    SupervisorState::Failed
                }
            }
            _ => return false,
        };
        true
    }
}

impl Default for Supervisor {
    fn default() -> Self {
        Self::new()
    }
}

/// Resolve the wrapper configuration root.
///
/// - `override_dir` (`--config-dir`, tests, dev) wins.
/// - Otherwise the directory containing the executable (portable ZIP layout,
///   Tauri sidecar resources resolve their config explicitly from the caller).
/// - Never falls back to the process CWD implicitly, so a launcher started
///   from another directory cannot load the wrong `engines.json`.
pub fn resolve_config_dir(exe_dir: &Path, override_dir: Option<&Path>) -> PathBuf {
    if let Some(dir) = override_dir {
        return dir.to_path_buf();
    }
    exe_dir.to_path_buf()
}

/// Decode legacy `.env` bytes with the same fallback chain as
/// `engine-wrapper/common.py:49-79`: UTF-8 BOM, UTF-8, CP932, then lossy
/// UTF-8. Returns the decoded text and the winning encoding label.
/// Saving always normalizes to UTF-8 (no original-encoding preservation).
pub fn decode_env_bytes(bytes: &[u8]) -> (String, &'static str) {
    if let Some(stripped) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        if let Ok(text) = std::str::from_utf8(stripped) {
            return (text.to_string(), "utf-8-sig");
        }
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return (text.to_string(), "utf-8");
    }
    let (decoded, _, had_errors) = encoding_rs::SHIFT_JIS.decode(bytes);
    if !had_errors {
        return (decoded.into_owned(), "cp932");
    }
    (String::from_utf8_lossy(bytes).into_owned(), "utf-8-replace")
}

/// Tauri `externalBin` sidecar source file name for a target triple.
/// The bundler strips the `-<triple>` suffix at install time, so the
/// runtime lookup must use the bare name next to the main executable.
pub fn sidecar_source_name(base: &str, target_triple: &str, windows: bool) -> String {
    let ext = if windows { ".exe" } else { "" };
    format!("{base}-{target_triple}{ext}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exit_during_startup_wins_over_late_success() {
        let mut s = Supervisor::new();
        let gen = s.request(SupervisorRequest::Start).unwrap();
        assert_eq!(s.state(), SupervisorState::Starting);
        // User presses Stop&Exit while the spawn worker is still running.
        let gen2 = s.request(SupervisorRequest::Quit).unwrap();
        assert_eq!(s.state(), SupervisorState::Quitting);
        // The stale startup completion must be ignored.
        assert!(!s.complete(gen, true));
        assert_eq!(s.state(), SupervisorState::Quitting);
        assert!(s.complete(gen2, true));
        assert_eq!(s.state(), SupervisorState::Stopped);
    }

    #[test]
    fn double_start_is_rejected() {
        let mut s = Supervisor::new();
        assert!(s.request(SupervisorRequest::Start).is_some());
        assert!(s.request(SupervisorRequest::Start).is_none());
        assert_eq!(s.state(), SupervisorState::Starting);
    }

    #[test]
    fn failed_start_is_observable() {
        let mut s = Supervisor::new();
        let gen = s.request(SupervisorRequest::Start).unwrap();
        assert!(s.complete(gen, false));
        assert_eq!(s.state(), SupervisorState::Failed);
        // Recovery path stays explicit: Failed -> Start.
        assert!(s.request(SupervisorRequest::Start).is_some());
    }

    #[test]
    fn restart_from_starting_keeps_generation_moving() {
        let mut s = Supervisor::new();
        let gen1 = s.request(SupervisorRequest::Start).unwrap();
        let gen2 = s.request(SupervisorRequest::Restart).unwrap();
        assert_ne!(gen1, gen2);
        assert!(!s.complete(gen1, true));
        assert_eq!(s.state(), SupervisorState::Starting);
    }

    #[test]
    fn config_dir_override_wins_over_exe_dir() {
        let resolved = resolve_config_dir(Path::new("/app"), Some(Path::new("/tmp/cfg")));
        assert_eq!(resolved, PathBuf::from("/tmp/cfg"));
        let resolved = resolve_config_dir(Path::new("/app"), None);
        assert_eq!(resolved, PathBuf::from("/app"));
    }

    #[test]
    fn env_decode_prefers_utf8_and_falls_back_to_cp932() {
        let (text, enc) = decode_env_bytes("PORT=8140\n".as_bytes());
        assert_eq!((text.as_str(), enc), ("PORT=8140\n", "utf-8"));
        let (text, enc) = decode_env_bytes(&[0xEF, 0xBB, 0xBF, b'A', b'=', b'1', b'\n']);
        assert_eq!((text.as_str(), enc), ("A=1\n", "utf-8-sig"));
        // "あ" in CP932 (0x82 0xA0): invalid as UTF-8, valid Shift-JIS.
        let cp932 = [b'M', b'S', b'G', b'=', 0x82, 0xA0, b'\n'];
        let (text, enc) = decode_env_bytes(&cp932);
        assert_eq!(enc, "cp932");
        assert_eq!(text, "MSG=あ\n");
    }

    #[test]
    fn sidecar_names_follow_tauri_triple_convention() {
        assert_eq!(
            sidecar_source_name("wrapper", "x86_64-pc-windows-msvc", true),
            "wrapper-x86_64-pc-windows-msvc.exe"
        );
        assert_eq!(
            sidecar_source_name("wrapper", "x86_64-unknown-linux-gnu", false),
            "wrapper-x86_64-unknown-linux-gnu"
        );
    }
}
