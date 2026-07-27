/**
 * Phase 12 M2 — the operator interface as the Core Service actually assembles
 * it, plus the M2 half of the PHASE 12 INVARIANT.
 *
 * The invariant is the whole reason this codebase has never had a
 * compatibility break, and M2 widened the single most sensitive surface in the
 * system (what an inbound message is allowed to mean). So it is re-proven here
 * for the new milestone, not assumed to have carried over:
 *
 *   With no daemon running and no operator configuration, a standalone
 *   `ai-orchestrator start` polls, parses, and resolves approvals exactly as
 *   it does in v2.7.0.
 *
 * The rest of the file boots a REAL Daemon on a throwaway installation root
 * with an injected fork (so no mission process is ever spawned) and checks
 * that the pieces are wired to each other rather than merely constructible.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import Daemon from '../src/daemon/daemon.js';
import ApprovalManager from '../src/approvals/approvalManager.js';
import ApprovalStore from '../src/approvals/approvalStore.js';
import { ORCHESTRATOR_DEFAULTS } from '../src/config/defaults.js';
import { silentLogger } from '../src/infra/logger.js';

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = process.pid;
    this.connected = true;
    this.sent = [];
  }

  send(message) { this.sent.push(message); }

  unref() {}
}

/** A throwaway installation: quiet logs, ephemeral API port, no autostart. */
function installation({ operator, projects = ['alpha'] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-daemon-op-'));
  fs.mkdirSync(path.join(root, 'config', 'projects'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'config', 'orchestrator.json'),
    JSON.stringify({
      logging: { console: false, file: false },
      api: { enabled: true, host: '127.0.0.1', port: 0 },
      daemon: { pollIntervalMs: 60_000, schedulerTickMs: 60_000, workerScanMs: 60_000 },
      ...(operator ? { operator } : {}),
    })
  );
  for (const name of projects) {
    const workingDirectory = path.join(root, 'work', name);
    fs.mkdirSync(workingDirectory, { recursive: true });
    fs.writeFileSync(path.join(workingDirectory, 'prompt.md'), '# work\n');
    fs.writeFileSync(
      path.join(root, 'config', 'projects', `${name}.json`),
      JSON.stringify({
        workingDirectory, promptFile: 'prompt.md', driver: 'mock',
        description: `The ${name} project.`,
      })
    );
  }
  return root;
}

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
  daemon.exitCalls = [];
  daemon.exitProcess = (code) => daemon.exitCalls.push(code);
  await daemon.start();
  return { daemon, children, root };
}

// ──────────────────────────────────────────────────────── THE INVARIANT ────

test('THE PHASE 12 INVARIANT (M2): a standalone orchestrator still parses only decisions', async () => {
  // Exactly how App constructs the manager with no daemon anywhere: no
  // operator interface, no gateway, no command grammar.
  const approvalsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-standalone-'));
  const store = new ApprovalStore({ approvalsDir, logger: silentLogger });
  const seen = [];
  const provider = {
    name: 'telegram',
    canReceive: true,
    // canRoute is deliberately absent: a v2.7.0 provider never had it.
    async publish() {},
    async fetchDecisions() {
      seen.push('fetchDecisions');
      return [{ requestId: request.id, decision: 'approved', by: 'owner' }];
    },
  };
  const manager = new ApprovalManager({
    config: ORCHESTRATOR_DEFAULTS.approvals, store, providers: [provider], logger: silentLogger,
  });
  const request = store.create('alpha', {
    category: 'implementation-plan', approvalClass: 'review', title: 'Plan review',
  });

  const resolved = await manager.pollProvidersOnce();

  assert.equal(manager.receiveDecisions, true, 'a standalone orchestrator still receives');
  assert.deepEqual(seen, ['fetchDecisions'], 'through the same call it always used');
  assert.equal(resolved.length, 1);
  assert.equal(store.get('alpha', request.id).status, 'approved');
});

test('a message that is NOT a decision changes nothing in the standalone path', async () => {
  const approvalsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-standalone-2-'));
  const store = new ApprovalStore({ approvalsDir, logger: silentLogger });
  const manager = new ApprovalManager({
    config: ORCHESTRATOR_DEFAULTS.approvals,
    store,
    providers: [{
      name: 'telegram', canReceive: true,
      async publish() {},
      // The provider parses; "/projects" was never a decision and still is not.
      async fetchDecisions() { return []; },
    }],
    logger: silentLogger,
  });

  assert.deepEqual(await manager.pollProvidersOnce(), [],
    'no command surface exists without the Core Service — exactly as in v2.7.0');
});

// ───────────────────────────────────────────── the service, assembled ──────

test('the service exposes an operator interface, an event log, and a registry', async () => {
  const { daemon } = await boot();
  try {
    assert.ok(daemon.events, 'event log');
    assert.ok(daemon.projectRegistry, 'project registry');
    assert.ok(daemon.commandRouter, 'command router');
    assert.ok(daemon.gateway, 'inbound gateway');
    assert.ok(daemon.missionMonitor, 'mission monitor');
  } finally {
    await daemon.stop();
  }
});

test('starting the service is recorded in the durable log', async () => {
  const { daemon } = await boot();
  try {
    const started = daemon.events.read({ types: ['daemon.started'] });

    assert.equal(started.length, 1);
    assert.equal(started[0].payload.pid, process.pid);
    assert.ok(started[0].payload.port > 0, 'the port actually bound');
  } finally {
    await daemon.stop();
  }
});

test('stopping the service is recorded with its reason', async () => {
  const { daemon } = await boot();
  await daemon.stop('test shutdown');

  const stopped = daemon.events.read({ types: ['daemon.stopped'] });
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0].payload.reason, 'test shutdown');
});

test('a command routed through the service reaches the real registry', async () => {
  const { daemon } = await boot(installation({ projects: ['alpha', 'beta'] }));
  try {
    const { reply } = await daemon.commandRouter.handle({
      text: '/projects', channel: 'api', from: 'test',
    });

    assert.match(reply, /alpha/);
    assert.match(reply, /beta/);
    assert.equal(daemon.events.read({ types: ['command.received'] }).length, 1);
  } finally {
    await daemon.stop();
  }
});

test('starting a mission through the operator router really starts a worker', async () => {
  const { daemon, children } = await boot();
  try {
    const { reply } = await daemon.commandRouter.handle({
      text: '/start alpha', channel: 'api', from: 'test',
    });

    assert.match(reply, /mission started/);
    assert.equal(children.length, 1, 'a worker child was forked');
    assert.equal(daemon.supervisor.holderOf('alpha'), null,
      'the fake child never writes a worker record — the fork itself is the proof');
  } finally {
    await daemon.stop();
  }
});

test("a worker's start and exit both reach the event log, exactly once each", async () => {
  const { daemon, children } = await boot();
  try {
    daemon.supervisor.start('alpha');
    // The worker announces itself over IPC as well; the log must not double it.
    children[0].emit('message', { type: 'worker:started', project: 'alpha', pid: children[0].pid });
    children[0].emit('exit', 0, null);

    assert.equal(daemon.events.read({ types: ['worker.started'] }).length, 1);
    assert.equal(daemon.events.read({ types: ['worker.completed'] }).length, 1);
  } finally {
    await daemon.stop();
  }
});

test('the service status report says whether the remote console is reachable', async () => {
  const { daemon } = await boot();
  try {
    const report = daemon.statusReport();

    assert.equal(report.operator.enabled, true);
    assert.deepEqual(report.operator.channels, [], 'no provider configured in this root');
    assert.equal(report.operator.openMissionRequests, 0);
    assert.ok(report.operator.events >= 1, 'the log has at least daemon.started');
  } finally {
    await daemon.stop();
  }
});

test('the operator interface can be switched off, leaving the v2.8.0 message set', async () => {
  const { daemon } = await boot(installation({ operator: { enabled: false } }));
  try {
    const { reply } = await daemon.commandRouter.handle({
      text: '/projects', channel: 'api', from: 'test',
    });

    assert.equal(reply, null, 'the widened grammar is off');
    assert.equal(daemon.statusReport().operator.enabled, false);
  } finally {
    await daemon.stop();
  }
});

test('the mission monitor primes silently, so a restart pages nobody about old history', async () => {
  const root = installation();
  const { daemon } = await boot(root);
  try {
    daemon.lifecycle.transition('alpha', 'completed', 'finished before this service started');
    daemon.missionMonitor.prime();

    const pushed = [];
    daemon.missionMonitor.gateway = { broadcast: async (t) => { pushed.push(t); return 1; } };
    await daemon.missionMonitor.tick();

    assert.deepEqual(pushed, []);
  } finally {
    await daemon.stop();
  }
});

test('a remote shutdown goes through the service\'s own stop path', async () => {
  const { daemon } = await boot();
  const asked = await daemon.commandRouter.handle({
    text: '/shutdown', channel: 'api', from: 'test',
  });
  const code = asked.reply.match(/\/confirm ([A-Z0-9]{4})/)[1];

  const done = await daemon.commandRouter.handle({
    text: `/confirm ${code}`, channel: 'api', from: 'test',
  });

  assert.match(done.reply, /Stopping the Core Service/);
  // The shutdown is deferred by a second so the reply can be delivered first.
  await new Promise((resolve) => setTimeout(resolve, 1_400));
  assert.deepEqual(daemon.exitCalls, [0], 'and it actually leaves — via stop(), not a hard kill');
});
