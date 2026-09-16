//! Shared child-process ownership for the wrapper and launcher.
//!
//! Both crates need the same guarantee: a child owns its process group
//! (POSIX `setsid`) or Windows Job Object until cleanup finishes, so
//! grandchildren (engine helpers, server workers) are reaped even after the
//! leader exits. Waiting observes the leader only and must never block on
//! inherited pipes.
//!
//! - [`SyncChild`] backs the launcher (`std::process`).
//! - [`AsyncChild`] (feature `async`) backs the wrapper (`tokio::process`).
//! - [`is_batch_script`] keeps the `.bat`/`.cmd` → `cmd /d /s /c` quirk in
//!   one place instead of drifting between probe and engine spawns.

use std::io;
use std::path::Path;

/// True for Windows batch scripts, which cannot be spawned directly and
/// must go through `cmd /d /s /c`.
pub fn is_batch_script(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("bat") || e.eq_ignore_ascii_case("cmd"))
}

/// True for "file not found" spawn failures (vs permission errors, etc.).
pub fn is_not_found(err: &io::Error) -> bool {
    err.kind() == io::ErrorKind::NotFound
}

// ---------------------------------------------------------------------------
// Sync child (launcher)
// ---------------------------------------------------------------------------

/// A child that owns its process group / Windows Job until cleanup finishes.
/// Wait observes the leader; it must not wait for inherited pipes or helpers.
#[derive(Debug)]
pub struct SyncChild {
    #[cfg(not(windows))]
    inner: std::process::Child,
    #[cfg(windows)]
    inner: Box<dyn process_wrap::std::ChildWrapper>,
    pid: u32,
}

/// Spawn a `std::process::Command` as a process-group leader (POSIX) or
/// inside a Windows Job Object (no console window).
pub fn spawn_sync(command: std::process::Command) -> io::Result<SyncChild> {
    #[cfg(not(windows))]
    let mut command = command;
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            // SAFETY: setsid in the child between fork and exec; no memory
            // is shared with the parent here.
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    let inner = {
        use process_wrap::std::{CommandWrap, CreationFlags, JobObject};
        use windows::Win32::System::Threading::CREATE_NO_WINDOW;
        // JobObject suspends creation, assigns the job, then resumes the child.
        CommandWrap::from(command)
            .wrap(CreationFlags(CREATE_NO_WINDOW))
            .wrap(JobObject)
            .spawn()?
    };
    #[cfg(not(windows))]
    let inner = command.spawn()?;
    let pid = inner.id();
    Ok(SyncChild { inner, pid })
}

impl SyncChild {
    pub fn id(&self) -> u32 {
        self.pid
    }

    pub fn stdin(&mut self) -> &mut Option<std::process::ChildStdin> {
        #[cfg(windows)]
        {
            self.inner.stdin()
        }
        #[cfg(not(windows))]
        {
            &mut self.inner.stdin
        }
    }

    pub fn stdout(&mut self) -> &mut Option<std::process::ChildStdout> {
        #[cfg(windows)]
        {
            self.inner.stdout()
        }
        #[cfg(not(windows))]
        {
            &mut self.inner.stdout
        }
    }

    pub fn stderr(&mut self) -> &mut Option<std::process::ChildStderr> {
        #[cfg(windows)]
        {
            self.inner.stderr()
        }
        #[cfg(not(windows))]
        {
            &mut self.inner.stderr
        }
    }

    pub fn try_wait(&mut self) -> io::Result<Option<std::process::ExitStatus>> {
        self.inner.try_wait()
    }

    pub fn wait(&mut self) -> io::Result<std::process::ExitStatus> {
        #[cfg(windows)]
        {
            self.inner.inner_mut().wait()
        }
        #[cfg(not(windows))]
        {
            self.inner.wait()
        }
    }

    /// Kill the owned tree even if the leader has already been reaped.
    pub fn kill(&mut self) -> io::Result<()> {
        self.terminate_tree(false)
    }

    /// Signal the owned tree: `SIGTERM` (graceful) or `SIGKILL` (force) on
    /// POSIX, terminate on Windows. Missing processes (`ESRCH`) are fine.
    pub fn terminate_tree(&mut self, graceful: bool) -> io::Result<()> {
        #[cfg(windows)]
        {
            let _ = graceful;
            self.inner.start_kill()
        }
        #[cfg(unix)]
        {
            let signal = if graceful {
                libc::SIGTERM
            } else {
                libc::SIGKILL
            };
            if unsafe { libc::kill(-(self.pid as i32), signal) } == 0 {
                return Ok(());
            }
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ESRCH) {
                Ok(())
            } else {
                Err(error)
            }
        }
        #[cfg(not(any(windows, unix)))]
        {
            let _ = graceful;
            self.inner.kill()
        }
    }
}

impl Drop for SyncChild {
    fn drop(&mut self) {
        let _ = self.kill();
        let _ = self.wait();
    }
}

// ---------------------------------------------------------------------------
// Async child (wrapper, feature `async`)
// ---------------------------------------------------------------------------

/// Tokio-backed engine child with the same tree ownership as [`SyncChild`].
/// `Drop` signals the tree; the caller drains pipes before dropping so the
/// leader's exit status can still be observed via [`AsyncChild::wait`].
#[cfg(feature = "async")]
pub struct AsyncChild {
    #[cfg(not(windows))]
    inner: tokio::process::Child,
    #[cfg(windows)]
    inner: Box<dyn process_wrap::tokio::ChildWrapper>,
    pid: u32,
}

/// Spawn an engine at `path` with `cwd` as its working directory, piping
/// stdin/stdout/stderr. Batch scripts go through `cmd /d /s /c` (the CRT
/// argument escaping is not valid there, so the path is double-quoted
/// literally).
#[cfg(feature = "async")]
pub fn spawn_async_engine(path: &Path, cwd: &Path) -> io::Result<AsyncChild> {
    #[cfg(windows)]
    let mut command = if is_batch_script(path) {
        use std::os::windows::process::CommandExt;
        let mut command = tokio::process::Command::new("cmd");
        command.args(["/d", "/s", "/c"]);
        // cmd strips the outer quotes; CRT argument escaping is not valid here.
        command
            .as_std_mut()
            .raw_arg(format!("\"\"{}\"\"", path.display()));
        command
    } else {
        tokio::process::Command::new(path)
    };
    #[cfg(not(windows))]
    let mut command = tokio::process::Command::new(path);
    command
        .current_dir(cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    unsafe {
        // SAFETY: setsid in the child between fork and exec; no memory is
        // shared with the parent here.
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    #[cfg(windows)]
    let inner = {
        use process_wrap::tokio::{CommandWrap, CreationFlags, JobObject, KillOnDrop};
        use windows::Win32::System::Threading::CREATE_NO_WINDOW;
        CommandWrap::from(command)
            .wrap(CreationFlags(CREATE_NO_WINDOW))
            .wrap(KillOnDrop)
            .wrap(JobObject)
            .spawn()?
    };
    #[cfg(not(windows))]
    let inner = command.spawn()?;
    let pid = inner.id().expect("new child has a PID");
    Ok(AsyncChild { inner, pid })
}

#[cfg(feature = "async")]
impl AsyncChild {
    pub fn id(&self) -> u32 {
        self.pid
    }

    pub fn stdin(&mut self) -> &mut Option<tokio::process::ChildStdin> {
        #[cfg(windows)]
        {
            self.inner.stdin()
        }
        #[cfg(not(windows))]
        {
            &mut self.inner.stdin
        }
    }

    pub fn stdout(&mut self) -> &mut Option<tokio::process::ChildStdout> {
        #[cfg(windows)]
        {
            self.inner.stdout()
        }
        #[cfg(not(windows))]
        {
            &mut self.inner.stdout
        }
    }

    pub fn stderr(&mut self) -> &mut Option<tokio::process::ChildStderr> {
        #[cfg(windows)]
        {
            self.inner.stderr()
        }
        #[cfg(not(windows))]
        {
            &mut self.inner.stderr
        }
    }

    pub fn try_wait(&mut self) -> io::Result<Option<std::process::ExitStatus>> {
        self.inner.try_wait()
    }

    pub async fn wait(&mut self) -> io::Result<std::process::ExitStatus> {
        // Wait only for the leader; cleanup terminates helpers before draining.
        #[cfg(windows)]
        {
            self.inner.inner_mut().wait().await
        }
        #[cfg(not(windows))]
        {
            self.inner.wait().await
        }
    }

    /// Signal the owned tree: `SIGTERM` (graceful) or `SIGKILL` on POSIX,
    /// terminate on Windows. Fire-and-forget like the original: the caller
    /// follows up with bounded waits and a final kill.
    pub fn terminate_tree(&mut self, graceful: bool) {
        #[cfg(unix)]
        {
            let signal = if graceful {
                libc::SIGTERM
            } else {
                libc::SIGKILL
            };
            unsafe {
                libc::kill(-(self.pid as i32), signal);
            }
        }
        #[cfg(windows)]
        {
            let _ = graceful;
            let _ = self.inner.start_kill();
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = graceful;
            let _ = self.inner.start_kill();
        }
    }
}

#[cfg(feature = "async")]
impl Drop for AsyncChild {
    fn drop(&mut self) {
        self.terminate_tree(false);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batch_detection_is_case_insensitive() {
        assert!(is_batch_script(Path::new("engine.bat")));
        assert!(is_batch_script(Path::new("ENGINE.CMD")));
        assert!(!is_batch_script(Path::new("engine.exe")));
        assert!(!is_batch_script(Path::new("engine")));
        assert!(!is_batch_script(Path::new("engine.batch")));
    }

    #[test]
    fn sync_spawn_and_tree_kill_reaps_child() {
        // Python is available on all desktop CI runners, unlike sleep.
        let mut child = spawn_sync({
            let mut cmd =
                std::process::Command::new(if cfg!(windows) { "python" } else { "python3" });
            cmd.args(["-c", "import time; time.sleep(60)"]);
            cmd.stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            cmd
        })
        .expect("child must spawn");
        assert!(child.try_wait().unwrap().is_none());
        child.kill().expect("kill must succeed");
        let status = child.wait().expect("wait must succeed");
        assert!(!status.success());
    }
}
