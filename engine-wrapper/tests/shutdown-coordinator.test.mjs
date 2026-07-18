import assert from 'node:assert/strict';
import test from 'node:test';

import { createShutdownCoordinator, hasChildProcessExited, shouldCreateProcessGroup, terminateProcessTree } from '../shutdown-coordinator.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test('detects child processes that exited by code or signal', () => {
  assert.equal(hasChildProcessExited({ exitCode: 0, signalCode: null }), true);
  assert.equal(hasChildProcessExited({ exitCode: null, signalCode: 'SIGTERM' }), true);
  assert.equal(hasChildProcessExited({ exitCode: null, signalCode: null }), false);
});

test('creates process groups only on POSIX platforms', () => {
  assert.equal(shouldCreateProcessGroup('linux'), true);
  assert.equal(shouldCreateProcessGroup('darwin'), true);
  assert.equal(shouldCreateProcessGroup('win32'), false);
});

test('terminates the POSIX process group', async () => {
  const calls = [];
  await terminateProcessTree({ pid: 123, exitCode: null, signalCode: null }, 'SIGTERM', {
    platform: 'linux',
    killProcessGroup(pid, signal) {
      calls.push([pid, signal]);
    },
  });

  assert.deepEqual(calls, [[-123, 'SIGTERM']]);
});

test('terminates a POSIX process group after its leader exits', async () => {
  const calls = [];
  await terminateProcessTree({ pid: 124, exitCode: 0, signalCode: null }, 'SIGKILL', {
    platform: 'linux',
    killProcessGroup(pid, signal) {
      calls.push([pid, signal]);
    },
  });

  assert.deepEqual(calls, [[-124, 'SIGKILL']]);
});

test('terminates the complete Windows process tree', async () => {
  const calls = [];
  const childProcess = { pid: 456, exitCode: null, signalCode: null };
  await terminateProcessTree(childProcess, 'SIGTERM', {
    platform: 'win32',
    runTaskkill(pid, force) {
      calls.push([pid, force]);
      return Promise.resolve();
    },
  });
  await terminateProcessTree(childProcess, 'SIGKILL', {
    platform: 'win32',
    runTaskkill(pid, force) {
      calls.push([pid, force]);
      return Promise.resolve();
    },
  });

  assert.deepEqual(calls, [
    [456, true],
    [456, true],
  ]);
});

test('shutdown is idempotent and waits for the server and active cleanups', async () => {
  let closeCallback;
  let closeCalls = 0;
  let cleanupCalls = 0;
  let clearedTimer;
  const callOrder = [];
  const cleanupFinished = deferred();
  const server = {
    close(callback) {
      closeCalls += 1;
      callOrder.push('close');
      closeCallback = callback;
    },
  };
  const coordinator = createShutdownCoordinator({
    server,
    setTimeoutFn: () => 42,
    clearTimeoutFn: (timer) => {
      clearedTimer = timer;
    },
  });
  coordinator.trackCleanup(() => {
    cleanupCalls += 1;
    callOrder.push('cleanup');
    return cleanupFinished.promise;
  });

  const firstShutdown = coordinator.shutdown();
  const secondShutdown = coordinator.shutdown();
  let settled = false;
  firstShutdown.then(() => {
    settled = true;
  });

  assert.strictEqual(firstShutdown, secondShutdown);
  assert.equal(closeCalls, 1);
  assert.equal(cleanupCalls, 1);
  assert.deepEqual(callOrder, ['close', 'cleanup']);

  cleanupFinished.resolve();
  await Promise.resolve();
  assert.equal(settled, false);

  closeCallback();
  assert.deepEqual(await firstShutdown, { forced: false });
  assert.equal(clearedTimer, 42);
});

test('shutdown deadline kills only processes that are still tracked', async () => {
  const signals = [];
  const server = {
    close() {},
  };
  const coordinator = createShutdownCoordinator({
    server,
    deadlineMs: 10,
  });
  const finishedProcess = {
    kill(signal) {
      signals.push(['finished', signal]);
    },
  };
  const activeProcess = {
    kill(signal) {
      signals.push(['active', signal]);
    },
  };
  const untrackFinishedProcess = coordinator.trackProcess(finishedProcess);
  coordinator.trackProcess(activeProcess);
  untrackFinishedProcess();
  coordinator.trackCleanup(() => new Promise(() => {}));

  assert.deepEqual(await coordinator.shutdown(), { forced: true });
  assert.deepEqual(signals, [['active', 'SIGKILL']]);
});

test('a rejected cleanup cannot report a clean shutdown while a process remains', async () => {
  const signals = [];
  const server = {
    close(callback) {
      callback();
    },
  };
  const coordinator = createShutdownCoordinator({ server, deadlineMs: 10 });
  coordinator.trackProcess({
    kill(signal) {
      signals.push(signal);
    },
  });
  coordinator.trackCleanup(() => Promise.reject(new Error('cleanup failed')));

  assert.deepEqual(await coordinator.shutdown(), { forced: true });
  assert.deepEqual(signals, ['SIGKILL']);
});
