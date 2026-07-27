/**
 * Integration tests for the Phase 12 M1 Core Service API routes.
 *
 * Real HTTP against a real ephemeral-port DashboardServer, with a stub daemon
 * standing in for the service. Two things are being pinned:
 *
 *  1. The optional-collaborator contract: a server built WITHOUT a daemon
 *     (i.e. a standalone mission's own API, exactly as in v2.7.0) answers
 *     503 on every /api/daemon route instead of crashing or pretending.
 *  2. Mission control actually reaches the supervisor, and mutations stay
 *     behind the P7 token while reads stay open — unchanged since P0.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DashboardServer } from '../src/api/dashboardServer.js';
import { silentLogger } from '../src/infra/logger.js';

const TOKEN = 'daemon-test-token';

/** A stub Core Service exposing only what the routes touch. */
function stubDaemon() {
  const calls = { started: [], stopped: [] };
  const workers = [{ project: 'finisher', pid: 4242, attached: true, state: 'running' }];
  return {
    calls,
    workers,
    supervisor: {
      list: () => workers,
      start(project, options) {
        calls.started.push({ project, options });
        if (project === 'busy') return { ok: false, reason: 'Project "busy" is already being supervised (pid 1).' };
        return { ok: true, project, pid: 5150 };
      },
      stop(project, options) {
        calls.stopped.push({ project, options });
        if (project === 'idle') return { ok: false, reason: 'No mission is running for "idle".' };
        return { ok: true, via: 'ipc' };
      },
    },
    statusReport: () => ({
      running: true, pid: 999, version: 'test', uptimeMs: 1000, port: 4711,
      telegramInbound: true, maxWorkers: 3, workers, pendingApprovals: 0,
      projects: ['finisher', 'calculator'], host: { hostname: 'test-host' },
    }),
  };
}

async function harness({ daemon } = {}) {
  const knownProjects = new Set(['finisher', 'calculator', 'busy', 'idle']);
  const dashboard = new DashboardServer({
    config: { enabled: true, host: '127.0.0.1', port: 0 },
    logger: silentLogger,
    statusManager: { get: () => ({}) },
    sessionManager: { listActiveSessions: () => [], getHistory: () => [] },
    configManager: {
      getProject: (name) => {
        if (!knownProjects.has(name)) throw new Error(`Project "${name}" not found`);
        return { name };
      },
      listProjects: () => [...knownProjects],
    },
    apiToken: TOKEN,
    daemon,
  });
  await dashboard.start();
  const base = `http://127.0.0.1:${dashboard.server.address().port}`;
  return { dashboard, base };
}

async function post(base, route, body, token = TOKEN) {
  const res = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json() };
}

test('GET /api/daemon reports the service and needs no auth', async () => {
  const { dashboard, base } = await harness({ daemon: stubDaemon() });
  try {
    const res = await fetch(`${base}/api/daemon`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.running, true);
    assert.equal(body.telegramInbound, true);
    assert.equal(body.workers.length, 1);
  } finally {
    await dashboard.stop();
  }
});

test('GET /api/daemon/workers lists supervised missions', async () => {
  const { dashboard, base } = await harness({ daemon: stubDaemon() });
  try {
    const body = await (await fetch(`${base}/api/daemon/workers`)).json();
    assert.equal(body[0].project, 'finisher');
    assert.equal(body[0].pid, 4242);
  } finally {
    await dashboard.stop();
  }
});

test('without a daemon every /api/daemon route 503s cleanly (a standalone mission API)', async () => {
  const { dashboard, base } = await harness({ daemon: undefined });
  try {
    const status = await fetch(`${base}/api/daemon`);
    assert.equal(status.status, 503);
    assert.equal((await status.json()).running, false);

    assert.equal((await fetch(`${base}/api/daemon/workers`)).status, 503);
    assert.equal((await post(base, '/api/daemon/missions/start', { project: 'finisher' })).status, 503);
    assert.equal((await post(base, '/api/daemon/missions/stop', { project: 'finisher' })).status, 503);

    // And the rest of the API is entirely unaffected.
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
  } finally {
    await dashboard.stop();
  }
});

test('POST /api/daemon/missions/start requires the token', async () => {
  const { dashboard, base } = await harness({ daemon: stubDaemon() });
  try {
    const result = await post(base, '/api/daemon/missions/start', { project: 'finisher' }, null);
    assert.equal(result.status, 401);
  } finally {
    await dashboard.stop();
  }
});

test('POST /api/daemon/missions/start reaches the supervisor', async () => {
  const daemon = stubDaemon();
  const { dashboard, base } = await harness({ daemon });
  try {
    const result = await post(base, '/api/daemon/missions/start', { project: 'calculator', fresh: true });
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.pid, 5150);
    assert.deepEqual(daemon.calls.started, [{ project: 'calculator', options: { fresh: true } }]);
  } finally {
    await dashboard.stop();
  }
});

test('starting an unknown project is a 404, not a spawn attempt', async () => {
  const daemon = stubDaemon();
  const { dashboard, base } = await harness({ daemon });
  try {
    const result = await post(base, '/api/daemon/missions/start', { project: 'nope' });
    assert.equal(result.status, 404);
    assert.equal(daemon.calls.started.length, 0, 'validation happens before any process is spawned');
  } finally {
    await dashboard.stop();
  }
});

test('starting without a project name is a 400', async () => {
  const { dashboard, base } = await harness({ daemon: stubDaemon() });
  try {
    const result = await post(base, '/api/daemon/missions/start', {});
    assert.equal(result.status, 400);
    assert.match(result.body.reason, /"project" is required/);
  } finally {
    await dashboard.stop();
  }
});

test('a conflicting start is a 409 carrying the supervisor’s reason', async () => {
  const { dashboard, base } = await harness({ daemon: stubDaemon() });
  try {
    const result = await post(base, '/api/daemon/missions/start', { project: 'busy' });
    assert.equal(result.status, 409);
    assert.match(result.body.reason, /already being supervised/);
  } finally {
    await dashboard.stop();
  }
});

test('POST /api/daemon/missions/stop reaches the supervisor and 404s when idle', async () => {
  const daemon = stubDaemon();
  const { dashboard, base } = await harness({ daemon });
  try {
    const stopped = await post(base, '/api/daemon/missions/stop', { project: 'finisher', reason: 'because' });
    assert.equal(stopped.status, 200);
    assert.equal(stopped.body.via, 'ipc');
    assert.equal(daemon.calls.stopped[0].options.reason, 'because');

    const idle = await post(base, '/api/daemon/missions/stop', { project: 'idle' });
    assert.equal(idle.status, 404);
  } finally {
    await dashboard.stop();
  }
});
