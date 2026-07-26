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

function defineProject(root, name) {
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
    JSON.stringify({ driver: 'mock', workingDirectory: workspace, promptFile: 'mission.md' }, null, 2)
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
    [{ name: 'proj-a', hasActiveSession: true }, { name: 'proj-b', hasActiveSession: false }]
  );
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
