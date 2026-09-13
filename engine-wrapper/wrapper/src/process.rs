//! Engine process ownership: POSIX process groups and Windows Job Objects.
//! Retain tree ownership separately from the leader's exit status.

use std::io;
use std::path::Path;
use std::process::ExitStatus;
use tokio::process::{ChildStderr, ChildStdin, ChildStdout, Command};

pub struct EngineChild {
    #[cfg(not(windows))]
    inner: tokio::process::Child,
    #[cfg(windows)]
    inner: Box<dyn process_wrap::tokio::ChildWrapper>,
    pid: u32,
}

pub fn spawn_engine(path: &Path, cwd: &Path) -> io::Result<EngineChild> {
    #[cfg(windows)]
    let mut command = if path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("bat") || e.eq_ignore_ascii_case("cmd"))
    {
        use std::os::windows::process::CommandExt;
        let mut command = Command::new("cmd");
        command.args(["/d", "/s", "/c"]);
        // cmd strips the outer quotes; CRT argument escaping is not valid here.
        command
            .as_std_mut()
            .raw_arg(format!("\"\"{}\"\"", path.display()));
        command
    } else {
        Command::new(path)
    };
    #[cfg(not(windows))]
    let mut command = Command::new(path);
    command
        .current_dir(cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    unsafe {
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
    Ok(EngineChild { inner, pid })
}

impl EngineChild {
    pub fn id(&self) -> u32 {
        self.pid
    }
    pub fn stdin(&mut self) -> &mut Option<ChildStdin> {
        #[cfg(windows)]
        {
            self.inner.stdin()
        }
        #[cfg(not(windows))]
        {
            &mut self.inner.stdin
        }
    }
    pub fn stdout(&mut self) -> &mut Option<ChildStdout> {
        #[cfg(windows)]
        {
            self.inner.stdout()
        }
        #[cfg(not(windows))]
        {
            &mut self.inner.stdout
        }
    }
    pub fn stderr(&mut self) -> &mut Option<ChildStderr> {
        #[cfg(windows)]
        {
            self.inner.stderr()
        }
        #[cfg(not(windows))]
        {
            &mut self.inner.stderr
        }
    }
    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.inner.try_wait()
    }
    pub async fn wait(&mut self) -> io::Result<ExitStatus> {
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

impl Drop for EngineChild {
    fn drop(&mut self) {
        self.terminate_tree(false);
    }
}

pub fn is_not_found(err: &io::Error) -> bool {
    err.kind() == io::ErrorKind::NotFound
}
