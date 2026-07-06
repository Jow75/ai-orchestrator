/**
 * Integration tests for the Phase P7 dashboard API mutating endpoints:
 * real HTTP requests against a real (ephemeral-port) DashboardServer,
 * backed by real TaskQueue/MemoryStore instances on temp dirs — proving
 * the auth gate and the mutations actually take effect on disk, not just
 * that the handler functions are wired up.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DashboardServer } from '../src/api/dashboardServer.js';
import { SessionManager } from '../src/state/sessionManager.js';
import { StatusManager } from '../src/state/statusManager.js';
import { TaskQueue } from '../src/mission/taskQueue.js';
import { MemoryStore } from '../src/memory/memoryStore.js';
import { TaskState } from '../src/mission/taskState.js';
import { silentLogger } from '../src/infra/logger.js';

const TOKEN = 'test-token-123';

async function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-api-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'task.md'), '# a task');

  const project = { name: 'apiproj', driver: 'mock', workingDirectory: workspace, tasks: [] };
  const stateDir = path.join(root, 'state');
  const taskQueue = new TaskQueue({ tasksDir: path.join(stateDir, 'tasks'), logger: silentLogger });
  const memoryStore = new MemoryStore({ memoryDir: path.join(stateDir, 'memory'), logger: silentLogger });
  const sessionManager = new SessionManager({ sessionsDir: path.join(stateDir, 'sessions'), logger: silentLogger });
  const statusManager = new StatusManager({ statusFile: path.join(stateDir, 'status.json'), logger: silentLogger });

  const stopCalls = [];
  const orchestrator = { stop: async (reason) => { stopCalls.push(reason); } };

  const dashboard = new DashboardServer({
    config: { enabled: true, host: '127.0.0.1', port: 0 },
    logger: silentLogger,
    statusManager,
    sessionManager,
    configManager: { getProject: () => project, listProjects: () => [project.name] },
    timeline: null,
    taskQueue,
    memoryStore,
    orchestrator,
    apiToken: TOKEN,
  });
  await dashboard.start();
  const port = dashboard.server.address().port;
  const base = `http://127.0.0.1:${port}`;

  return { workspace, project, taskQueue, memoryStore, dashboard, base, stopCalls };
}

async function post(base, path_, body, token = TOKEN) {
  const res = await fetch(`${base}${path_}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json() };
}

test('GET /api/health requires no auth', async () => {
  const { dashboard, base } = await harness();
  try {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
  } finally {
    await dashboard.stop();
  }
});

test('a mutating endpoint 401s without the token', async () => {
  const { dashboard, base } = await harness();
  try {
    const { status } = await post(base, '/api/control/stop', {}, null);
    assert.equal(status, 401);
  } finally {
    await dashboard.stop();
  }
});

test('POST /api/control/stop calls the live orchestrator\'s stop()', async () => {
  const { dashboard, base, stopCalls } = await harness();
  try {
    const { status, body } = await post(base, '/api/control/stop', { reason: 'operator requested via API' });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(stopCalls, ['operator requested via API']);
  } finally {
    await dashboard.stop();
  }
});

test('POST /api/tasks/:project/add enqueues a validated task', async () => {
  const { dashboard, base, taskQueue } = await harness();
  try {
    const { status, body } = await post(base, '/api/tasks/apiproj/add', {
      id: 'T1', prompt: 'task.md', objective: 'do the thing',
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    const queue = taskQueue.load('apiproj');
    assert.equal(queue.tasks[0].id, 'T1');
  } finally {
    await dashboard.stop();
  }
});

test('POST /api/tasks/:project/add rejects an invalid task with problems', async () => {
  const { dashboard, base } = await harness();
  try {
    const { status, body } = await post(base, '/api/tasks/apiproj/add', { id: 'T1' }); // no prompt
    assert.equal(status, 400);
    assert.equal(body.ok, false);
    assert.ok(body.problems.length > 0);
  } finally {
    await dashboard.stop();
  }
});

test('POST /api/tasks/:project/remove removes a PENDING task', async () => {
  const { dashboard, base, taskQueue, workspace } = await harness();
  try {
    let queue = taskQueue.ensure('apiproj');
    queue = taskQueue.enqueue(queue, { id: 'T1', resolvedPromptFile: path.join(workspace, 'task.md'), verify: [], maxRuns: 5 });

    const { status, body } = await post(base, '/api/tasks/apiproj/remove', { taskId: 'T1' });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(taskQueue.load('apiproj').tasks.length, 0);
  } finally {
    await dashboard.stop();
  }
});

test('POST /api/tasks/:project/reorder moves a pending task', async () => {
  const { dashboard, base, taskQueue, workspace } = await harness();
  try {
    let queue = taskQueue.ensure('apiproj');
    queue = taskQueue.enqueue(queue, { id: 'A', resolvedPromptFile: path.join(workspace, 'task.md'), verify: [], maxRuns: 5 });
    queue = taskQueue.enqueue(queue, { id: 'B', resolvedPromptFile: path.join(workspace, 'task.md'), verify: [], maxRuns: 5 });

    const { status, body } = await post(base, '/api/tasks/apiproj/reorder', { taskId: 'B', direction: 'up' });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(taskQueue.load('apiproj').tasks[0].id, 'B');
  } finally {
    await dashboard.stop();
  }
});

test('POST /api/tasks/:project/approve resets a BLOCKED current task to PENDING', async () => {
  const { dashboard, base, taskQueue, workspace } = await harness();
  try {
    let queue = taskQueue.ensure('apiproj');
    queue = taskQueue.enqueue(queue, { id: 'T1', resolvedPromptFile: path.join(workspace, 'task.md'), verify: [], maxRuns: 1 });
    queue = taskQueue.recordAttempt(queue);
    queue = taskQueue.markBlocked(queue, { summary: 'stuck' });

    const { status, body } = await post(base, '/api/tasks/apiproj/approve', { taskId: 'T1' });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(taskQueue.load('apiproj').tasks[0].state, TaskState.PENDING);
  } finally {
    await dashboard.stop();
  }
});

test('POST /api/tasks/:project/skip marks a FAILED current task done and advances', async () => {
  const { dashboard, base, taskQueue, workspace } = await harness();
  try {
    let queue = taskQueue.ensure('apiproj');
    queue = taskQueue.enqueue(queue, { id: 'T1', resolvedPromptFile: path.join(workspace, 'task.md'), verify: [], maxRuns: 1 });
    queue = taskQueue.enqueue(queue, { id: 'T2', resolvedPromptFile: path.join(workspace, 'task.md'), verify: [], maxRuns: 1 });
    queue = taskQueue.recordAttempt(queue);
    queue = taskQueue.markFailed(queue, { summary: 'gave up' });

    const { status, body } = await post(base, '/api/tasks/apiproj/skip', { taskId: 'T1', reason: 'confirmed fine manually' });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    const reloaded = taskQueue.load('apiproj');
    assert.equal(reloaded.tasks[0].state, TaskState.DONE);
    assert.equal(reloaded.currentIndex, 1);
  } finally {
    await dashboard.stop();
  }
});

test('POST /api/memory/:project/notes records a note visible via GET /api/memory/:project', async () => {
  const { dashboard, base } = await harness();
  try {
    const { status } = await post(base, '/api/memory/apiproj/notes', { category: 'architecture', text: 'build via npm run build' });
    assert.equal(status, 200);

    const res = await fetch(`${base}/api/memory/apiproj`);
    const mem = await res.json();
    assert.equal(mem.notes[0].text, 'build via npm run build');
  } finally {
    await dashboard.stop();
  }
});

test('POST /api/memory/:project/failures/:id/resolve resolves a recorded failure', async () => {
  const { dashboard, base, memoryStore } = await harness();
  try {
    memoryStore.recordFailure('apiproj', { category: 'x', reason: 'something broke' });
    const failureId = memoryStore.load('apiproj').failures[0].id;

    const { status, body } = await post(base, `/api/memory/apiproj/failures/${failureId}/resolve`, {});
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(memoryStore.load('apiproj').failures[0].resolved, true);
  } finally {
    await dashboard.stop();
  }
});
