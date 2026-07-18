import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createShutdownCoordinator,
  hasChildProcessExited,
} from '../shutdown-coordinator.mjs';

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
