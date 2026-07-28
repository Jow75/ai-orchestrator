/**
 * serviceControl.test.js — Phase 12 M2.1: the Core Service stays resident.
 *
 * The 2026-07-28 live validation rebooted Windows and found the operator
 * console silent. Nothing had crashed: the logon task had never been
 * installed, `doctor` did not check for it, and no surface could report it.
 *
 * These tests pin the three properties that failure needs:
 *   1. Running / Starting / Stopped is decided from evidence, not assumed.
 *   2. `ensureRunning` starts a service when there is none — and NEVER a
 *      second one when there already is.
 *   3. Autostart is reported, and its absence is treated as a real problem.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  serviceState, ensureRunning, autostartState, describeService,
  CORE_SERVICE_TASK_NAME,
} from '../src/daemon/serviceControl.js';

/**
 * A DaemonClient stand-in. `record` is what state/daemon.json would say;
 * `apiAnswers` is whether the HTTP API responds — the two can disagree, and
 * that disagreement is the whole point of the 'starting' state.
 */
function fakeClient({ running = false, stale = false, apiAnswers = true, pid = 4242, port = 4711 } = {}) {
  return {
    calls: 0,
    discover() {
      return {
        running,
        stale,
        record: running || stale ? { pid, port, timestamp: '2026-07-28T10:00:00.000Z' } : null,
      };
    },
    async call() {
      this.calls += 1;
      return apiAnswers ? { ok: true, status: 200, data: {} } : { ok: false, status: 0, reason: 'ECONNREFUSED' };
    },
  };
}

// ─────────────────────────────────────────────────────────── state ──────────

test('a service with no record is Stopped', async () => {
  const state = await serviceState(fakeClient({ running: false }));
  assert.equal(state.state, 'stopped');
  assert.equal(state.pid, null);
});

test('a record whose pid is dead is Stopped, and says the service crashed', async () => {
  const state = await serviceState(fakeClient({ running: false, stale: true }));
  assert.equal(state.state, 'stopped');
  assert.equal(state.stale, true);
  assert.match(state.detail, /without shutting down cleanly/,
    'a crash and a clean stop are different diagnoses, even with the same remedy');
});

test('an alive process whose API answers is Running', async () => {
  const state = await serviceState(fakeClient({ running: true, apiAnswers: true }));
  assert.equal(state.state, 'running');
  assert.equal(state.pid, 4242);
  assert.equal(state.port, 4711);
});

test('an alive process whose API does not answer yet is Starting, not Running or Stopped', async () => {
  const state = await serviceState(fakeClient({ running: true, apiAnswers: false }));
  assert.equal(state.state, 'starting',
    'reporting Running would make the next call fail; reporting Stopped would start a second daemon');
  assert.equal(state.pid, 4242);
});

// ────────────────────────────────────────────────────── ensureRunning ───────

test('ensureRunning starts nothing when the service is already up', async () => {
  const client = fakeClient({ running: true });
  let spawned = 0;

  const result = await ensureRunning({
    client,
    spawnImpl: () => { spawned += 1; return { pid: 1, unref() {} }; },
  });

  assert.equal(spawned, 0, 'two daemons both claim the Telegram poll; there must never be a second');
  assert.equal(result.started, false);
  assert.equal(result.state, 'running');
  assert.equal(result.ok, true);
});

test('ensureRunning does not start a second service while one is still starting', async () => {
  const client = fakeClient({ running: true, apiAnswers: false });
  let spawned = 0;

  const result = await ensureRunning({
    client,
    wait: false,
    spawnImpl: () => { spawned += 1; return { pid: 1, unref() {} }; },
  });

  assert.equal(spawned, 0);
  assert.equal(result.state, 'starting');
});

test('ensureRunning spawns a detached, console-free child when nothing is running', async () => {
  // Flips to "up" once spawned, the way a real service does.
  let up = false;
  const client = {
    discover: () => (up
      ? { running: true, stale: false, record: { pid: 99, port: 4711 } }
      : { running: false, stale: false, record: null }),
    call: async () => ({ ok: up, status: up ? 200 : 0, data: {} }),
  };

  let options = null;
  const result = await ensureRunning({
    client,
    spawnImpl: (_cmd, _args, opts) => {
      options = opts;
      up = true;
      return { pid: 99, unref() {} };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.started, true);
  assert.equal(result.state, 'running');
  // On Windows a child sharing its parent's console dies with the parent —
  // an "ensured" service that vanishes when the CLI exits is worse than none.
  assert.equal(options.detached, true);
  assert.equal(options.stdio, 'ignore');
  assert.equal(options.windowsHide, true);
});

test('ensureRunning reports a timeout as a failure, not as success', async () => {
  // Spawns, but never comes up.
  const client = {
    discover: () => ({ running: false, stale: false, record: null }),
    call: async () => ({ ok: false, status: 0 }),
  };

  const result = await ensureRunning({
    client,
    timeoutMs: 20,
    spawnImpl: () => ({ pid: 7, unref() {} }),
  });

  assert.equal(result.ok, false, 'a caller that assumes readiness it never saw will fail its next call');
  assert.match(result.reason, /did not become ready/);
});

test('ensureRunning fails cleanly when the installation root has no entry script', async () => {
  const result = await ensureRunning({
    client: fakeClient({ running: false }),
    root: 'C:\\definitely\\not\\an\\installation',
    spawnImpl: () => { throw new Error('should never be reached'); },
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /Cannot find/);
});

// ───────────────────────────────────────────────────────── autostart ────────

test('autostart is reported from the scheduler, and is not guessed off-Windows', () => {
  assert.deepEqual(
    autostartState({ platform: 'win32', query: () => ({ installed: true }) }),
    { supported: true, installed: true }
  );
  assert.deepEqual(
    autostartState({ platform: 'win32', query: () => ({ installed: false }) }),
    { supported: true, installed: false }
  );
  assert.deepEqual(
    autostartState({ platform: 'linux', query: () => { throw new Error('never asked'); } }),
    { supported: false, installed: false },
    'a Linux user told their scheduled task is missing has been told noise'
  );
});

test('the scheduled task name matches the one the install script registers', () => {
  // A rename on one side and not the other reports a healthy install forever.
  assert.equal(CORE_SERVICE_TASK_NAME, 'AI-Orchestrator Core Service');
});

// ──────────────────────────────────────────────────── describeService ───────

test('a running service with no autostart is told it will not survive a reboot', async () => {
  const service = await describeService({
    client: fakeClient({ running: true }),
    platform: 'win32',
    query: () => ({ installed: false }),
  });

  assert.equal(service.state, 'running');
  assert.equal(service.label, 'Running');
  // Exactly the machine's condition on 2026-07-28: healthy right up until it
  // rebooted, and nothing said so.
  assert.match(service.remedy, /will NOT come back after a reboot/);
  assert.match(service.remedy, /daemon install/);
});

test('a healthy, autostarting service has no remedy to offer', async () => {
  const service = await describeService({
    client: fakeClient({ running: true }),
    platform: 'win32',
    query: () => ({ installed: true }),
  });

  assert.equal(service.state, 'running');
  assert.equal(service.remedy, null, 'nothing is wrong, so nothing is suggested');
});

test('a stopped service with no autostart is told to fix both', async () => {
  const service = await describeService({
    client: fakeClient({ running: false }),
    platform: 'win32',
    query: () => ({ installed: false }),
  });

  assert.equal(service.state, 'stopped');
  assert.match(service.remedy, /daemon ensure/);
  assert.match(service.remedy, /daemon install/);
});
