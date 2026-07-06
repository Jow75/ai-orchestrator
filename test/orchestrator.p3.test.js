/**
 * P3 integration tests — the persistent, runtime-mutable prompt queue.
 * Proves that tasks queued via TaskQueue mutation methods (what the
 * `tasks add/remove/reorder` CLI calls under the hood) actually drive the
 * orchestrator, on a project that has NO static `tasks` array at all —
 * mission mode switched on purely by an existing queue with pending work.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Orchestrator } from '../src/core/orchestrator.js';
import { DriverRegistry } from '../src/drivers/driverRegistry.js';
import { SessionManager, SessionState } from '../src/state/sessionManager.js';
import { StatusManager } from '../src/state/statusManager.js';
import { TaskQueue } from '../src/mission/taskQueue.js';
import { validateSingleTask } from '../src/mission/missionPlan.js';
import { silentLogger } from '../src/infra/logger.js';

const BASE_CONFIG = {
  supervision: { statusUpdateIntervalMs: 1_000, heartbeatIntervalMs: 1_000, childProcessScanIntervalMs: 0 },
  recovery: { maxConsecutiveCrashes: 2, crashBackoffBaseMs: 10, crashBackoffMaxMs: 40, networkRetryDelayMs: 10 },
  rateLimit: { minWaitMs: 5, defaultWaitMs: 50, maxWaitMs: 500, resumeGraceMs: 0 },
  progress: { enabled: true, maxConsecutiveNoProgress: 3, interRunDelayMs: 5, blockedDetection: true },
};

/** A LEGACY project (static promptFile, no static tasks) + its own paths. */
function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-p3-'));
  const workspace = path.join(root, 'workspace');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'legacy-prompt.md'), '# legacy mission');

  const project = {
    name: 'p3proj',
    driver: 'mock',
    workingDirectory: workspace,
    promptFile: 'legacy-prompt.md',
    resolvedPromptFile: path.join(workspace, 'legacy-prompt.md'),
    mission: { completionMarker: 'MISSION COMPLETE', continuePrompt: 'continue', maxRuns: 0 },
    tasks: [], // genuinely legacy — no static tasks at all
    mock: { runs: [] }, // set per-test
  };

  const paths = {
    ledgerDir: path.join(stateDir, 'ledger'),
    timelineDir: path.join(stateDir, 'timeline'),
    progressDir: path.join(stateDir, 'progress'),
    tasksDir: path.join(stateDir, 'tasks'),
    diagnosticsDir: path.join(stateDir, 'diagnostics'),
  };
  const sessionManager = new SessionManager({
    sessionsDir: path.join(stateDir, 'sessions'),
    logger: silentLogger,
  });
  const statusManager = new StatusManager({
    statusFile: path.join(stateDir, 'status.json'),
    logger: silentLogger,
  });
  const taskQueueStore = new TaskQueue({ tasksDir: paths.tasksDir, logger: silentLogger });

  return { workspace, paths, project, sessionManager, statusManager, taskQueueStore };
}

function buildOrchestrator({ project, config, sessionManager, statusManager, paths }) {
  return new Orchestrator({
    configManager: { getAll: () => config, getProject: () => project },
    driverRegistry: new DriverRegistry({ logger: silentLogger }),
    sessionManager,
    statusManager,
    paths,
    logger: silentLogger,
  });
}

/** Queue one task exactly as the `tasks add` CLI command would. */
function queueTask(taskQueueStore, project, rawTask) {
  const queue = taskQueueStore.ensure(project.name);
  const { task, problems } = validateSingleTask(rawTask, {
    label: `task "${rawTask.id}"`,
    workingDirectory: project.workingDirectory,
    seenIds: new Set(queue.tasks.map((t) => t.id)),
  });
  assert.deepEqual(problems, [], `unexpected validation problems: ${problems}`);
  return taskQueueStore.enqueue(queue, task);
}

test('a task queued via the CLI mutation path runs, on a project with NO static tasks', () => {
  const { workspace, paths, project, sessionManager, statusManager, taskQueueStore } = harness();
  fs.writeFileSync(path.join(workspace, 'queued.md'), '# queued task');

  queueTask(taskQueueStore, project, {
    id: 'Q1', prompt: 'queued.md', objective: 'do the queued thing',
    verify: [{ type: 'file-exists', path: 'done.txt' }],
  });

  project.mock.runs = [
    { output: 'doing it', writeFile: { path: 'done.txt', content: 'x' }, exitCode: 0, delayMs: 10 },
  ];

  return (async () => {
    const orchestrator = buildOrchestrator({ project, config: BASE_CONFIG, sessionManager, statusManager, paths });
    const result = await orchestrator.runProject('p3proj');

    assert.equal(result.complete, true);
    assert.equal(orchestrator.missionMode, true); // switched on by the queue alone
    assert.ok(fs.existsSync(path.join(workspace, 'done.txt')));
  })();
});

test('CLI-queued tasks appended AFTER a prior mission completed are picked up on the next start', () => {
  const { workspace, paths, project, sessionManager, statusManager, taskQueueStore } = harness();

  return (async () => {
    // First run: purely legacy (no queue at all) — completes via marker.
    project.mock.runs = [
      { output: 'done\nMISSION COMPLETE', result: 'MISSION COMPLETE', exitCode: 0, delayMs: 10 },
    ];
    const first = buildOrchestrator({ project, config: BASE_CONFIG, sessionManager, statusManager, paths });
    const firstResult = await first.runProject('p3proj');
    assert.equal(firstResult.complete, true);
    assert.equal(first.missionMode, false); // no queue existed -> legacy path

    // Now queue a follow-up task after the mission already completed.
    fs.writeFileSync(path.join(workspace, 'followup.md'), '# followup');
    queueTask(taskQueueStore, project, {
      id: 'F1', prompt: 'followup.md',
      verify: [{ type: 'file-exists', path: 'followup.txt' }],
    });

    project.mock.runs = [
      { output: 'follow up done', writeFile: { path: 'followup.txt', content: 'x' }, exitCode: 0, delayMs: 10 },
    ];
    const second = buildOrchestrator({ project, config: BASE_CONFIG, sessionManager, statusManager, paths });
    const secondResult = await second.runProject('p3proj');

    assert.equal(secondResult.complete, true);
    assert.equal(second.missionMode, true);
    assert.ok(fs.existsSync(path.join(workspace, 'followup.txt')));
  })();
});

test('removeTask via the mutation API keeps a not-yet-started task from ever running', () => {
  const { workspace, paths, project, sessionManager, statusManager, taskQueueStore } = harness();
  fs.writeFileSync(path.join(workspace, 'q1.md'), '# q1');
  fs.writeFileSync(path.join(workspace, 'q2.md'), '# q2');

  let queue = taskQueueStore.ensure(project.name);
  queue = taskQueueStore.enqueue(queue, { id: 'Q1', resolvedPromptFile: path.join(workspace, 'q1.md'), verify: [{ type: 'file-exists', path: 'q1.txt' }], maxRuns: 5 });
  queue = taskQueueStore.enqueue(queue, { id: 'Q2', resolvedPromptFile: path.join(workspace, 'q2.md'), verify: [{ type: 'file-exists', path: 'q2.txt' }], maxRuns: 5 });

  const removeResult = taskQueueStore.removeTask(queue, 'Q2');
  assert.equal(removeResult.ok, true);

  project.mock.runs = [
    { output: 'q1 done', writeFile: { path: 'q1.txt', content: 'x' }, exitCode: 0, delayMs: 10 },
  ];

  return (async () => {
    const orchestrator = buildOrchestrator({ project, config: BASE_CONFIG, sessionManager, statusManager, paths });
    const result = await orchestrator.runProject('p3proj');

    assert.equal(result.complete, true);
    assert.equal(result.session.runs, 1); // only Q1 ran — Q2 was removed before it ever started
    assert.ok(!fs.existsSync(path.join(workspace, 'q2.txt')));
  })();
});

test('reorderTask runs the tasks in the new order', () => {
  const { workspace, paths, project, sessionManager, statusManager, taskQueueStore } = harness();
  fs.writeFileSync(path.join(workspace, 'a.md'), '# a');
  fs.writeFileSync(path.join(workspace, 'b.md'), '# b');

  let queue = taskQueueStore.ensure(project.name);
  queue = taskQueueStore.enqueue(queue, { id: 'A', resolvedPromptFile: path.join(workspace, 'a.md'), verify: [{ type: 'file-exists', path: 'first.txt' }], maxRuns: 5 });
  queue = taskQueueStore.enqueue(queue, { id: 'B', resolvedPromptFile: path.join(workspace, 'b.md'), verify: [{ type: 'file-exists', path: 'second.txt' }], maxRuns: 5 });
  const reorderResult = taskQueueStore.reorderTask(queue, 'B', 'up'); // B now runs before A
  assert.equal(reorderResult.ok, true);
  assert.equal(queue.tasks[0].id, 'B');

  // B's verifier (checks second.txt... no wait, B should now run FIRST and
  // must create whatever ITS verifier checks) — script both runs so the
  // ORDER is what's under test, not verifier semantics.
  project.mock.runs = [
    { output: 'runs first now', writeFile: { path: 'second.txt', content: 'x' }, exitCode: 0, delayMs: 10 },
    { output: 'runs second now', writeFile: { path: 'first.txt', content: 'x' }, exitCode: 0, delayMs: 10 },
  ];

  return (async () => {
    const orchestrator = buildOrchestrator({ project, config: BASE_CONFIG, sessionManager, statusManager, paths });
    const doneOrder = [];
    orchestrator.on('task:done', (e) => doneOrder.push(e.taskId));

    const result = await orchestrator.runProject('p3proj');
    assert.equal(result.complete, true);
    assert.deepEqual(doneOrder, ['B', 'A']); // B (reordered up) completed first
  })();
});

test('a BLOCKED queue is never re-adopted by the next start (safety net holds under P3)', () => {
  const { workspace, paths, project, sessionManager, statusManager, taskQueueStore } = harness();
  fs.writeFileSync(path.join(workspace, 'stuck.md'), '# stuck');

  let queue = taskQueueStore.ensure(project.name);
  queue = taskQueueStore.enqueue(queue, {
    id: 'S1', resolvedPromptFile: path.join(workspace, 'stuck.md'),
    verify: [{ type: 'file-exists', path: 'never.txt' }], maxRuns: 1,
  });

  project.mock.runs = [{ output: 'never does it', exitCode: 0, delayMs: 10 }];

  return (async () => {
    const first = buildOrchestrator({ project, config: BASE_CONFIG, sessionManager, statusManager, paths });
    const firstResult = await first.runProject('p3proj');
    assert.equal(firstResult.blocked, true);
    assert.equal(sessionManager.getResumableSession('p3proj'), null);

    // With maxRuns: 1, the per-task retry budget is exhausted on the very
    // first failed attempt (before the separate P0 stagnation breaker, which
    // needs 3 no-progress runs, could ever trip) — so the task lands in
    // FAILED here rather than BLOCKED. Either is a valid terminal state for
    // this test's actual invariant: the task must never be resumable again.
    const blockedQueue = taskQueueStore.load('p3proj');
    assert.equal(taskQueueStore.currentIsResumable(blockedQueue), false);

    // Next start: legacy promptFile still exists and no static tasks are
    // defined, so a fresh session runs the legacy mission instead of
    // re-adopting the blocked queue — scripted to complete immediately via
    // marker, isolating this from P0's unrelated stagnation mechanism.
    project.mock.runs = [
      { output: 'legacy run\nMISSION COMPLETE', result: 'MISSION COMPLETE', exitCode: 0, delayMs: 10 },
    ];
    const second = buildOrchestrator({ project, config: BASE_CONFIG, sessionManager, statusManager, paths });
    const secondResult = await second.runProject('p3proj');

    assert.equal(second.missionMode, false);
    assert.equal(secondResult.complete, true);

    // The stuck task's queue entry is untouched — never silently retried.
    const queueAfter = taskQueueStore.load('p3proj');
    assert.equal(taskQueueStore.currentIsResumable(queueAfter), false);
    assert.equal(queueAfter.tasks[0].attempts, 1);
  })();
});
