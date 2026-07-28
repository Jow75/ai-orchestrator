/**
 * orchestratorBridge.test.js — verifies the dual-mode dispatch logic that
 * makes the desktop app safe to use whether or not an orchestrator process
 * is currently running: idle calls must hit the same library classes the
 * CLI uses (real files on a temp root), live calls must hit the dashboard
 * HTTP API (a fake fetch, asserted on), and the stop fallback must engage
 * when the API is unreachable. Electron itself is never loaded here — this
 * module is plain CommonJS/Node so `node --test` can run it standalone.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { OrchestratorBridge } = require('../main/orchestratorBridge');

function makeFetch(responder) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const result = responder ? (responder(url, options) ?? { status: 200, body: {} }) : { status: 200, body: {} };
    return { ok: result.status >= 200 && result.status < 300, status: result.status, json: async () => result.body };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const failingFetch = async () => { throw new Error('ECONNREFUSED'); };

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-desktop-'));
  return root;
}

function defineProject(root, name, extra = {}) {
  // Always include promptFile: validateProject() requires it unless the
  // project's *static* tasks array is non-empty (missionPlan.isLegacyMission)
  // — a project meant purely for runtime-added tasks (Phase P3) still needs
  // a valid config to pass getProject(), exactly as the CLI's `tasks add`
  // requires ("Reuses full project validation").
  const workspace = path.join(root, 'workspaces', name);
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'mission.md'), '# mission');
  fs.mkdirSync(path.join(root, 'config', 'projects'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'config', 'projects', `${name}.json`),
    JSON.stringify({ driver: 'mock', workingDirectory: workspace, promptFile: 'mission.md', ...extra }, null, 2)
  );
  return workspace;
}

function markLive(root, { pid = process.pid } = {}) {
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'heartbeat.json'), JSON.stringify({ state: 'running', pid }));
}

test('isLive() is false with no heartbeat file', async () => {
  const root = makeRoot();
  const bridge = new OrchestratorBridge({ rootDir: root });
  assert.equal(await bridge.isLive(), false);
});

test('isLive() is true when the heartbeat says running with a live pid', async () => {
  const root = makeRoot();
  markLive(root);
  const bridge = new OrchestratorBridge({ rootDir: root });
  assert.equal(await bridge.isLive(), true);
});

test('isLive() is false when the heartbeat pid is dead (stale/unclean shutdown)', async () => {
  const root = makeRoot();
  // A pid essentially guaranteed not to be alive in this test environment.
  markLive(root, { pid: 999_999 });
  const bridge = new OrchestratorBridge({ rootDir: root });
  assert.equal(await bridge.isLive(), false);
});

test('listProjects() reflects defined projects and active sessions from disk', async () => {
  const root = makeRoot();
  defineProject(root, 'proj-a');
  defineProject(root, 'proj-b');
  fs.mkdirSync(path.join(root, 'state', 'sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'state', 'sessions', 'proj-a.json'),
    JSON.stringify({ id: 's1', project: 'proj-a', state: 'running' })
  );

  const bridge = new OrchestratorBridge({ rootDir: root });
  const projects = await bridge.listProjects();
  assert.deepEqual(
    projects.sort((a, b) => a.name.localeCompare(b.name)),
    [
      // `simulated` rides along from Phase 12 M3: defineProject() uses the mock
      // driver, and the picker is exactly where a fixture project gets chosen.
      { name: 'proj-a', hasActiveSession: true, simulated: true },
      { name: 'proj-b', hasActiveSession: false, simulated: true },
    ]
  );
});

test('listProjects() does not label a real-engine project as simulated', async () => {
  const root = makeRoot();
  defineProject(root, 'real', { driver: 'claude' });

  const [project] = await new OrchestratorBridge({ rootDir: root }).listProjects();

  assert.equal(project.simulated, false);
});

test('getStatus() idle path reads status.json directly (no HTTP)', async () => {
  const root = makeRoot();
  fs.writeFileSync(path.join(root, 'status.json'), JSON.stringify({ project: 'x', orchestrator: { state: 'stopped' } }));
  const fetchImpl = makeFetch();
  const bridge = new OrchestratorBridge({ rootDir: root, fetchImpl });
  const status = await bridge.getStatus();
  assert.equal(status.project, 'x');
  assert.equal(fetchImpl.calls.length, 0);
});

test('getStatus() live path calls GET /api/status', async () => {
  const root = makeRoot();
  markLive(root);
  const fetchImpl = makeFetch((url) => {
    assert.match(url, /\/api\/status$/);
    return { status: 200, body: { project: 'live-proj' } };
  });
  const bridge = new OrchestratorBridge({ rootDir: root, fetchImpl });
  const status = await bridge.getStatus();
  assert.equal(status.project, 'live-proj');
  assert.equal(fetchImpl.calls.length, 1);
});

test('addTask() idle path enqueues via TaskQueue directly, mirroring the CLI', async () => {
  const root = makeRoot();
  defineProject(root, 'proj-tasks');
  const bridge = new OrchestratorBridge({ rootDir: root, fetchImpl: makeFetch() });

  const result = await bridge.addTask('proj-tasks', { id: 'T1', prompt: 'mission.md', objective: 'do it' });
  assert.equal(result.ok, true);

  const queue = await bridge.getTasks('proj-tasks');
  assert.equal(queue.tasks[0].id, 'T1');
});

test('addTask() live path POSTs to the dashboard API with the bearer token', async () => {
  const root = makeRoot();
  defineProject(root, 'proj-tasks');
  markLive(root);

  const fetchImpl = makeFetch((url, options) => {
    assert.match(url, /\/api\/tasks\/proj-tasks\/add$/);
    assert.equal(options.method, 'POST');
    assert.match(options.headers.authorization, /^Bearer .+/);
    return { status: 200, body: { ok: true, position: 1 } };
  });
  const bridge = new OrchestratorBridge({ rootDir: root, fetchImpl });
  const result = await bridge.addTask('proj-tasks', { id: 'T1', prompt: 'mission.md' });
  assert.equal(result.ok, true);
  assert.equal(fetchImpl.calls.length, 1);
});

test('approveTask() idle path resets a blocked current task to pending', async () => {
  const root = makeRoot();
  defineProject(root, 'proj-approve');
  const bridge = new OrchestratorBridge({ rootDir: root, fetchImpl: makeFetch() });

  await bridge.addTask('proj-approve', { id: 'T1', prompt: 'mission.md', maxRuns: 1 });
  // Simulate a blocked outcome the same way the orchestrator would record it.
  const tasksFile = path.join(root, 'state', 'tasks', 'proj-approve.json');
  const queue = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  queue.tasks[0].state = 'blocked';
  queue.tasks[0].attempts = 1;
  fs.writeFileSync(tasksFile, JSON.stringify(queue));

  const result = await bridge.approveTask('proj-approve', 'T1');
  assert.equal(result.ok, true);
  const reloaded = await bridge.getTasks('proj-approve');
  assert.equal(reloaded.tasks[0].state, 'pending');
});

test('startMission() refuses to start a second mission while one is live', async () => {
  const root = makeRoot();
  defineProject(root, 'proj-a');
  markLive(root);
  const bridge = new OrchestratorBridge({ rootDir: root, fetchImpl: makeFetch() });
  const result = await bridge.startMission('proj-a');
  assert.equal(result.ok, false);
  assert.match(result.reason, /already running/);
});

test('stopMission() reports failure when nothing is live', async () => {
  const root = makeRoot();
  const bridge = new OrchestratorBridge({ rootDir: root, fetchImpl: makeFetch() });
  const result = await bridge.stopMission('test');
  assert.equal(result.ok, false);
});

test('stopMission() prefers POST /api/control/stop when live', async () => {
  const root = makeRoot();
  markLive(root);
  const fetchImpl = makeFetch((url, options) => {
    assert.match(url, /\/api\/control\/stop$/);
    assert.equal(options.method, 'POST');
    return { status: 200, body: { ok: true } };
  });
  const bridge = new OrchestratorBridge({ rootDir: root, fetchImpl });
  const result = await bridge.stopMission('test');
  assert.equal(result.ok, true);
  assert.equal(fetchImpl.calls.length, 1);
});

test('stopMission() falls back to the stop-request file when the API is unreachable', async () => {
  const root = makeRoot();
  markLive(root);
  const bridge = new OrchestratorBridge({ rootDir: root, fetchImpl: failingFetch });
  const result = await bridge.stopMission('test');
  assert.equal(result.ok, true);
  assert.equal(result.viaFallback, true);
  assert.equal(fs.existsSync(path.join(root, 'state', 'stop.requested')), true);
});

test('getApiToken() / rotateApiToken() persist a token file, rotate invalidates it', async () => {
  const root = makeRoot();
  const bridge = new OrchestratorBridge({ rootDir: root });
  const token1 = await bridge.getApiToken();
  const token2 = await bridge.getApiToken();
  assert.equal(token1, token2);

  const rotated = await bridge.rotateApiToken();
  assert.notEqual(rotated, token1);
  assert.equal(await bridge.getApiToken(), rotated);
});

// ── Phase 9: agents ────────────────────────────────────────────────────

test('getAgents() idle path returns the implicit default for an agent-less project', async () => {
  const root = makeRoot();
  defineProject(root, 'proj-a');
  const bridge = new OrchestratorBridge({ rootDir: root, fetchImpl: makeFetch() });
  const agents = await bridge.getAgents('proj-a');
  assert.equal(agents.length, 1);
  assert.equal(agents[0].id, 'default');
  assert.equal(agents[0].implicit, true);
});

test('getAgents() idle path loads a configured global roster', async () => {
  const root = makeRoot();
  defineProject(root, 'proj-a');
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'config', 'agents.json'),
    JSON.stringify({ agents: [{ id: 'coder', role: 'coding', driver: 'claude' }] })
  );
  const bridge = new OrchestratorBridge({ rootDir: root, fetchImpl: makeFetch() });
  const agents = await bridge.getAgents('proj-a');
  assert.equal(agents.find((a) => a.id === 'coder').role, 'coding');
});

test('getAgents() live path calls GET /api/agents with the project query', async () => {
  const root = makeRoot();
  markLive(root);
  const fetchImpl = makeFetch((url) => {
    assert.match(url, /\/api\/agents\?project=proj-a$/);
    return { status: 200, body: [{ id: 'coder', role: 'coding' }] };
  });
  const bridge = new OrchestratorBridge({ rootDir: root, fetchImpl });
  const agents = await bridge.getAgents('proj-a');
  assert.equal(agents[0].id, 'coder');
  assert.equal(fetchImpl.calls.length, 1);
});

test('getAgentHealth() idle path reports zeroed tallies for the roster', async () => {
  const root = makeRoot();
  defineProject(root, 'proj-a');
  const bridge = new OrchestratorBridge({ rootDir: root, fetchImpl: makeFetch() });
  const health = await bridge.getAgentHealth('proj-a');
  assert.equal(health.length, 1);
  assert.equal(health[0].agentId, 'default');
  assert.equal(health[0].tasksDone, 0);
});

// Phase 11 M4: a cross-product consistency audit found createProject()
// diverged from the CLI's `projects add`, which defaults
// claude.permissionMode to "acceptEdits" (an unattended headless engine
// cannot answer permission prompts, so without it a real mission blocks on
// "no progress" — the exact new-user trap Phase 10.5/11 M1 fixed for the
// CLI path). These pin the fix.
test('createProject() defaults claude.permissionMode to acceptEdits, matching the CLI', async () => {
  const root = makeRoot();
  const workspace = path.join(root, 'workspaces', 'new-proj');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'mission.md'), '# mission');

  const bridge = new OrchestratorBridge({ rootDir: root });
  const result = await bridge.createProject('new-proj', { dir: workspace, promptFile: 'mission.md' });
  assert.ok(result.ok);

  const saved = JSON.parse(fs.readFileSync(result.file, 'utf8'));
  assert.deepEqual(saved.claude, { permissionMode: 'acceptEdits' });
});

test('createProject() leaves claude settings out for a non-claude driver', async () => {
  const root = makeRoot();
  const workspace = path.join(root, 'workspaces', 'mock-proj');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'mission.md'), '# mission');

  const bridge = new OrchestratorBridge({ rootDir: root });
  const result = await bridge.createProject('mock-proj', { dir: workspace, promptFile: 'mission.md', driver: 'mock' });
  assert.ok(result.ok);

  const saved = JSON.parse(fs.readFileSync(result.file, 'utf8'));
  assert.equal(saved.claude, undefined);
});

// ── Phase 12 M3: the desktop as a Core Service client ──────────────────────
//
// The defect this milestone exists to fix: liveness meant `state/heartbeat.json`,
// which ONLY a standalone `ai-orchestrator start` writes. With the Core Service
// supervising workers and answering a phone, the desktop called the machine idle
// and served every panel from stale files.

/** Record a running Core Service, the way daemon.js does. */
function markService(root, { pid = process.pid, port = 4711 } = {}) {
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'daemon.json'), JSON.stringify({
    // `state: 'running'` is what readDaemon() keys on — a record without it is
    // a stopped service, not a running one.
    state: 'running', pid, port, version: '3.0.0', startedAt: new Date().toISOString(),
  }));
}

test('supervisor() sees the Core Service, not just a standalone heartbeat', async () => {
  const root = makeRoot();
  markService(root);

  const bridge = new OrchestratorBridge({ rootDir: root });

  assert.equal(await bridge.supervisor(), 'daemon');
  assert.equal(await bridge.isLive(), true,
    'the whole M3 defect in one assertion: a running service means the API path, not the file path');
});

test('supervisor() still reports a standalone orchestrator when no service runs', async () => {
  const root = makeRoot();
  markLive(root);

  assert.equal(await new OrchestratorBridge({ rootDir: root }).supervisor(), 'standalone');
});

test('supervisor() prefers the service when BOTH are running', async () => {
  // Both can legitimately exist: the service supervises project A while a
  // standalone run holds project B. The service owns the API port, so it is
  // the one an HTTP read must go to.
  const root = makeRoot();
  markLive(root);
  markService(root);

  assert.equal(await new OrchestratorBridge({ rootDir: root }).supervisor(), 'daemon');
});

test('supervisor() ignores a service record whose process is gone', async () => {
  const root = makeRoot();
  markService(root, { pid: 999_999 });

  assert.equal(await new OrchestratorBridge({ rootDir: root }).supervisor(), null,
    'a crashed service must not keep the desktop pointed at a dead port');
});

test('apiBase() uses the port the service actually bound, not the configured one', async () => {
  const root = makeRoot();
  markService(root, { port: 4899 });

  assert.equal(await new OrchestratorBridge({ rootDir: root }).apiBase(), 'http://127.0.0.1:4899');
});

test('startMission() hands the project to the service instead of spawning a rival', async () => {
  const root = makeRoot();
  defineProject(root, 'alpha');
  markService(root);
  const fetchImpl = makeFetch((url) =>
    (url.includes('/api/daemon/missions/start') ? { status: 200, body: { ok: true, pid: 4242 } } : null));

  const result = await new OrchestratorBridge({ rootDir: root, fetchImpl }).startMission('alpha');

  assert.deepEqual(result, { ok: true, pid: 4242 });
  const call = fetchImpl.calls.find((c) => c.url.includes('/api/daemon/missions/start'));
  assert.ok(call, 'the service supervises several projects — a second one is a request it can grant');
  assert.deepEqual(JSON.parse(call.options.body), { project: 'alpha', fresh: false });
});

test('startMission() still refuses while a STANDALONE orchestrator holds the machine', async () => {
  const root = makeRoot();
  defineProject(root, 'alpha');
  markLive(root);

  const result = await new OrchestratorBridge({ rootDir: root }).startMission('alpha');

  assert.equal(result.ok, false);
  assert.match(result.reason, /already running/);
});

test('stopMission() stops ONE project through the service, never the service itself', async () => {
  const root = makeRoot();
  markService(root);
  const fetchImpl = makeFetch(() => ({ status: 200, body: { ok: true, via: 'stop-file' } }));

  const bridge = new OrchestratorBridge({ rootDir: root, fetchImpl });
  const result = await bridge.stopMission('done for now', 'alpha');

  assert.equal(result.ok, true);
  const call = fetchImpl.calls.at(-1);
  assert.match(call.url, /\/api\/daemon\/missions\/stop$/);
  assert.deepEqual(JSON.parse(call.options.body), { project: 'alpha', reason: 'done for now' });
  assert.ok(!fetchImpl.calls.some((c) => c.url.includes('/api/control/stop')),
    '/api/control/stop would take down the phone channel and every other mission');
});

test('stopMission() under the service refuses to guess which mission was meant', async () => {
  const root = makeRoot();
  markService(root);

  const result = await new OrchestratorBridge({ rootDir: root }).stopMission('reason');

  assert.equal(result.ok, false);
  assert.match(result.reason, /say which mission/);
});

test('getRegistry() reads every project from the service in one call', async () => {
  const root = makeRoot();
  markService(root);
  const records = [
    { name: 'alpha', status: 'running', simulated: false },
    { name: 'sandbox', status: 'idle', simulated: true },
  ];
  const fetchImpl = makeFetch((url) => (url.includes('/api/registry') ? { status: 200, body: records } : null));

  const result = await new OrchestratorBridge({ rootDir: root, fetchImpl }).getRegistry();

  assert.equal(result.source, 'daemon');
  assert.deepEqual(result.records, records);
});

test('getRegistry() degrades to local projects when no service is running', async () => {
  const root = makeRoot();
  defineProject(root, 'alpha');

  const result = await new OrchestratorBridge({ rootDir: root }).getRegistry();

  assert.equal(result.source, 'local', 'the Control Center says "no service", not "no projects"');
  assert.deepEqual(result.records, [{ name: 'alpha', simulated: true, status: 'idle' }]);
});

test('getServiceStatus() reports a stopped service as a reason, never as a crash', async () => {
  const root = makeRoot();

  const status = await new OrchestratorBridge({ rootDir: root }).getServiceStatus();

  assert.equal(status.running, false);
  assert.match(status.reason, /not running/);
});

test('getServiceStatus() returns the live report when the service answers', async () => {
  const root = makeRoot();
  markService(root);
  const report = { pid: process.pid, version: '3.0.0', uptimeMs: 1000, workers: 2, telegramInbound: true };
  const fetchImpl = makeFetch((url) => (url.endsWith('/api/daemon') ? { status: 200, body: report } : null));

  const status = await new OrchestratorBridge({ rootDir: root, fetchImpl }).getServiceStatus();

  assert.equal(status.running, true);
  assert.equal(status.workers, 2);
  assert.equal(status.telegramInbound, true);
});

test('getServiceStatus() distinguishes a crashed service from a stopped one', async () => {
  const root = makeRoot();
  markService(root, { pid: 999_999 });

  const status = await new OrchestratorBridge({ rootDir: root }).getServiceStatus();

  assert.equal(status.running, false);
  assert.equal(status.stale, true, 'crashed and never-started need different remedies');
});

test('getServiceStatus() normalizes the worker LIST into a count', async () => {
  // `/api/daemon` returns the workers themselves; every consumer wants "how
  // many". Normalized once here rather than in each view — a count rendered as
  // "[]" is what a UI does when two layers disagree about a field's type.
  const root = makeRoot();
  markService(root);
  const workers = [{ project: 'alpha', pid: 1 }, { project: 'beta', pid: 2 }];
  const fetchImpl = makeFetch((url) =>
    (url.endsWith('/api/daemon') ? { status: 200, body: { pid: 1, workers, maxWorkers: 3 } } : null));

  const status = await new OrchestratorBridge({ rootDir: root, fetchImpl }).getServiceStatus();

  assert.equal(status.workers, 2);
  assert.deepEqual(status.workerList, workers);
});

test('getServiceStatus() answers the reboot question even while the service is down', async () => {
  // Bug 1 (M2.1) stayed invisible because every surface that could have
  // reported it needed the very thing it was reporting on. Autostart is a
  // Task Scheduler fact, so it is answered locally, service or no service.
  const root = makeRoot();

  const status = await new OrchestratorBridge({ rootDir: root }).getServiceStatus();

  assert.equal(status.running, false);
  assert.ok(status.autostart, 'the desktop must still be able to say whether it will come back');
  assert.equal(typeof status.autostart.installed, 'boolean');
});

test('getAllApprovals() gathers every project\'s pending decisions with its badge', async () => {
  const root = makeRoot();
  defineProject(root, 'sandbox');                  // mock driver ⇒ simulated
  defineProject(root, 'real', { driver: 'claude' });
  const approvalsDir = path.join(root, 'state', 'approvals');
  fs.mkdirSync(approvalsDir, { recursive: true });
  fs.writeFileSync(path.join(approvalsDir, 'sandbox.json'), JSON.stringify({
    project: 'sandbox',
    requests: [{ id: 'A1', project: 'sandbox', title: 'Plan review', status: 'pending' }],
  }));
  fs.writeFileSync(path.join(approvalsDir, 'real.json'), JSON.stringify({
    project: 'real',
    requests: [
      { id: 'A2', project: 'real', title: 'Plan review', status: 'pending' },
      { id: 'A3', project: 'real', title: 'Old one', status: 'approved' },
    ],
  }));

  const pending = await new OrchestratorBridge({ rootDir: root }).getAllApprovals();

  assert.deepEqual(pending.map((r) => r.id).sort(), ['A1', 'A2'], 'decided requests are not waiting');
  assert.equal(pending.find((r) => r.id === 'A1').simulated, true);
  assert.equal(pending.find((r) => r.id === 'A2').simulated, false);
});

test('isProjectLive() answers per-project under the service, not machine-wide', async () => {
  // The regression this pins: Missions tab gated Start/Stop on getHealth(),
  // which under the service is true for the whole machine the instant ANY
  // project has a worker. That would show every idle project as running.
  const root = makeRoot();
  markService(root);
  const fetchImpl = makeFetch((url) =>
    (url.endsWith('/api/daemon/workers')
      ? { status: 200, body: [{ project: 'alpha', pid: 1, alive: true }] }
      : null));

  const bridge = new OrchestratorBridge({ rootDir: root, fetchImpl });

  assert.equal(await bridge.isProjectLive('alpha'), true);
  assert.equal(await bridge.isProjectLive('beta'), false,
    'a second, idle project must not read as running just because alpha has a worker');
});

test('isProjectLive() falls back to the standalone heartbeat, matched by project', async () => {
  const root = makeRoot();
  markLive(root, { pid: process.pid });
  const stateDir = path.join(root, 'state');
  fs.writeFileSync(path.join(stateDir, 'heartbeat.json'), JSON.stringify({
    state: 'running', pid: process.pid, project: 'alpha',
  }));

  const bridge = new OrchestratorBridge({ rootDir: root });

  assert.equal(await bridge.isProjectLive('alpha'), true);
  assert.equal(await bridge.isProjectLive('beta'), false,
    'a standalone orchestrator supervises ONE project — it must not read as live for another');
});

test('isProjectLive() is false for no project name', async () => {
  const root = makeRoot();
  markService(root);
  assert.equal(await new OrchestratorBridge({ rootDir: root }).isProjectLive(''), false);
  assert.equal(await new OrchestratorBridge({ rootDir: root }).isProjectLive(undefined), false);
});
