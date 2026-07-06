/**
 * P4 integration tests — the Continuation Builder wired into the real
 * supervision loop. Proves the headline property end-to-end: a retry after
 * a failed verification receives a prompt naming EXACTLY which check failed
 * and why, not a generic "continue" string — and that the feature can be
 * switched off to recover the old static-string behaviour byte-for-byte.
 *
 * Uses MockDriver's `receivedPrompts` (added in this phase) to inspect the
 * actual prompt text the orchestrator handed to the engine on each launch.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Orchestrator } from '../src/core/orchestrator.js';
import { DriverRegistry } from '../src/drivers/driverRegistry.js';
import { SessionManager } from '../src/state/sessionManager.js';
import { StatusManager } from '../src/state/statusManager.js';
import { silentLogger } from '../src/infra/logger.js';

const PROGRESS_CONFIG = { enabled: true, maxConsecutiveNoProgress: 3, interRunDelayMs: 5, blockedDetection: true };
const BASE_CONFIG = {
  supervision: { statusUpdateIntervalMs: 1_000, heartbeatIntervalMs: 1_000, childProcessScanIntervalMs: 0 },
  recovery: { maxConsecutiveCrashes: 2, crashBackoffBaseMs: 10, crashBackoffMaxMs: 40, networkRetryDelayMs: 10 },
  rateLimit: { minWaitMs: 5, defaultWaitMs: 50, maxWaitMs: 500, resumeGraceMs: 0 },
  progress: PROGRESS_CONFIG,
  briefing: { enabled: true, recentRunCount: 3 },
};

function harness({ config = BASE_CONFIG } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-p4-'));
  const workspace = path.join(root, 'workspace');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'task1.md'), '# task one prompt');
  fs.writeFileSync(path.join(workspace, 'legacy-prompt.md'), '# legacy mission');

  const project = {
    name: 'p4proj',
    driver: 'mock',
    workingDirectory: workspace,
    promptFile: 'legacy-prompt.md',
    resolvedPromptFile: path.join(workspace, 'legacy-prompt.md'),
    mission: { completionMarker: 'MISSION COMPLETE', continuePrompt: 'STATIC CONTINUE STRING', maxRuns: 0 },
    tasks: [],
    mock: { runs: [] },
  };

  const paths = {
    ledgerDir: path.join(stateDir, 'ledger'),
    timelineDir: path.join(stateDir, 'timeline'),
    progressDir: path.join(stateDir, 'progress'),
    tasksDir: path.join(stateDir, 'tasks'),
    diagnosticsDir: path.join(stateDir, 'diagnostics'),
  };
  const sessionManager = new SessionManager({ sessionsDir: path.join(stateDir, 'sessions'), logger: silentLogger });
  const statusManager = new StatusManager({ statusFile: path.join(stateDir, 'status.json'), logger: silentLogger });
  const driverRegistry = new DriverRegistry({ logger: silentLogger });

  const orchestrator = new Orchestrator({
    configManager: { getAll: () => config, getProject: () => project },
    driverRegistry,
    sessionManager,
    statusManager,
    paths,
    logger: silentLogger,
  });

  return { workspace, project, orchestrator, driver: driverRegistry.getDriver('mock') };
}

test('mission mode: a failed-verification retry receives a briefing naming exactly which check failed and why', () => {
  const { workspace, project, orchestrator, driver } = harness();
  project.tasks = [{
    id: 'T1', prompt: 'task1.md', resolvedPromptFile: path.join(workspace, 'task1.md'),
    objective: 'write out.txt', verify: [{ type: 'file-exists', path: 'out.txt' }], maxRuns: 2,
  }];
  project.mock.runs = [
    { output: 'thinking about it', exitCode: 0, delayMs: 10 }, // fails: never writes out.txt
    { output: 'now writing it', writeFile: { path: 'out.txt', content: 'x' }, exitCode: 0, delayMs: 10 },
  ];

  return (async () => {
    const result = await orchestrator.runProject('p4proj');
    assert.equal(result.complete, true);
    assert.equal(driver.receivedPrompts.length, 2);

    // First launch: task is fresh (attempts === 0) -> the raw prompt file, untouched.
    assert.equal(driver.receivedPrompts[0], '# task one prompt');

    // Second launch: a retry -> the structured briefing, naming the exact failure.
    const retryPrompt = driver.receivedPrompts[1];
    assert.match(retryPrompt, /Mission Continuation Briefing/);
    assert.match(retryPrompt, /was NOT accepted/);
    assert.match(retryPrompt, /file-exists.*failed: Not found: out\.txt/);
  })();
});

test('legacy mode: a progress-but-unfinished continuation receives a structured briefing, not the static string', () => {
  const { project, orchestrator, driver } = harness();
  project.mock.runs = [
    { output: 'partial work', writeFile: { path: 'partial.txt', content: 'x' }, exitCode: 0, delayMs: 10 },
    { output: 'done now\nMISSION COMPLETE', result: 'MISSION COMPLETE', exitCode: 0, delayMs: 10 },
  ];

  return (async () => {
    const result = await orchestrator.runProject('p4proj');
    assert.equal(result.complete, true);
    assert.equal(driver.receivedPrompts.length, 2);

    assert.equal(driver.receivedPrompts[0], '# legacy mission');

    const continuation = driver.receivedPrompts[1];
    assert.match(continuation, /Mission Continuation Briefing/);
    assert.doesNotMatch(continuation, /STATIC CONTINUE STRING/);
  })();
});

test('recent ledger activity is summarized in the briefing when prior runs exist', () => {
  const { workspace, project, orchestrator, driver } = harness();
  project.tasks = [{
    id: 'T1', prompt: 'task1.md', resolvedPromptFile: path.join(workspace, 'task1.md'),
    objective: 'write out.txt', verify: [{ type: 'file-exists', path: 'out.txt' }], maxRuns: 2,
  }];
  project.mock.runs = [
    { output: 'first attempt output', exitCode: 0, delayMs: 10 },
    { output: 'second attempt', writeFile: { path: 'out.txt', content: 'x' }, exitCode: 0, delayMs: 10 },
  ];

  return (async () => {
    await orchestrator.runProject('p4proj');
    const retryPrompt = driver.receivedPrompts[1];
    assert.match(retryPrompt, /Recent activity/);
  })();
});

test('briefing.enabled = false reverts to the static continuePrompt string, byte-for-byte', () => {
  const disabledConfig = { ...BASE_CONFIG, briefing: { enabled: false, recentRunCount: 0 } };
  const { workspace, project, orchestrator, driver } = harness({ config: disabledConfig });
  project.tasks = [{
    id: 'T1', prompt: 'task1.md', resolvedPromptFile: path.join(workspace, 'task1.md'),
    objective: 'write out.txt', verify: [{ type: 'file-exists', path: 'out.txt' }], maxRuns: 2,
    continuePrompt: 'TASK-SPECIFIC CONTINUE STRING',
  }];
  project.mock.runs = [
    { output: 'thinking about it', exitCode: 0, delayMs: 10 },
    { output: 'now writing it', writeFile: { path: 'out.txt', content: 'x' }, exitCode: 0, delayMs: 10 },
  ];

  return (async () => {
    const result = await orchestrator.runProject('p4proj');
    assert.equal(result.complete, true);
    assert.equal(driver.receivedPrompts[1], 'TASK-SPECIFIC CONTINUE STRING');
  })();
});
