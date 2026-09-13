//! Engine child-process launch and tree termination.
//!
//! - Working directory is always the engine executable's parent dir.
//! - Relative engine paths are resolved against the config dir by the caller.
//! - Windows `.bat`/`.cmd` files go through `cmd /d /s /c` (quoted), exactly
//!   like the Node wrapper; every other executable is spawned directly (no
//!   shell). All Windows spawns use `CREATE_NO_WINDOW`.
//! - POSIX engines are spawned as process-group leaders (`setsid`), so the
//!   escalating `SIGTERM`/`SIGKILL` reaches grandchildren. Windows uses
//!   forced `taskkill /T` (tree), matching the Node wrapper.

use std::path::Path;
use tokio::process::{Child, Command};

use crate::config::log;

/// Spawn an engine. Returns the child on success.
pub fn spawn_engine(path: &Path, cwd: &Path) -> std::io::Result<Child> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let path_str = path.to_string_lossy();
        let is_batch = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("bat") || e.eq_ignore_ascii_case("cmd"))
            .unwrap_or(false);
        if is_batch {
            let mut cmd = Command::new("cmd");
            cmd.arg("/d")
                .arg("/s")
                .arg("/c")
                .arg(format!("\"{path_str}\""));
            cmd.current_dir(cwd);
            cmd.creation_flags(CREATE_NO_WINDOW);
            cmd.stdin(std::process::Stdio::piped());
            cmd.stdout(std::process::Stdio::piped());
            cmd.stderr(std::process::Stdio::piped());
            cmd.kill_on_drop(true);
            cmd.spawn()
        } else {
            let mut cmd = Command::new(path);
            cmd.current_dir(cwd);
            cmd.creation_flags(CREATE_NO_WINDOW);
            cmd.stdin(std::process::Stdio::piped());
            cmd.stdout(std::process::Stdio::piped());
            cmd.stderr(std::process::Stdio::piped());
            cmd.kill_on_drop(true);
            cmd.spawn()
        }
    }

    #[cfg(unix)]
    {
        let mut cmd = Command::new(path);
        cmd.current_dir(cwd);
        // New process group so signals can target the whole tree via -pid.
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
        cmd.stdin(std::process::Stdio::piped());
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        cmd.kill_on_drop(true);
        cmd.spawn()
    }

    #[cfg(not(any(windows, unix)))]
    {
        let mut cmd = Command::new(path);
        cmd.current_dir(cwd);
        cmd.stdin(std::process::Stdio::piped());
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        cmd.kill_on_drop(true);
        cmd.spawn()
    }
}

/// Force-terminate the whole engine tree for `pid`.
///
/// POSIX: signal the process group (`-pid`). Windows: forced `taskkill /T`.
/// Missing processes (`ESRCH` / already-exited child) are silently ignored.
pub fn terminate_tree(pid: u32, first_graceful: bool) {
    #[cfg(unix)]
    {
        let signal = if first_graceful {
            libc::SIGTERM
        } else {
            libc::SIGKILL
        };
        // Negative pid targets the process group started by setsid.
        let ret = unsafe { libc::kill(-(pid as i32), signal) };
        if ret != 0 {
            let err = std::io::Error::last_os_error();
            if err.raw_os_error() != Some(libc::ESRCH) {
                log::warn_compat(&format!("failed to signal engine tree {pid}: {err}"));
            }
        }
    }

    #[cfg(windows)]
    {
        let _ = first_graceful; // Windows escalation is always forced tree kill.
        let status = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output();
        if let Err(e) = status {
            log::warn_compat(&format!("failed to taskkill engine tree {pid}: {e}"));
        }
    }

    #[cfg(not(any(windows, unix)))]
    {
        let _ = (pid, first_graceful);
    }
}

/// Whether a spawn error means "executable not found" (client-facing detail).
pub fn is_not_found(err: &std::io::Error) -> bool {
    err.kind() == std::io::ErrorKind::NotFound
}
