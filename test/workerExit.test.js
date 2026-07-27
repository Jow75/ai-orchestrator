/**
 * Phase 12 M2 — a finished mission worker must actually LEAVE.
 *
 * This is the regression test for a defect Phase 12 M2's live validation found
 * in M1 code: a worker that completed its mission cleanly stayed resident
 * forever. It archived its session, released its project claim, logged "shut
 * down cleanly" — and kept running, because the IPC channel `fork` gives every
 * worker is a live libuv handle, and an open handle means the event loop never
 * drains.
 *
 * The consequences were worse than a leaked process: with no `exit` event, the
 * daemon never recorded `worker.completed`, so the event log — the thing every
 * M2 interface reads — showed missions that started and never ended.
 *
 * M1's own live pass missed it because the worker it watched exited with code
 * 1. A throwing process terminates whatever handles are open; only a mission
 * that SUCCEEDS reaches the clean shutdown path. So this test insists on the
 * successful case, in a real forked child with a real IPC channel — the only
 * arrangement in which the bug exists at all. A unit test on the shutdown
 * method would have passed against the broken code.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WorkerRegistry } from '../src/daemon/workerRegistry.js';
import { silentLogger } from '../src/infra/logger.js';

const APP_URL = pathToFileURL(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app.js')
).href;

/** How long a worker gets to finish a 50 ms mock mission and exit. */
const EXIT_TIMEOUT_MS = 25_000;

/**
 * A throwaway installation with one mock-driver project that completes on its
 * first run, plus the child entry point that runs it in worker mode.
 */
function installation() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-worker-exit-'));
  const workingDirectory = path.join(root, 'work');
  fs.mkdirSync(path.join(root, 'config', 'projects'), { recursive: true });
  fs.mkdirSync(workingDirectory, { recursive: true });
  fs.writeFileSync(path.join(workingDirectory, 'prompt.md'), 'do the thing\n');
  fs.writeFileSync(
    path.join(root, 'config', 'orchestrator.json'),
    JSON.stringify({
      logging: { console: false, file: true },
      api: { enabled: false },
      progress: { interRunDelayMs: 0 },
    })
  );
  fs.writeFileSync(
    path.join(root, 'config', 'projects', 'demo.json'),
    JSON.stringify({
      driver: 'mock',
      workingDirectory,
      promptFile: 'prompt.md',
      mock: { runs: [{ output: 'work done\nMISSION COMPLETE\n', result: 'MISSION COMPLETE', exitCode: 0, delayMs: 20 }] },
    })
  );

  // The child: exactly what `start demo --worker` does, on this root.
  const entry = path.join(root, 'worker-entry.mjs');
  fs.writeFileSync(entry, [
    `import App from ${JSON.stringify(APP_URL)};`,
    'const app = new App({ rootDir: process.env.AIO_TEST_ROOT, worker: true });',
    "const result = await app.start({ projectName: 'demo' });",
    "if (!result?.complete) { console.error('mission did not complete'); process.exitCode = 2; }",
  ].join('\n'));

  return { root, entry };
}

/** Fork a worker with an IPC channel, exactly as WorkerSupervisor does. */
function forkWorker(entry, root) {
  return fork(entry, [], {
    cwd: root,
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, AIO_TEST_ROOT: root, AI_ORCHESTRATOR_DAEMON_PID: String(process.pid) },
  });
}

test('a worker that COMPLETES its mission exits, and reports the exit', async () => {
  const { root, entry } = installation();
  const child = forkWorker(entry, root);

  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), EXIT_TIMEOUT_MS);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });

  if (outcome.timedOut) {
    // Never leave a leaked process behind, even when the assertion fails.
    try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
  }

  assert.equal(outcome.timedOut, undefined,
    'the worker finished its mission and must not stay resident — an open IPC channel is a live handle');
  assert.equal(outcome.code, 0, 'and it exits cleanly');
});

test('a completed worker releases its project claim before it goes', async () => {
  const { root, entry } = installation();
  const child = forkWorker(entry, root);

  await new Promise((resolve) => {
    const timer = setTimeout(resolve, EXIT_TIMEOUT_MS);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  try { process.kill(child.pid, 'SIGKILL'); } catch { /* expected: already exited */ }

  const registry = new WorkerRegistry({
    workersDir: path.join(root, 'state', 'workers'), logger: silentLogger,
  });
  assert.equal(registry.read('demo'), null, 'the project is startable again');
  assert.equal(registry.listAlive().length, 0);
});
