//! Cross-process edit-session lock, one per engine configuration directory.
//!
//! The lock is held while an editor session is open (launcher-embedded or
//! standalone `--config-editor`) so two processes cannot silently
//! last-writer-win each other's `engines.json` changes. It is advisory and
//! OS-managed: the lock releases when the owning process exits, even on
//! crash, so no stale cleanup is needed. The lock file itself is never
//! deleted (deleting it would race with concurrent acquirers).
//!
//! - Unix: `flock(LOCK_EX | LOCK_NB)` on `<config_dir>/.engines.lock`.
//! - Windows: the lock file is opened with share mode 0 (no sharing), so a
//!   second opener fails with a sharing violation while ours is alive.
//!
//! Same-process reentry is tracked by the caller holding the `SessionLock`
//! value in shared state; only cross-process contention reaches the OS.

use std::path::{Path, PathBuf};

use crate::error::LauncherError;

/// An acquired edit-session lock. Dropping it (or exiting the process)
/// releases the lock.
#[derive(Debug)]
pub struct SessionLock {
    _file: std::fs::File,
    /// Configuration directory this lock guards (for diagnostics).
    pub config_dir: PathBuf,
}

/// Lock file name inside the configuration directory.
pub const LOCK_FILE_NAME: &str = ".engines.lock";

fn locked_error(path: &Path) -> String {
    format!(
        "another engine config editor session is using {} (lock {})",
        path.display(),
        LOCK_FILE_NAME
    )
}

/// Acquire the session lock for `config_dir`, creating the directory and
/// the lock file as needed. Fails when another process holds the lock.
pub fn acquire(config_dir: &Path) -> Result<SessionLock, LauncherError> {
    if config_dir.as_os_str().is_empty() {
        return Err(LauncherError::msg(
            "configuration directory must not be empty",
        ));
    }
    std::fs::create_dir_all(config_dir).map_err(|e| {
        LauncherError::io(
            format!(
                "cannot create configuration directory {}",
                config_dir.display()
            ),
            e,
        )
    })?;
    let lock_path = config_dir.join(LOCK_FILE_NAME);

    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        match std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            // The handle only owns the sharing lock; file content is unused.
            .truncate(false)
            .share_mode(0)
            .open(&lock_path)
        {
            Ok(file) => Ok(SessionLock {
                _file: file,
                config_dir: config_dir.to_path_buf(),
            }),
            Err(e) => Err(LauncherError::io(locked_error(config_dir), e)),
        }
    }

    #[cfg(unix)]
    {
        use std::os::unix::io::AsRawFd;
        let file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            // The handle only owns the flock; file content is unused.
            .truncate(false)
            .open(&lock_path)
            .map_err(|e| {
                LauncherError::io(format!("cannot open lock file {}", lock_path.display()), e)
            })?;
        // SAFETY: flock on our own open file descriptor; no memory unsafety.
        let ret = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if ret != 0 {
            let err = std::io::Error::last_os_error();
            return Err(LauncherError::io(locked_error(config_dir), err));
        }
        Ok(SessionLock {
            _file: file,
            config_dir: config_dir.to_path_buf(),
        })
    }

    #[cfg(not(any(windows, unix)))]
    {
        let _ = lock_path;
        Err(LauncherError::msg(
            "edit-session locking is not supported on this platform",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("session-lock-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn acquire_creates_lock_file_and_releases_on_drop() {
        let dir = unique_dir("basic");
        let config = dir.join("my config");
        {
            let lock = acquire(&config).expect("first acquire must succeed");
            assert_eq!(lock.config_dir, config);
            assert!(config.join(LOCK_FILE_NAME).is_file());
        }
        // Released on drop: re-acquirable.
        acquire(&config).expect("re-acquire after drop must succeed");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn acquire_rejects_empty_dir() {
        assert!(acquire(Path::new("")).is_err());
    }

    #[test]
    #[cfg(windows)]
    fn second_acquire_fails_while_held() {
        // share_mode(0) fails even in the same process: this pins the
        // cross-process exclusion on Windows without spawning children.
        let dir = unique_dir("excl");
        let config = dir.join("cfg");
        let _held = acquire(&config).expect("first acquire must succeed");
        let err = acquire(&config).expect_err("second acquire must fail while held");
        assert!(
            err.to_string()
                .contains("another engine config editor session"),
            "{err}"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    #[cfg(unix)]
    fn other_process_cannot_acquire_while_held() {
        // A fresh Python process is the cheapest cross-process flock peer
        // on Unix CI (system python3 is available on ubuntu-latest).
        let dir = unique_dir("peer");
        let config = dir.join("cfg");
        let _held = acquire(&config).expect("first acquire must succeed");
        let lock_path = config.join(LOCK_FILE_NAME);
        let probe = "import fcntl,sys\nf=open(sys.argv[1],'r+')\ntry:\n fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept OSError:\n sys.exit(10)\n";
        let blocked = std::process::Command::new("python3")
            .args(["-c", probe, &lock_path.to_string_lossy()])
            .output()
            .expect("python3 must be available for the lock peer test");
        assert_eq!(
            blocked.status.code(),
            Some(10),
            "peer must fail while the lock is held"
        );
        drop(_held);
        let free = std::process::Command::new("python3")
            .args(["-c", probe, &lock_path.to_string_lossy()])
            .output()
            .expect("python3 must be available for the lock peer test");
        assert!(
            free.status.success(),
            "peer must succeed after the lock is released"
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
