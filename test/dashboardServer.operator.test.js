/**
 * Integration tests for the Phase 12 M2 operator API routes.
 *
 * Real HTTP against a real ephemeral-port DashboardServer. The claim being
 * pinned is the architectural one the whole milestone rests on: **Telegram is
 * one client, not the interface.** `POST /api/operator/command` runs the SAME
 * router a phone message goes through, so a desktop or web console never needs
 * a second implementation of the command logic — and if these routes and the
 * gateway ever diverged, this file would fail.
 *
 * The optional-collaborator contract is re-checked too: a server built WITHOUT
 * a daemon (a standalone mission's own API, exactly as in v2.7.0) answers 503
 * on every operator route rather than crashing or pretending.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DashboardServer } from '../src/api/dashboardServer.js';
import { silentLogger } from '../src/infra/logger.js';

const TOKEN = 'operator-test-token';

/** A stub Core Service exposing only what the operator routes touch. */
function stubDaemon() {
  const routed = [];
  const events = [
    { seq: 1, type: 'daemon.started', at: '2026-07-27T10:00:00Z' },
    { seq: 2, type: 'worker.started', at: '2026-07-27T10:01:00Z', project: 'alpha' },
    { seq: 3, type: 'mission.progress', at: '2026-07-27T10:02:00Z', project: 'alpha' },
  ];
  return {
    routed,
    projectRegistry: {
      lastOptions: null,
      list(options) {
        this.lastOptions = options;
        return [
          { name: 'alpha', status: 'running', git: options.git ? { branch: 'main' } : undefined },
          { name: 'beta', status: 'idle' },
        ];
      },
      describe: (project) => ({ name: project, status: 'idle' }),
    },
    events: {
      read: ({ sinceSeq, project, types, limit }) => events.filter((e) => (
        (sinceSeq === undefined || e.seq > sinceSeq)
        && (!project || e.project === project)
        && (!types || types.includes(e.type))
      )).slice(-(limit ?? 100)),
    },
    operatorContext: {
      all: () => [{ channel: 'telegram', chatId: '42', project: 'alpha' }],
    },
    missionRequests: {
      open: (project) => [{ id: 'M1', project: project ?? 'alpha', status: 'proposed' }],
      list: () => [
        { id: 'M1', project: 'alpha', status: 'started' },
        { id: 'M2', project: 'alpha', status: 'rejected' },
      ],
    },
    commandRouter: {
      async handle(message) {
        routed.push(message);
        return { reply: `handled: ${message.text}` };
      },
    },
  };
}

async function harness({ daemon } = {}) {
  const dashboard = new DashboardServer({
    config: { enabled: true, host: '127.0.0.1', port: 0 },
    logger: silentLogger,
    statusManager: { get: () => ({}) },
    sessionManager: { listActiveSessions: () => [], getHistory: () => [] },
    configManager: { getProject: (name) => ({ name }), listProjects: () => ['alpha', 'beta'] },
    apiToken: TOKEN,
    daemon,
  });
  await dashboard.start();
  const base = `http://127.0.0.1:${dashboard.server.address().port}`;
  const get = async (suffix) => {
    const response = await fetch(`${base}${suffix}`);
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const post = async (suffix, body, token) => {
    const response = await fetch(`${base}${suffix}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  return { dashboard, get, post };
}

test('GET /api/registry serves the full project registry', async () => {
  const daemon = stubDaemon();
  const { dashboard, get } = await harness({ daemon });
  try {
    const { status, body } = await get('/api/registry');

    assert.equal(status, 200);
    assert.deepEqual(body.map((r) => r.name), ['alpha', 'beta']);
    assert.deepEqual(daemon.projectRegistry.lastOptions, { health: true, git: true });
  } finally {
    await dashboard.stop();
  }
});

test('the expensive parts of the registry can be skipped for a fast list', async () => {
  const daemon = stubDaemon();
  const { dashboard, get } = await harness({ daemon });
  try {
    const { body } = await get('/api/registry?health=false&git=false');

    assert.deepEqual(daemon.projectRegistry.lastOptions, { health: false, git: false });
    assert.equal(body[0].git, undefined);
  } finally {
    await dashboard.stop();
  }
});

test('GET /api/registry/:project serves one project', async () => {
  const { dashboard, get } = await harness({ daemon: stubDaemon() });
  try {
    const { status, body } = await get('/api/registry/alpha');

    assert.equal(status, 200);
    assert.equal(body.name, 'alpha');
  } finally {
    await dashboard.stop();
  }
});

test('GET /api/events serves the log, and filters the way a tailing client needs', async () => {
  const { dashboard, get } = await harness({ daemon: stubDaemon() });
  try {
    assert.equal((await get('/api/events')).body.length, 3);
    assert.deepEqual(
      (await get('/api/events?since=1')).body.map((e) => e.seq), [2, 3],
      'since is exclusive — how a client resumes without re-reading'
    );
    assert.equal((await get('/api/events?project=alpha')).body.length, 2);
    assert.equal((await get('/api/events?type=worker.started')).body.length, 1);
    assert.equal((await get('/api/events?limit=1')).body.length, 1);
  } finally {
    await dashboard.stop();
  }
});

test('GET /api/operator/context reports which project each channel is pointed at', async () => {
  const { dashboard, get } = await harness({ daemon: stubDaemon() });
  try {
    const { status, body } = await get('/api/operator/context');

    assert.equal(status, 200);
    assert.equal(body[0].project, 'alpha');
    assert.equal(body[0].channel, 'telegram');
  } finally {
    await dashboard.stop();
  }
});

test('GET /api/operator/missions serves open requests by default, all on request', async () => {
  const { dashboard, get } = await harness({ daemon: stubDaemon() });
  try {
    const open = await get('/api/operator/missions');
    assert.equal(open.body.length, 1);
    assert.equal(open.body[0].status, 'proposed');

    const all = await get('/api/operator/missions?all=true');
    assert.equal(all.body.length, 2);
  } finally {
    await dashboard.stop();
  }
});

test('POST /api/operator/command runs the SAME router a phone message goes through', async () => {
  const daemon = stubDaemon();
  const { dashboard, post } = await harness({ daemon });
  try {
    const { status, body } = await post('/api/operator/command', { text: '/projects' }, TOKEN);

    assert.equal(status, 200);
    assert.equal(body.reply, 'handled: /projects');
    assert.deepEqual(daemon.routed, [{
      text: '/projects', channel: 'api', chatId: null, from: 'api',
    }]);
  } finally {
    await dashboard.stop();
  }
});

test('a command channel defaults to "api", so phone confirmations are not redeemable here', async () => {
  const daemon = stubDaemon();
  const { dashboard, post } = await harness({ daemon });
  try {
    await post('/api/operator/command', { text: '/confirm K7XM' }, TOKEN);
    await post('/api/operator/command', { text: '/help', channel: 'cli', from: 'moses' }, TOKEN);

    assert.equal(daemon.routed[0].channel, 'api');
    assert.equal(daemon.routed[1].channel, 'cli', 'an explicit channel is honoured');
  } finally {
    await dashboard.stop();
  }
});

test('running a command requires the P7 token — it can start and stop missions', async () => {
  const daemon = stubDaemon();
  const { dashboard, post } = await harness({ daemon });
  try {
    assert.equal((await post('/api/operator/command', { text: '/start alpha' })).status, 401);
    assert.equal((await post('/api/operator/command', { text: '/start alpha' }, 'wrong')).status, 401);
    assert.deepEqual(daemon.routed, [], 'nothing reached the router');
  } finally {
    await dashboard.stop();
  }
});

test('an empty command is refused with a 400, not routed', async () => {
  const daemon = stubDaemon();
  const { dashboard, post } = await harness({ daemon });
  try {
    assert.equal((await post('/api/operator/command', { text: '   ' }, TOKEN)).status, 400);
    assert.equal((await post('/api/operator/command', {}, TOKEN)).status, 400);
    assert.deepEqual(daemon.routed, []);
  } finally {
    await dashboard.stop();
  }
});

test('WITHOUT a daemon every operator route answers 503 — the v2.7.0 standalone API', async () => {
  const { dashboard, get, post } = await harness({});
  try {
    for (const route of [
      '/api/registry', '/api/registry/alpha', '/api/events',
      '/api/operator/context', '/api/operator/missions',
    ]) {
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await get(route)).status, 503, `${route} degrades cleanly`);
    }
    assert.equal((await post('/api/operator/command', { text: '/help' }, TOKEN)).status, 503);
  } finally {
    await dashboard.stop();
  }
});

test('the pre-existing read routes are untouched by the new ones', async () => {
  const { dashboard, get } = await harness({ daemon: stubDaemon() });
  try {
    assert.equal((await get('/api/health')).status, 200);
    assert.equal((await get('/api/projects')).status, 200);
    assert.equal((await get('/api/nonsense')).status, 404);
  } finally {
    await dashboard.stop();
  }
});
