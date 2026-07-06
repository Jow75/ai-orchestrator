/**
 * P5 integration tests — cross-session memory wired into the real
 * supervision loop: a block() auto-records a failure that outlives the
 * session/queue, and operator-authored notes plus the unresolved-failure
 * catalog actually reach the next real continuation prompt.
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
import { MemoryStore } from '../src/memory/memoryStore.js';
import { silentLogger } from '../src/infra/logger.js';

const BASE_CONFIG = {
  supervision: { statusUpdateIntervalMs: 1_000, heartbeatIntervalMs: 1_000, childProcessScanIntervalMs: 0 },
  recovery: { maxConsecutiveCrashes: 2, crashBackoffBaseMs: 10, crashBackoffMaxMs: 40, networkRetryDelayMs: 10 },
  rateLimit: { minWaitMs: 5, defaultWaitMs: 50, maxWaitMs: 500, resumeGraceMs: 0 },
  progress: { enabled: true, maxConsecutiveNoProgress: 3, interRunDelayMs: 5, blockedDetection: true },
  briefing: { enabled: true, recentRunCount: 3 },
};

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-p5-'));
  const workspace = path.join(root, 'workspace');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'task1.md'), '# task one prompt');
  fs.writeFileSync(path.join(workspace, 'legacy-prompt.md'), '# legacy mission');

  const project = {
    name: 'p5proj',
    driver: 'mock',
    workingDirectory: workspace,
    promptFile: 'legacy-prompt.md',
    resolvedPromptFile: path.join(workspace, 'legacy-prompt.md'),
    mission: { completionMarker: 'MISSION COMPLETE', continuePrompt: 'STATIC CONTINUE', maxRuns: 0 },
    tasks: [],
    mock: { runs: [] },
  };

  const paths = {
    ledgerDir: path.join(stateDir, 'ledger'),
    timelineDir: path.join(stateDir, 'timeline'),
    progressDir: path.join(stateDir, 'progress'),
    tasksDir: path.join(stateDir, 'tasks'),
    diagnosticsDir: path.join(stateDir, 'diagnostics'),
    memoryDir: path.join(stateDir, 'memory'),
  };
  const sessionManager = new SessionManager({ sessionsDir: path.join(stateDir, 'sessions'), logger: silentLogger });
  const statusManager = new StatusManager({ statusFile: path.join(stateDir, 'status.json'), logger: silentLogger });
  const driverRegistry = new DriverRegistry({ logger: silentLogger });

  const orchestrator = new Orchestrator({
    configManager: { getAll: () => BASE_CONFIG, getProject: () => project },
    driverRegistry,
    sessionManager,
    statusManager,
    paths,
    logger: silentLogger,
  });

  return {
    workspace, project, orchestrator, paths,
    driver: driverRegistry.getDriver('mock'),
    memoryStore: new MemoryStore({ memoryDir: paths.memoryDir, logger: silentLogger }),
  };
}

test('a mission-mode block() auto-records a failure that outlives the session', () => {
  const { workspace, project, orchestrator, memoryStore } = harness();
  project.tasks = [{
    id: 'T1', prompt: 'task1.md', resolvedPromptFile: path.join(workspace, 'task1.md'),
    objective: 'write out.txt', verify: [{ type: 'file-exists', path: 'out.txt' }], maxRuns: 1,
  }];
  project.mock.runs = [{ output: 'never writes it', exitCode: 0, delayMs: 10 }];

  return (async () => {
    const result = await orchestrator.runProject('p5proj');
    assert.equal(result.blocked, true);

    const failures = memoryStore.load('p5proj').failures;
    assert.equal(failures.length, 1);
    assert.equal(failures[0].taskId, 'T1');
    assert.equal(failures[0].resolved, false);
    assert.match(failures[0].reason, /T1/);
  })();
});

test('a legacy-mode stagnation block() auto-records a mission-scoped (no taskId) failure', () => {
  const { project, orchestrator, memoryStore } = harness();
  // Never changes the workspace and never prints the marker -> stagnation trips.
  project.mock.runs = [{ output: 'spinning without doing anything', exitCode: 0, delayMs: 10 }];

  return (async () => {
    const result = await orchestrator.runProject('p5proj');
    assert.equal(result.blocked, true);

    const failures = memoryStore.load('p5proj').failures;
    assert.equal(failures.length, 1);
    assert.equal(failures[0].taskId, null);
  })();
});

test('an operator-authored note reaches the very next real continuation prompt', () => {
  const { project, orchestrator, driver, memoryStore } = harness();
  memoryStore.addNote('p5proj', { category: 'architecture', text: 'always run npm run build first' });

  project.mock.runs = [
    { output: 'partial work', writeFile: { path: 'partial.txt', content: 'x' }, exitCode: 0, delayMs: 10 },
    { output: 'done now\nMISSION COMPLETE', result: 'MISSION COMPLETE', exitCode: 0, delayMs: 10 },
  ];

  return (async () => {
    await orchestrator.runProject('p5proj');
    const continuation = driver.receivedPrompts[1];
    assert.match(continuation, /Project memory/);
    assert.match(continuation, /always run npm run build first/);
  })();
});

test('an unresolved failure recorded on a PRIOR (now-abandoned) mission attempt surfaces on the next one', () => {
  const { project, orchestrator, driver, memoryStore } = harness();
  memoryStore.recordFailure('p5proj', {
    category: 'verification-failed', reason: 'previously failed because the build script was missing', taskId: null,
  });

  project.mock.runs = [
    { output: 'partial work', writeFile: { path: 'partial.txt', content: 'x' }, exitCode: 0, delayMs: 10 },
    { output: 'done now\nMISSION COMPLETE', result: 'MISSION COMPLETE', exitCode: 0, delayMs: 10 },
  ];

  return (async () => {
    await orchestrator.runProject('p5proj');
    const continuation = driver.receivedPrompts[1];
    assert.match(continuation, /Known problems/);
    assert.match(continuation, /build script was missing/);
  })();
});

test('resolveFailure() stops a failure from appearing in future briefings', () => {
  const { project, orchestrator, driver, memoryStore } = harness();
  memoryStore.recordFailure('p5proj', { category: 'x', reason: 'a fixed problem', taskId: null });
  const failureId = memoryStore.load('p5proj').failures[0].id;
  memoryStore.resolveFailure('p5proj', failureId);

  project.mock.runs = [
    { output: 'partial work', writeFile: { path: 'partial.txt', content: 'x' }, exitCode: 0, delayMs: 10 },
    { output: 'done now\nMISSION COMPLETE', result: 'MISSION COMPLETE', exitCode: 0, delayMs: 10 },
  ];

  return (async () => {
    await orchestrator.runProject('p5proj');
    const continuation = driver.receivedPrompts[1];
    assert.doesNotMatch(continuation, /Known problems/);
    assert.doesNotMatch(continuation, /a fixed problem/);
  })();
});
