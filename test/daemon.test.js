/**
 * Phase 12 M1 — the Core Service itself, booted for real.
 *
 * A real Daemon on a throwaway installation root, with a real HTTP server on
 * an ephemeral port and an injected fork so no mission process is ever
 * spawned. This is what proves the headline claim of the milestone: the
 * service exists, and answers, with ZERO missions running — which is exactly
 * what was impossible before Phase 12 (the API used to live inside the
 * mission process and vanish with it).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import Daemon from '../src/daemon/daemon.js';
import DaemonClient from '../src/daemon/daemonClient.js';
import { WorkerRegistry } from '../src/daemon/workerRegistry.js';
import { readDaemon } from '../src/daemon/daemonRecord.js';
import { writeJsonAtomic } from '../src/state/statePersistence.js';
import { silentLogger } from '../src/infra/logger.js';

const DEAD_PID = 0x7ffffff0;

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = process.pid;
    this.connected = true;
    this.sent = [];
  }

  send(message) {
    this.sent.push(message);
  }
}

/** A throwaway installation root: quiet logs, ephemeral API port. */
function installation(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-daemon-svc-'));
  fs.mkdirSync(path.join(root, 'config', 'projects'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'config', 'orchestrator.json'),
    JSON.stringify({
      logging: { console: false, file: true },
      api: { enabled: true, host: '127.0.0.1', port: 0 },
      daemon: { pollIntervalMs: 50, schedulerTickMs: 60_000, workerScanMs: 60_000 },
      ...overrides,
    }),
    'utf8'
  );
  return root;
}

function defineProject(root, name) {
  fs.writeFileSync(path.join(root, 'p.md'), 'do the thing', 'utf8');
  fs.writeFileSync(
    path.join(root, 'config', 'projects', `${name}.json`),
    JSON.stringify({ driver: 'mock', workingDirectory: root, promptFile: 'p.md' }),
    'utf8'
  );
}

/** Boot a daemon with an injected fork; always stopped by the caller. */
async function boot(root = installation()) {
  const children = [];
  const daemon = new Daemon({
    rootDir: root,
    forkFn: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
  });
  // The real signal handlers would call process.exit during the test run.
  daemon.installSignalHandlers = () => {};
  // So would the stop-file watcher. A bare process.exit here terminates the
  // TEST RUNNER mid-file, silently skipping every later test while still
  // reporting success — which is exactly what happened before exitProcess()
  // was factored out. Record the intent instead.
  daemon.exitCalls = [];
  daemon.exitProcess = (code) => daemon.exitCalls.push(code);
  const info = await daemon.start();
  return { daemon, root, info, children };
}

/**
 * A client given ONLY the paths and config — no port hint. It must find the
 * service through state/daemon.json, which is how the CLI, the desktop and
 * (from M2) the Telegram router all reach it.
 */
function clientFor(daemon) {
  return new DaemonClient({
    paths: daemon.paths,
    config: daemon.config,
    logger: silentLogger,
  });
}

test('the service starts and answers with ZERO missions running', async () => {
  const { daemon } = await boot();
  try {
    const report = daemon.statusReport();
    assert.equal(report.running, true);
    assert.equal(report.pid, process.pid);
    assert.deepEqual(report.workers, [], 'no missions — and the service is up anyway');
    assert.ok(report.host.hostname, 'host resources are reported for remote operators');
  } finally {
    await daemon.stop();
  }
});

test('the daemon record is written on start and released on stop', async () => {
  const { daemon } = await boot();
  const found = readDaemon(daemon.paths.daemonFile, { logger: silentLogger });
  assert.equal(found.running, true);
  assert.equal(found.record.pid, process.pid);

  await daemon.stop();
  assert.equal(readDaemon(daemon.paths.daemonFile, { logger: silentLogger }).running, false);
});

test('a second service refuses to start while the first is alive', async () => {
  const { daemon, root } = await boot();
  try {
    const second = new Daemon({ rootDir: root });
    second.installSignalHandlers = () => {};
    await assert.rejects(() => second.start(), /Core Service is already running/);
  } finally {
    await daemon.stop();
  }
});

test('daemon.enabled:false refuses to serve', async () => {
  const root = installation({ daemon: { enabled: false } });
  const daemon = new Daemon({ rootDir: root });
  await assert.rejects(() => daemon.start(), /disabled by configuration/);
});

test('an unclean previous shutdown does not block a restart', async () => {
  const root = installation();
  writeJsonAtomic(path.join(root, 'state', 'daemon.json'), { state: 'running', pid: DEAD_PID });

  const { daemon } = await boot(root);
  try {
    assert.equal(daemon.statusReport().running, true, 'a dead pid is recovered from, not fatal');
  } finally {
    await daemon.stop();
  }
});

test('a client discovers the service by record and reaches it over real HTTP', async () => {
  const { daemon } = await boot();
  try {
    const client = clientFor(daemon);
    // Discovery is a file read, and it must carry the port actually bound —
    // sending a client to a port nothing listens on is worse than saying
    // "not running", because it looks like a network fault.
    const found = client.discover();
    assert.equal(found.running, true);
    assert.equal(found.record.port, daemon.dashboard.server.address().port);

    const result = await client.status();
    assert.equal(result.ok, true);
    assert.equal(result.report.running, true);
    assert.equal(result.report.workers.length, 0);
  } finally {
    await daemon.stop();
  }
});

test('a client reports "not running" cleanly when the service is stopped', async () => {
  const { daemon } = await boot();
  const client = clientFor(daemon);
  await daemon.stop();

  const result = await client.status();
  assert.equal(result.ok, false);
  assert.equal(result.running, false);
  assert.match(result.reason, /not running.*ai-orchestrator serve/s);
});

test('a client distinguishes a CRASHED service from a stopped one', async () => {
  const root = installation();
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  writeJsonAtomic(path.join(root, 'state', 'daemon.json'), { state: 'running', pid: DEAD_PID });

  const daemon = new Daemon({ rootDir: root });
  const result = await new DaemonClient({
    paths: daemon.paths, config: daemon.config, logger: silentLogger,
  }).status();

  assert.equal(result.ok, false);
  assert.equal(result.stale, true);
  assert.match(result.reason, /no longer running/, 'the operator is told WHICH problem they have');
});

test('the service starts TWO projects at once — the Phase 12 capability', async () => {
  const root = installation();
  defineProject(root, 'alpha');
  defineProject(root, 'beta');
  const { daemon } = await boot(root);

  try {
    assert.equal(daemon.supervisor.start('alpha').ok, true);
    // A real worker registers itself; the fake child cannot, so stand in for it.
    const registry = new WorkerRegistry({ workersDir: daemon.paths.workersDir, logger: silentLogger });
    registry.register('alpha', { pid: process.pid, mode: 'worker' });

    assert.equal(daemon.supervisor.start('beta').ok, true);
    registry.register('beta', { pid: process.pid, mode: 'worker' });

    const report = daemon.statusReport();
    assert.equal(report.workers.length, 2);
    assert.deepEqual(report.workers.map((w) => w.project).sort(), ['alpha', 'beta']);
  } finally {
    await daemon.stop();
  }
});

test('stopping the service LEAVES missions running for the next service to adopt', async () => {
  const root = installation();
  defineProject(root, 'alpha');
  const { daemon, children } = await boot(root);
  daemon.supervisor.start('alpha');
  const registry = new WorkerRegistry({ workersDir: daemon.paths.workersDir, logger: silentLogger });
  registry.register('alpha', { pid: process.pid, mode: 'worker' });

  await daemon.stop('test shutdown');

  assert.deepEqual(children[0].sent, [], 'no stop was sent — hours of work must survive a restart');
  assert.ok(registry.holderOf('alpha'), 'the mission still holds its project');

  // And the next service adopts it rather than starting over.
  const { daemon: second } = await boot(root);
  try {
    const report = second.statusReport();
    assert.equal(report.workers.length, 1);
    assert.equal(report.workers[0].project, 'alpha');
    assert.equal(report.workers[0].attached, false, 'adopted, not spawned by this service');
  } finally {
    await second.stop();
    registry.unregister('alpha');
  }
});

test('--stop-missions-on-exit stops workers instead', async () => {
  const root = installation();
  defineProject(root, 'alpha');
  const { daemon, children } = await boot(root);
  daemon.stopWorkersOnShutdown = true;
  daemon.supervisor.start('alpha');
  const registry = new WorkerRegistry({ workersDir: daemon.paths.workersDir, logger: silentLogger });
  registry.register('alpha', { pid: process.pid, mode: 'worker' });

  try {
    await daemon.stop('test shutdown');
    assert.deepEqual(children[0].sent, [{ type: 'stop', reason: 'test shutdown' }]);
  } finally {
    registry.unregister('alpha');
  }
});

test('a stop request stops the service cleanly, so it never looks like a crash', async () => {
  const { daemon, root } = await boot();

  fs.writeFileSync(path.join(root, 'state', 'daemon.stop'), '');
  await new Promise((resolve) => setTimeout(resolve, 2_400));

  const found = readDaemon(daemon.paths.daemonFile, { logger: silentLogger });
  assert.equal(found.running, false);
  assert.equal(
    found.stale, false,
    'a deliberate stop must read as "stopped", not as the crash a hard kill would leave behind'
  );
  assert.deepEqual(daemon.exitCalls, [0], 'and the service actually leaves');
});

test('a stale stop request from a previous run is not inherited', async () => {
  const root = installation();
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  fs.writeFileSync(path.join(root, 'state', 'daemon.stop'), '');

  const { daemon } = await boot(root);
  try {
    await new Promise((resolve) => setTimeout(resolve, 2_400));
    // A stale file would otherwise stop the service seconds after every boot.
    assert.equal(readDaemon(daemon.paths.daemonFile, { logger: silentLogger }).running, true);
  } finally {
    await daemon.stop();
  }
});

test('the inbound poll loop is the exclusive consumer, and runs with no mission', async () => {
  const { daemon } = await boot();
  try {
    let polls = 0;
    // Stand in for a configured Telegram provider.
    daemon.approvalManager.providers = [{
      name: 'telegram-ish',
      canReceive: true,
      async publish() {},
      async fetchDecisions() {
        polls += 1;
        return [];
      },
    }];
    assert.equal(daemon.canReceive, true);

    daemon.startPollLoop();
    await new Promise((resolve) => setTimeout(resolve, 120));

    assert.ok(polls >= 1, 'the service polls for owner replies even with nothing running');
    assert.equal(daemon.approvalManager.receiveDecisions, true, 'the service is the owner');
  } finally {
    await daemon.stop();
  }
});

test('with no two-way provider the poll loop stays off', async () => {
  const { daemon } = await boot();
  try {
    assert.equal(daemon.canReceive, false, 'no approvals.providers configured in this root');
    daemon.startPollLoop();
    // Phase 12 M2 moved the inbound timer from the daemon into the operator
    // gateway (one consuming read, routed to commands AND decisions). The
    // assertion is unchanged in substance — nothing to poll, no timer armed.
    assert.equal(daemon.gateway.timer, null, 'nothing to poll, so no timer is armed');
  } finally {
    await daemon.stop();
  }
});

test('the scheduler starts due missions as SUPERVISED WORKERS, not detached processes', async () => {
  const root = installation();
  defineProject(root, 'alpha');
  const { daemon, children } = await boot(root);
  try {
    // The scheduler's injected spawner is the supervisor.
    daemon.scheduler.spawnFn({ project: 'alpha', fresh: false });
    assert.equal(children.length, 1, 'a worker child was forked');
    assert.equal(daemon.supervisor.children.has('alpha'), true, 'and it is supervised');
  } finally {
    await daemon.stop();
  }
});

test('a scheduler launch that the supervisor refuses surfaces as an error', async () => {
  const root = installation();
  defineProject(root, 'alpha');
  const { daemon } = await boot(root);
  const registry = new WorkerRegistry({ workersDir: daemon.paths.workersDir, logger: silentLogger });
  registry.register('alpha', { pid: process.pid, mode: 'worker' });

  try {
    assert.throws(
      () => daemon.scheduler.spawnFn({ project: 'alpha' }),
      /already being supervised/,
      'MissionScheduler records this as launch-failed rather than double-starting'
    );
  } finally {
    await daemon.stop();
    registry.unregister('alpha');
  }
});
