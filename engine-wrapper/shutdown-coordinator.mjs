export function hasChildProcessExited(childProcess) {
  return childProcess.exitCode !== null || childProcess.signalCode !== null;
}

export function createShutdownCoordinator({
  server,
  deadlineMs = 10000,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) {
  const activeCleanups = new Set();
  const activeProcesses = new Set();
  const processWaiters = new Set();
  let shutdownPromise = null;

  const trackCleanup = (cleanup) => {
    activeCleanups.add(cleanup);
    return () => activeCleanups.delete(cleanup);
  };

  const trackProcess = (childProcess) => {
    activeProcesses.add(childProcess);
    return () => {
      activeProcesses.delete(childProcess);
      if (activeProcesses.size === 0) {
        for (const resolve of processWaiters) {
          resolve();
        }
        processWaiters.clear();
      }
    };
  };

  const waitForProcesses = () =>
    activeProcesses.size === 0
      ? Promise.resolve()
      : new Promise((resolve) => {
          processWaiters.add(resolve);
        });

  const shutdown = () => {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    const serverClosed = new Promise((resolve, reject) => {
      try {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      } catch (error) {
        reject(error);
      }
    });
    const cleanupResults = Promise.allSettled(
      [...activeCleanups].map((cleanup) => {
        try {
          return cleanup();
        } catch (error) {
          return Promise.reject(error);
        }
      }),
    );
    const processesFinished = waitForProcesses();
    const orderlyShutdown = Promise.all([serverClosed, cleanupResults, processesFinished]).then(
      ([, results]) => {
        const failures = results.filter((result) => result.status === 'rejected');
        if (failures.length > 0) {
          throw new AggregateError(
            failures.map((failure) => failure.reason),
            'one or more engine cleanups failed',
          );
        }
      },
    );

    shutdownPromise = new Promise((resolve, reject) => {
      let deadlineTimer = setTimeoutFn(() => {
        deadlineTimer = null;
        for (const childProcess of activeProcesses) {
          try {
            childProcess.kill('SIGKILL');
          } catch {
            // The process may have exited before its close event was delivered.
          }
        }
        resolve({ forced: true });
      }, deadlineMs);

      orderlyShutdown.then(
        () => {
          if (deadlineTimer !== null) {
            clearTimeoutFn(deadlineTimer);
            deadlineTimer = null;
          }
          resolve({ forced: false });
        },
        (error) => {
          if (deadlineTimer !== null) {
            clearTimeoutFn(deadlineTimer);
            deadlineTimer = null;
          }
          reject(error);
        },
      );
    });

    return shutdownPromise;
  };

  return { shutdown, trackCleanup, trackProcess };
}
