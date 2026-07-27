/**
 * Phase 12 M1 — App worker mode, and the Phase 12 Invariant.
 *
 * Worker mode withdraws exactly four machine-singleton responsibilities and
 * changes nothing else. The tests below pin both halves of that claim:
 *
 *   - what a worker does differently (project claim instead of machine lock,
 *     no inbound Telegram, no heartbeat write on shutdown);
 *   - THE PHASE 12 INVARIANT: with no daemon and no workers, a standalone App
 *     behaves exactly as it did in v2.7.0.
 *
 * The invariant test is the most important one in this file. It is the reason
 * a process-model change can ship without a compatibility break.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import App from '../src/app.js';
import { WorkerRegistry } from '../src/daemon/workerRegistry.js';
import { writeJsonAtomic, readJsonSafe } from '../src/state/statePersistence.js';
import { silentLogger } from '../src/infra/logger.js';

const DEAD_PID = 0x7ffffff0;

/** A throwaway installation root with quiet logging. */
function installation() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-app-worker-'));
  fs.mkdirSync(path.join(root, 'config', 'projects'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'config', 'orchestrator.json'),
    // file:true keeps winston quiet (no-transport warnings) while writing only
    // into this throwaway root; console:false keeps the test output readable.
    JSON.stringify({ logging: { console: false, file: true }, api: { enabled: false } }),
    'utf8'
  );
  return root;
}

function registryFor(app) {
  return new WorkerRegistry({ workersDir: app.paths.workersDir, logger: silentLogger });
}

test('worker mode is opt-in; the default App is unchanged', () => {
  const root = installation();
  const standalone = new App({ rootDir: root });
  const worker = new App({ rootDir: root, worker: true });

  assert.equal(standalone.workerMode, false);
  assert.equal(worker.workerMode, true);
});

test('a worker never receives inbound approvals; a standalone App always does', () => {
  const root = installation();

  assert.equal(
    new App({ rootDir: root }).approvalManager.receiveDecisions, true,
    'the pre-Phase-12 behaviour is the default'
  );
  assert.equal(
    new App({ rootDir: root, worker: true }).approvalManager.receiveDecisions, false,
    'the daemon owns the offset-stateful channel instead'
  );
});

test('claiming a project records this process as its supervisor', () => {
  const app = new App({ rootDir: installation(), worker: true });
  const recovered = app.claimProjectAsWorker('finisher');

  assert.equal(recovered, undefined, 'a first claim is not a recovery');
  const record = registryFor(app).read('finisher');
  assert.equal(record.pid, process.pid);
  assert.equal(record.mode, 'worker');
  assert.equal(app.registeredProject, 'finisher');
});

test('claiming a project another live worker holds is refused', () => {
  const app = new App({ rootDir: installation(), worker: true });
  registryFor(app).register('finisher', { pid: process.pid });

  assert.throws(
    () => app.claimProjectAsWorker('finisher'),
    /already supervised by worker pid/
  );
});

test('a stale claim from a killed worker is recovered, not refused', () => {
  const app = new App({ rootDir: installation(), worker: true });
  registryFor(app).register('finisher', { pid: DEAD_PID });

  const recovered = app.claimProjectAsWorker('finisher');

  assert.equal(recovered, 'worker-crash', 'the mission resumes instead of being blocked forever');
  assert.equal(registryFor(app).read('finisher').pid, process.pid, 'and the claim transfers');
});

test('a worker refuses to start alongside a live standalone orchestrator', () => {
  const app = new App({ rootDir: installation(), worker: true });
  writeJsonAtomic(app.paths.heartbeatFile, { state: 'running', pid: process.pid });

  assert.throws(
    () => app.claimProjectAsWorker('finisher'),
    /standalone orchestrator .* is already supervising/
  );
});

test('a STALE standalone heartbeat does not block a worker', () => {
  const app = new App({ rootDir: installation(), worker: true });
  writeJsonAtomic(app.paths.heartbeatFile, { state: 'running', pid: DEAD_PID });

  assert.doesNotThrow(() => app.claimProjectAsWorker('finisher'));
});

test('worker shutdown releases the project and never writes the machine heartbeat', async () => {
  const app = new App({ rootDir: installation(), worker: true });
  app.claimProjectAsWorker('finisher');
  assert.ok(registryFor(app).holderOf('finisher'));

  await app.shutdown();

  assert.equal(registryFor(app).read('finisher'), null, 'the project is released');
  assert.equal(
    readJsonSafe(app.paths.heartbeatFile), null,
    'heartbeat.json is the standalone lock — a worker must never stamp it'
  );
});

test('standalone start refuses a project the Core Service is supervising', async () => {
  const root = installation();
  fs.writeFileSync(
    path.join(root, 'config', 'projects', 'finisher.json'),
    JSON.stringify({ driver: 'mock', workingDirectory: root, promptFile: 'p.md' }),
    'utf8'
  );
  fs.writeFileSync(path.join(root, 'p.md'), 'do the thing', 'utf8');

  const standalone = new App({ rootDir: root });
  registryFor(standalone).register('finisher', { pid: process.pid });

  await assert.rejects(
    () => standalone.startSingle({ projectName: 'finisher' }),
    /already supervised by the Core Service/
  );
});

test('a worker watches its OWN stop file and acts on it gracefully', async () => {
  const app = new App({ rootDir: installation(), worker: true });
  app.claimProjectAsWorker('finisher');

  const stopped = [];
  app.stopAll = async (reason) => { stopped.push(reason); };
  app.watchWorkerStopFile('finisher');

  registryFor(app).requestStop('finisher', 'operator asked');
  await new Promise((resolve) => setTimeout(resolve, 5_500)); // one poll tick

  assert.deepEqual(stopped, ['operator asked'], 'the worker stopped itself, gracefully');
  assert.equal(
    registryFor(app).readStopRequest('finisher'), null,
    'the request is consumed so it cannot stop the next mission too'
  );
  clearInterval(app.stopFileTimer);
});

test('a worker never inherits a stop request left over from a previous mission', () => {
  const app = new App({ rootDir: installation(), worker: true });
  registryFor(app).requestStop('finisher', 'stale request from last time');

  app.watchWorkerStopFile('finisher');

  assert.equal(
    registryFor(app).readStopRequest('finisher'), null,
    'a stale request would otherwise kill the mission the instant it started'
  );
  clearInterval(app.stopFileTimer);
});

// ── THE PHASE 12 INVARIANT ────────────────────────────────────────────────

test('INVARIANT: with no daemon and no workers, standalone start is unchanged', async () => {
  const root = installation();
  const app = new App({ rootDir: root });

  // The v2.7.0 behaviour: a live machine heartbeat refuses a second launch,
  // with the same message operators have seen since P0.
  writeJsonAtomic(app.paths.heartbeatFile, { state: 'running', pid: process.pid });
  await assert.rejects(
    () => app.startSingle({ projectName: 'anything' }),
    /Another AI-Orchestrator instance is already running/
  );
});

test('INVARIANT: an empty worker registry costs nothing and blocks nothing', async () => {
  const root = installation();
  const app = new App({ rootDir: root });

  // No workers dir contents, no daemon record: the added exclusion check must
  // be invisible, and the failure that surfaces is the ORIGINAL one.
  await assert.rejects(
    () => app.startSingle({}),
    /No project specified and no default configured/
  );
});
