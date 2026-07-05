/**
 * P2 integration tests — the mission engine driving the real supervision
 * loop with the mock driver: multi-task plans, per-task verification,
 * retries, advancement, and mission completion. Also proves task-mode
 * survives the same crash/rate-limit/reboot scenarios P0 already covers,
 * resuming the exact task it was on rather than restarting the mission.
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
import { DEFAULT_TASK_MAX_RUNS } from '../src/mission/missionPlan.js';
import { silentLogger } from '../src/infra/logger.js';

const BASE_CONFIG = {
  supervision: { statusUpdateIntervalMs: 1_000, heartbeatIntervalMs: 1_000, childProcessScanIntervalMs: 0 },
  recovery: { maxConsecutiveCrashes: 2, crashBackoffBaseMs: 10, crashBackoffMaxMs: 40, networkRetryDelayMs: 10 },
  rateLimit: { minWaitMs: 5, defaultWaitMs: 50, maxWaitMs: 500, resumeGraceMs: 0 },
  progress: { enabled: true, maxConsecutiveNoProgress: 3, interRunDelayMs: 5, blockedDetection: true },
};

/**
 * Build an orchestrator wired to temp dirs and a scripted mock project with
 * a real multi-task plan (prompt files are written to disk, as configManager
 * would resolve them, since missionPlan/verifier code reads them for real).
 */
function harness({ tasks, mockRuns, progress = {} }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-p2-'));
  const workspace = path.join(root, 'workspace');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(workspace, { recursive: true });

  // Mirror missionPlan.normalizeAndValidateTasks()'s defaults: these tests
  // hand tasks straight to the Orchestrator (bypassing configManager), so
  // fields the orchestrator assumes are always present (verify, maxRuns,
  // continuePrompt) must be defaulted here exactly as production would.
  const normalizedTasks = tasks.map((t) => {
    const promptFile = path.join(workspace, `${t.id}.prompt.md`);
    fs.writeFileSync(promptFile, `# ${t.id}`);
    return {
      continuePrompt: null,
      verify: [],
      maxRuns: DEFAULT_TASK_MAX_RUNS,
      ...t,
      resolvedPromptFile: promptFile,
    };
  });

  const config = { ...BASE_CONFIG, progress: { ...BASE_CONFIG.progress, ...progress } };
  const project = {
    name: 'p2proj',
    driver: 'mock',
    workingDirectory: workspace,
    mission: { completionMarker: 'MISSION COMPLETE', continuePrompt: 'continue overall', maxRuns: 0 },
    tasks: normalizedTasks,
    mock: { runs: mockRuns },
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
  const orchestrator = new Orchestrator({
    configManager: { getAll: () => config, getProject: () => project },
    driverRegistry: new DriverRegistry({ logger: silentLogger }),
    sessionManager,
    statusManager,
    paths,
    logger: silentLogger,
  });

  return { orchestrator, sessionManager, statusManager, workspace, paths, project };
}

test('a two-task mission completes both tasks in order via file-exists verification', () => {
  return harnessRun({
    tasks: [
      { id: 'T1', objective: 'create a', verify: [{ type: 'file-exists', path: 'a.txt' }] },
      { id: 'T2', objective: 'create b', verify: [{ type: 'file-exists', path: 'b.txt' }] },
    ],
    mockRuns: [
      { output: 'made a', writeFile: { path: 'a.txt', content: '1' }, exitCode: 0, delayMs: 20 },
      { output: 'made b', writeFile: { path: 'b.txt', content: '2' }, exitCode: 0, delayMs: 20 },
    ],
  }, async ({ orchestrator, project, workspace }) => {
    const doneEvents = [];
    orchestrator.on('task:done', (e) => doneEvents.push(e.taskId));
    const completeEvents = [];
    orchestrator.on('mission:complete', (e) => completeEvents.push(e));

    const result = await orchestrator.runProject('p2proj');

    assert.equal(result.complete, true);
    assert.equal(result.reason, 'all tasks completed and verified');
    assert.deepEqual(doneEvents, ['T1', 'T2']);
    assert.equal(completeEvents.length, 1);
    assert.ok(fs.existsSync(path.join(workspace, 'a.txt')));
    assert.ok(fs.existsSync(path.join(workspace, 'b.txt')));
  });
});

test('a task with no verifiers falls back to the marker as its completion signal', () => {
  return harnessRun({
    tasks: [{ id: 'T1', objective: 'just talk' }], // no `verify` at all
    mockRuns: [
      { output: 'nothing yet', exitCode: 0, delayMs: 10 },
      { output: 'done\nMISSION COMPLETE', result: 'MISSION COMPLETE', exitCode: 0, delayMs: 10 },
    ],
  }, async ({ orchestrator }) => {
    const result = await orchestrator.runProject('p2proj');
    // First run: no marker -> verification fails -> retry same task.
    // Second run: marker present -> verification passes -> task done -> mission complete (last task).
    assert.equal(result.complete, true);
  });
});

test('failed verification retries the SAME task (continuePrompt), not a fresh prompt', () => {
  return harnessRun({
    tasks: [{ id: 'T1', objective: 'create x', verify: [{ type: 'file-exists', path: 'x.txt' }], maxRuns: 5 }],
    mockRuns: [
      { output: 'thinking', exitCode: 0, delayMs: 10 }, // fails verify (no x.txt yet)
      { output: 'now creating', writeFile: { path: 'x.txt', content: '1' }, exitCode: 0, delayMs: 10 },
    ],
  }, async ({ orchestrator, sessionManager }) => {
    const resumeNotes = [];
    orchestrator.on('session:resumed', (e) => resumeNotes.push(e.note));

    const result = await orchestrator.runProject('p2proj');

    assert.equal(result.complete, true);
    assert.equal(result.session.runs, 2);
    assert.ok(resumeNotes.some((n) => n.includes('verification failed')));
  });
});

test('exhausting a task\'s retry budget blocks (never silently moves on)', () => {
  return harnessRun({
    tasks: [{ id: 'T1', objective: 'never happens', verify: [{ type: 'file-exists', path: 'never.txt' }], maxRuns: 2 }],
    mockRuns: [{ output: 'nothing happens', exitCode: 0, delayMs: 10 }],
  }, async ({ orchestrator, sessionManager, paths }) => {
    const blockedEvents = [];
    orchestrator.on('mission:blocked', (e) => blockedEvents.push(e));

    const result = await orchestrator.runProject('p2proj');

    assert.equal(result.complete, false);
    assert.equal(result.blocked, true);
    assert.equal(blockedEvents.length, 1);
    assert.equal(blockedEvents[0].category, 'verification-failed');
    assert.match(blockedEvents[0].reason, /T1/);

    // The session is archived BLOCKED (not auto-resumable).
    assert.equal(sessionManager.getResumableSession('p2proj'), null);
    const history = sessionManager.getHistory('p2proj');
    assert.equal(history.at(-1).state, SessionState.BLOCKED);

    // A diagnostic report exists and names the failed check.
    const reportFile = fs.readdirSync(paths.diagnosticsDir)[0];
    const report = fs.readFileSync(path.join(paths.diagnosticsDir, reportFile), 'utf8');
    assert.match(report, /never\.txt/);
  });
});

test('usage-limit mid-task resumes the SAME task, not task 1 again', () => {
  return harnessRun({
    tasks: [
      { id: 'T1', objective: 'first', verify: [{ type: 'file-exists', path: 'first.txt' }] },
      { id: 'T2', objective: 'second', verify: [{ type: 'file-exists', path: 'second.txt' }] },
    ],
    mockRuns: [
      { output: 'made first', writeFile: { path: 'first.txt', content: '1' }, exitCode: 0, delayMs: 10 },
      // Task 2's first attempt hits a usage limit before finishing.
      { output: `usage limit reached|${Date.now() + 20}`, exitCode: 1, delayMs: 10 },
      { output: 'made second', writeFile: { path: 'second.txt', content: '2' }, exitCode: 0, delayMs: 10 },
    ],
  }, async ({ orchestrator }) => {
    const result = await orchestrator.runProject('p2proj');
    assert.equal(result.complete, true);
    assert.equal(result.session.rateLimits, 1);
    // Both files exist (task 2 was resumed and completed, not restarted from T1).
  });
});

test('a crash mid-task resumes the same task after backoff', () => {
  return harnessRun({
    tasks: [{ id: 'T1', objective: 'create y', verify: [{ type: 'file-exists', path: 'y.txt' }], maxRuns: 5 }],
    mockRuns: [
      { output: 'crashed', exitCode: 1, delayMs: 10 }, // classified as CRASH (no limit/network pattern)
      { output: 'recovered', writeFile: { path: 'y.txt', content: '1' }, exitCode: 0, delayMs: 10 },
    ],
  }, async ({ orchestrator }) => {
    const crashedEvents = [];
    orchestrator.on('session:crashed', (e) => crashedEvents.push(e));
    const result = await orchestrator.runProject('p2proj');
    assert.equal(result.complete, true);
    assert.equal(crashedEvents.length, 1);
  });
});

test('a crash/rate-limit mid-task preserves task queue progress across a fresh Orchestrator (reboot survival)', () => {
  return harnessRun({
    tasks: [
      { id: 'T1', objective: 'first', verify: [{ type: 'file-exists', path: 'first.txt' }] },
      { id: 'T2', objective: 'second', verify: [{ type: 'file-exists', path: 'second.txt' }] },
    ],
    mockRuns: [
      { output: 'made first', writeFile: { path: 'first.txt', content: '1' }, exitCode: 0, delayMs: 10 },
      { output: 'crashed on task 2', exitCode: 1, delayMs: 10 },
    ],
  }, async ({ orchestrator, sessionManager, statusManager, paths, project }) => {
    // Force a give-up after the crash to simulate "process died before it could retry".
    const config = {
      ...BASE_CONFIG,
      recovery: { ...BASE_CONFIG.recovery, maxConsecutiveCrashes: 1 },
    };
    const first = new Orchestrator({
      configManager: { getAll: () => config, getProject: () => project },
      driverRegistry: new DriverRegistry({ logger: silentLogger }),
      sessionManager,
      statusManager,
      paths,
      logger: silentLogger,
    });
    const firstResult = await first.runProject('p2proj');
    assert.equal(firstResult.complete, false); // gave up after 1 crash

    // A brand-new Orchestrator instance (simulating a fresh process after
    // reboot) resuming the SAME project must continue task 2, not restart T1.
    const second = new Orchestrator({
      configManager: {
        getAll: () => BASE_CONFIG,
        getProject: () => ({
          ...project,
          mock: { runs: [{ output: 'made second', writeFile: { path: 'second.txt', content: '2' }, exitCode: 0, delayMs: 10 }] },
        }),
      },
      driverRegistry: new DriverRegistry({ logger: silentLogger }),
      sessionManager,
      statusManager,
      paths,
      logger: silentLogger,
    });
    const secondResult = await second.runProject('p2proj');
    assert.equal(secondResult.complete, true);
    assert.ok(fs.existsSync(path.join(project.workingDirectory, 'first.txt')));
    assert.ok(fs.existsSync(path.join(project.workingDirectory, 'second.txt')));
  });
});

test('status.json reports mission-mode task progress via syncTaskQueue', () => {
  return harnessRun({
    tasks: [
      { id: 'T1', objective: 'first', verify: [{ type: 'file-exists', path: 'a.txt' }] },
      { id: 'T2', objective: 'second', verify: [{ type: 'file-exists', path: 'b.txt' }] },
    ],
    mockRuns: [
      { output: 'a', writeFile: { path: 'a.txt', content: '1' }, exitCode: 0, delayMs: 10 },
      { output: 'b', writeFile: { path: 'b.txt', content: '1' }, exitCode: 0, delayMs: 10 },
    ],
  }, async ({ orchestrator, statusManager }) => {
    await orchestrator.runProject('p2proj');
    // After completion, the queue is fully advanced (index == length).
    const mission = statusManager.get().mission;
    assert.equal(mission.mode, 'tasks');
    assert.equal(mission.totalTasks, 2);
  });
});

test('the files-changed verifier can gate a task on specific files being touched', () => {
  return harnessRun({
    tasks: [{ id: 'T1', objective: 'touch src', verify: [{ type: 'files-changed', paths: ['src/'] }] }],
    mockRuns: [
      { output: 'wrong file', writeFile: { path: 'other.txt', content: 'x' }, exitCode: 0, delayMs: 10 },
      { output: 'right file', writeFile: { path: 'src/index.js', content: 'x' }, exitCode: 0, delayMs: 10 },
    ],
  }, async ({ orchestrator }) => {
    const result = await orchestrator.runProject('p2proj');
    assert.equal(result.complete, true);
    assert.equal(result.session.runs, 2); // first attempt failed verify, second passed
  });
});

/** Run a harness-built scenario and always clean up the temp dirs after. */
async function harnessRun(setup, fn) {
  const ctx = harness(setup);
  await fn(ctx);
}
