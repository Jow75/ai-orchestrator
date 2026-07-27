/**
 * Unit tests for workerSupervisor.js — Phase 12 M1.
 *
 * The supervisor is where the daemon's safety rules live: one supervisor per
 * project, never alongside a standalone orchestrator, never past the worker
 * cap, and never destroying a mission just because the service restarted.
 * Every spawn is injected, so nothing here starts a real process.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { WorkerSupervisor } from '../src/daemon/workerSupervisor.js';
import { WorkerRegistry } from '../src/daemon/workerRegistry.js';
import { writeJsonAtomic } from '../src/state/statePersistence.js';
import { silentLogger } from '../src/infra/logger.js';

const DEAD_PID = 0x7ffffff0;

/** A fake child process with the bits the supervisor actually uses. */
class FakeChild extends EventEmitter {
  constructor(pid = process.pid) {
    super();
    this.pid = pid;
    this.connected = true;
    this.sent = [];
  }

  send(message) {
    this.sent.push(message);
  }
}

function harness({ config = {}, childPid = process.pid } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-sup-'));
  const workersDir = path.join(stateDir, 'workers');
  fs.mkdirSync(workersDir, { recursive: true });
  const paths = {
    root: stateDir,
    stateDir,
    workersDir,
    heartbeatFile: path.join(stateDir, 'heartbeat.json'),
  };
  const registry = new WorkerRegistry({ workersDir, logger: silentLogger });

  const spawned = [];
  const children = [];
  const forkFn = (bin, args, options) => {
    spawned.push({ bin, args, options });
    const child = new FakeChild(childPid);
    children.push(child);
    return child;
  };

  const supervisor = new WorkerSupervisor({
    registry, config, logger: silentLogger, paths, forkFn,
  });
  return { supervisor, registry, paths, spawned, children };
}

test('starting a project forks the real CLI in worker mode', () => {
  const { supervisor, spawned } = harness();
  const result = supervisor.start('finisher');

  assert.equal(result.ok, true);
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].args, ['start', 'finisher', '--worker']);
  assert.match(spawned[0].bin, /ai-orchestrator\.js$/);
  assert.equal(spawned[0].options.env.AI_ORCHESTRATOR_DAEMON_PID, String(process.pid));
  assert.ok(spawned[0].options.stdio.includes('ipc'), 'an IPC channel is opened');
});

test('--fresh is forwarded to the worker', () => {
  const { supervisor, spawned } = harness();
  supervisor.start('finisher', { fresh: true });
  assert.deepEqual(spawned[0].args, ['start', 'finisher', '--worker', '--fresh']);
});

test('two DIFFERENT projects start simultaneously — the Phase 12 capability', () => {
  const { supervisor, registry, spawned } = harness({ config: { maxWorkers: 3 } });

  assert.equal(supervisor.start('finisher').ok, true);
  registry.register('finisher', { pid: process.pid });
  assert.equal(supervisor.start('calculator').ok, true);

  assert.equal(spawned.length, 2);
});

test('the SAME project cannot be started twice', () => {
  const { supervisor, registry } = harness();
  supervisor.start('finisher');
  registry.register('finisher', { pid: process.pid });

  const second = supervisor.start('finisher');
  assert.equal(second.ok, false);
  assert.match(second.reason, /already being supervised/);
});

test('the worker cap is enforced', () => {
  const { supervisor, registry } = harness({ config: { maxWorkers: 1 } });
  supervisor.start('a');
  registry.register('a', { pid: process.pid });

  const second = supervisor.start('b');
  assert.equal(second.ok, false);
  assert.match(second.reason, /daemon\.maxWorkers is 1/);
});

test('a live standalone orchestrator blocks the service from starting missions', () => {
  const { supervisor, paths } = harness();
  writeJsonAtomic(paths.heartbeatFile, { state: 'running', pid: process.pid });

  const result = supervisor.start('finisher');
  assert.equal(result.ok, false);
  assert.match(result.reason, /standalone orchestrator/);
});

test('a STALE standalone heartbeat does not block anything', () => {
  const { supervisor, paths } = harness();
  writeJsonAtomic(paths.heartbeatFile, { state: 'running', pid: DEAD_PID });

  assert.equal(supervisor.start('finisher').ok, true);
});

test('stopping a spawned worker prefers the IPC channel', () => {
  const { supervisor, children } = harness();
  supervisor.start('finisher');

  const result = supervisor.stop('finisher', { reason: 'test', graceMs: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.via, 'ipc');
  assert.deepEqual(children[0].sent, [{ type: 'stop', reason: 'test' }]);
});

test('stopping a project nobody supervises is a clean failure', () => {
  const { supervisor } = harness();
  const result = supervisor.stop('nobody', { graceMs: 0 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /No mission is running/);
});

test('a worker that exits without unregistering is reported as a crash', () => {
  const { supervisor, registry, children } = harness();
  supervisor.start('finisher');
  registry.register('finisher', { pid: process.pid });

  const events = [];
  supervisor.onEvent((event) => events.push(event));
  children[0].emit('exit', 1, null);

  const exited = events.find((e) => e.type === 'worker:exited');
  assert.ok(exited);
  assert.equal(exited.crashed, true, 'a live record at exit time means it died hard');
  assert.equal(registry.read('finisher'), null, 'the record is cleared so the project is startable');
});

test('a worker that unregistered itself first is a clean exit', () => {
  const { supervisor, registry, children } = harness();
  supervisor.start('finisher');
  registry.register('finisher', { pid: process.pid });
  registry.unregister('finisher'); // what App.shutdown() does

  const events = [];
  supervisor.onEvent((event) => events.push(event));
  children[0].emit('exit', 0, null);

  assert.equal(events.find((e) => e.type === 'worker:exited').crashed, false);
});

test('worker IPC messages are re-emitted to daemon listeners', () => {
  const { supervisor, children } = harness();
  supervisor.start('finisher');

  const events = [];
  supervisor.onEvent((event) => events.push(event));
  children[0].emit('message', { type: 'worker:started', pid: 999 });

  const started = events.find((e) => e.type === 'worker:started');
  assert.equal(started.project, 'finisher', 'the project is stamped on by the supervisor');
});

test('adoptExisting keeps live workers running and reaps dead ones', () => {
  const { supervisor, registry } = harness();
  registry.register('survivor', { pid: process.pid });
  registry.register('casualty', { pid: DEAD_PID });

  const events = [];
  supervisor.onEvent((event) => events.push(event));
  const { adopted, reaped } = supervisor.adoptExisting();

  assert.equal(adopted.length, 1);
  assert.equal(adopted[0].project, 'survivor');
  assert.equal(reaped.length, 1);
  assert.equal(reaped[0].project, 'casualty');
  // A mission must survive its supervisor restarting.
  assert.ok(registry.holderOf('survivor'), 'the surviving mission still holds its project');
  assert.equal(registry.read('casualty'), null);
  assert.ok(events.some((e) => e.type === 'worker:adopted'));
  assert.ok(events.some((e) => e.type === 'worker:crashed'));
});

test('an adopted worker is listed as running but not attached', () => {
  const { supervisor, registry } = harness();
  registry.register('adopted-one', { pid: process.pid });
  supervisor.adoptExisting();

  const listed = supervisor.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].project, 'adopted-one');
  assert.equal(listed[0].attached, false, 'we did not spawn it, so there is no IPC channel');
});

test('an adopted worker is stopped by STOP FILE, never a cross-process signal', () => {
  const { supervisor, registry } = harness();
  registry.register('adopted-one', { pid: process.pid });
  supervisor.adoptExisting();

  // Live validation of this milestone proved that process.kill(pid,'SIGTERM')
  // on Windows is TerminateProcess — it kills the mission instead of letting
  // it archive a resumable session. Nothing here may reach for a signal.
  const signals = [];
  const realKill = process.kill.bind(process);
  process.kill = (pid, signal) => {
    if (signal === 0) return realKill(pid, signal); // liveness probe, not a stop
    signals.push({ pid, signal });
    return true;
  };
  try {
    const result = supervisor.stop('adopted-one', { graceMs: 0 });
    assert.equal(result.ok, true);
    assert.equal(result.via, 'stop-file');
    assert.deepEqual(signals, [], 'no signal was sent — the stop must stay graceful');
    assert.equal(registry.readStopRequest('adopted-one').reason, 'daemon stop');
  } finally {
    process.kill = realKill;
  }
});

test('the grace window escalates only a worker that ignored the graceful stop', async () => {
  const { supervisor, registry } = harness();
  registry.register('stubborn', { pid: process.pid });
  supervisor.adoptExisting();

  const signals = [];
  const realKill = process.kill.bind(process);
  process.kill = (pid, signal) => {
    if (signal === 0) return realKill(pid, signal);
    signals.push({ pid, signal });
    return true;
  };
  try {
    supervisor.stop('stubborn', { graceMs: 20 });
    assert.deepEqual(signals, [], 'nothing is forced immediately');
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(signals, [{ pid: process.pid, signal: 'SIGKILL' }],
      'a hung mission must not hold its project forever');
  } finally {
    process.kill = realKill;
  }
});

test('a fork failure is reported, not thrown', () => {
  const { supervisor } = harness();
  supervisor.forkFn = () => { throw new Error('ENOENT'); };

  const result = supervisor.start('finisher');
  assert.equal(result.ok, false);
  assert.match(result.reason, /Could not start worker: ENOENT/);
});
