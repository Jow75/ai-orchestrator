/**
 * P0 integration tests — the guarantees that make another overnight quota
 * burn impossible. These drive the real supervision loop with the mock
 * driver and progress awareness ENABLED, on temp workspaces + state dirs.
 *
 * The headline test reproduces the incident (a completed-but-no-progress
 * loop) and asserts the orchestrator now stops after a few runs with a
 * diagnostic report, instead of looping hundreds of times.
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
import { silentLogger } from '../src/infra/logger.js';

const BASE_CONFIG = {
  supervision: { statusUpdateIntervalMs: 1_000, heartbeatIntervalMs: 1_000, childProcessScanIntervalMs: 0 },
  recovery: { maxConsecutiveCrashes: 2, crashBackoffBaseMs: 10, crashBackoffMaxMs: 40, networkRetryDelayMs: 10 },
  rateLimit: { minWaitMs: 5, defaultWaitMs: 50, maxWaitMs: 500, resumeGraceMs: 0 },
  progress: { enabled: true, maxConsecutiveNoProgress: 3, interRunDelayMs: 5, blockedDetection: true },
};

/** Build an orchestrator wired to temp dirs and a scripted mock project. */
function harness({ mockRuns, progress = {}, mission = {} }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-p0-'));
  const workspace = path.join(root, 'workspace');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(workspace, { recursive: true });
  const promptFile = path.join(workspace, 'prompt.md');
  fs.writeFileSync(promptFile, '# test mission');

  const config = { ...BASE_CONFIG, progress: { ...BASE_CONFIG.progress, ...progress } };
  const project = {
    name: 'p0proj',
    driver: 'mock',
    workingDirectory: workspace,
    promptFile: 'prompt.md',
    resolvedPromptFile: promptFile,
    mission: {
      completionMarker: 'MISSION COMPLETE', continuePrompt: 'continue', maxRuns: 0, ...mission,
    },
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

  return { orchestrator, sessionManager, statusManager, workspace, paths };
}

test('INCIDENT REPRODUCTION: a no-progress loop trips the breaker and stops', async () => {
  // Every run completes cleanly, emits no marker, and changes nothing —
  // exactly the overnight scenario that looped 343 times.
  const { orchestrator, sessionManager, paths } = harness({
    mockRuns: [{ output: 'thinking... but doing nothing', exitCode: 0 }],
  });

  const events = [];
  orchestrator.on('mission:blocked', (e) => events.push(e));

  const result = await orchestrator.runProject('p0proj');

  assert.equal(result.complete, false);
  assert.equal(result.blocked, true);
  // The workspace is baselined before run 1, so every run is no-progress and
  // the breaker trips at maxConsecutiveNoProgress (3) — not 343.
  assert.ok(result.session.runs <= 4, `should stop quickly, ran ${result.session.runs} times`);
  assert.equal(events.length, 1);

  // Session archived as BLOCKED and NOT resumable (won't re-enter the loop).
  assert.equal(sessionManager.getActiveSession('p0proj'), null);
  assert.equal(sessionManager.getResumableSession('p0proj'), null);
  const history = sessionManager.getHistory('p0proj');
  assert.equal(history.at(-1).state, SessionState.BLOCKED);

  // A diagnostic report was written.
  const reports = fs.readdirSync(paths.diagnosticsDir);
  assert.equal(reports.length, 1);
  assert.match(fs.readFileSync(path.join(paths.diagnosticsDir, reports[0]), 'utf8'), /no measurable progress/);
});

test('permission-denied output blocks immediately (does not wait for the threshold)', async () => {
  const { orchestrator, sessionManager, paths } = harness({
    mockRuns: [
      {
        output: "I requested permissions to write to hello.txt, but you haven't granted it yet.",
        exitCode: 0,
      },
    ],
  });

  const result = await orchestrator.runProject('p0proj');

  assert.equal(result.blocked, true);
  // Blocked on the very first completed run (no need to reach 3 no-progress).
  assert.equal(result.session.runs, 1);
  assert.equal(sessionManager.getHistory('p0proj').at(-1).state, SessionState.BLOCKED);
  const report = fs.readFileSync(
    path.join(paths.diagnosticsDir, fs.readdirSync(paths.diagnosticsDir)[0]),
    'utf8'
  );
  assert.match(report, /permission/i);
});

test('real progress each run is never blocked and completes normally', async () => {
  const { orchestrator, workspace } = harness({
    mockRuns: [
      { output: 'phase 1', writeFile: { path: 'a.txt', content: '1' }, exitCode: 0 },
      { output: 'phase 2', writeFile: { path: 'b.txt', content: '2' }, exitCode: 0 },
      { output: 'done\nMISSION COMPLETE', result: 'MISSION COMPLETE', writeFile: { path: 'c.txt', content: '3' }, exitCode: 0 },
    ],
  });

  const result = await orchestrator.runProject('p0proj');

  assert.equal(result.complete, true);
  assert.equal(result.session.runs, 3);
  assert.equal(result.session.consecutiveNoProgress, 0);
  // The mock actually created the files (progress was real).
  assert.ok(fs.existsSync(path.join(workspace, 'a.txt')));
  assert.ok(fs.existsSync(path.join(workspace, 'c.txt')));
});

test('intermittent progress resets the streak and avoids blocking', async () => {
  // no-progress, no-progress, PROGRESS (resets), then complete — the streak
  // never reaches 3, so it must not block.
  const { orchestrator } = harness({
    mockRuns: [
      { output: 'idle 1', exitCode: 0 },
      { output: 'idle 2', exitCode: 0 },
      { output: 'did work', writeFile: { path: 'x.txt', content: 'x' }, exitCode: 0 },
      { output: 'finish\nMISSION COMPLETE', result: 'MISSION COMPLETE', writeFile: { path: 'y.txt', content: 'y' }, exitCode: 0 },
    ],
    progress: { maxConsecutiveNoProgress: 3 },
  });

  const result = await orchestrator.runProject('p0proj');
  assert.equal(result.complete, true);
});

test('the progress ledger records every run with its final response', async () => {
  const { orchestrator, paths } = harness({
    mockRuns: [{ output: 'nothing', result: 'I looked around but changed nothing', exitCode: 0 }],
  });

  await orchestrator.runProject('p0proj');

  const ledger = fs.readFileSync(path.join(paths.ledgerDir, 'p0proj.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(ledger.length >= 2);
  assert.equal(ledger[0].run, 1);
  assert.ok('progressed' in ledger[0]);
  assert.equal(ledger[0].resultText, 'I looked around but changed nothing');
});

test('progress.enabled=false restores the v1 marker-only behaviour', async () => {
  // With progress disabled, a no-marker completing run just continues (no
  // breaker). The maxRuns backstop bounds it → gave-up, NOT blocked.
  const { orchestrator } = harness({
    mockRuns: [{ output: 'no marker, no progress', exitCode: 0 }],
    progress: { enabled: false },
    mission: { maxRuns: 3 },
  });

  const result = await orchestrator.runProject('p0proj');
  assert.equal(result.complete, false);
  assert.notEqual(result.blocked, true);
  assert.equal(result.session.runs, 3);
});
