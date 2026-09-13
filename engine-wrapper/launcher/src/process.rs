//! A child owns its process group / Windows Job until cleanup finishes.
//! Wait observes the leader; it must not wait for inherited pipes or helpers.

use std::io;
use std::process::{ChildStderr, ChildStdin, ChildStdout, Command, ExitStatus};

#[derive(Debug)]
pub struct ManagedChild {
    #[cfg(not(windows))]
    inner: std::process::Child,
    #[cfg(windows)]
    inner: Box<dyn process_wrap::std::ChildWrapper>,
    pid: u32,
}

pub fn spawn(command: Command) -> io::Result<ManagedChild> {
    #[cfg(not(windows))]
    let mut command = command;
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
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
    Ok(ManagedChild { inner, pid })
}

impl ManagedChild {
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

    pub fn wait(&mut self) -> io::Result<ExitStatus> {
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
        #[cfg(windows)]
        {
            self.inner.start_kill()
        }
        #[cfg(unix)]
        {
            if unsafe { libc::kill(-(self.pid as i32), libc::SIGKILL) } == 0 {
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
            self.inner.kill()
        }
    }
}

impl Drop for ManagedChild {
    fn drop(&mut self) {
        let _ = self.kill();
        let _ = self.wait();
    }
}
