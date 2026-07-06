/**
 * P6 integration test — the new verifiers (json-schema, lint, dependency)
 * actually gate a real mission's task completion through the full
 * supervision loop, not just in isolation (see test/verifiers.test.js).
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

const BASE_CONFIG = {
  supervision: { statusUpdateIntervalMs: 1_000, heartbeatIntervalMs: 1_000, childProcessScanIntervalMs: 0 },
  recovery: { maxConsecutiveCrashes: 2, crashBackoffBaseMs: 10, crashBackoffMaxMs: 40, networkRetryDelayMs: 10 },
  rateLimit: { minWaitMs: 5, defaultWaitMs: 50, maxWaitMs: 500, resumeGraceMs: 0 },
  progress: { enabled: true, maxConsecutiveNoProgress: 3, interRunDelayMs: 5, blockedDetection: true },
};

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-p6-'));
  const workspace = path.join(root, 'workspace');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'task1.md'), '# add express as a dependency');

  const project = {
    name: 'p6proj',
    driver: 'mock',
    workingDirectory: workspace,
    resolvedPromptFile: path.join(workspace, 'task1.md'),
    mission: { completionMarker: 'MISSION COMPLETE', continuePrompt: 'continue', maxRuns: 0 },
    tasks: [{
      id: 'T1', prompt: 'task1.md', resolvedPromptFile: path.join(workspace, 'task1.md'),
      objective: 'add express as a dependency',
      verify: [{ type: 'dependency', name: 'express' }],
      maxRuns: 2, continuePrompt: null,
    }],
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
  const orchestrator = new Orchestrator({
    configManager: { getAll: () => BASE_CONFIG, getProject: () => project },
    driverRegistry: new DriverRegistry({ logger: silentLogger }),
    sessionManager, statusManager, paths, logger: silentLogger,
  });

  return { workspace, project, orchestrator };
}

test('a "dependency" verifier gates real task completion: declared-but-not-installed retries, then passes once installed', () => {
  const { workspace, project, orchestrator } = harness();

  // Run 1: agent declares the dependency in package.json but never installs it.
  // Run 2: agent actually runs the install (node_modules now has the package).
  project.mock.runs = [
    {
      output: 'added express to package.json',
      writeFile: { path: 'package.json', content: JSON.stringify({ dependencies: { express: '^4.0.0' } }) },
      exitCode: 0, delayMs: 10,
    },
    { output: 'installed it', exitCode: 0, delayMs: 10 }, // node_modules/express created below before this run matters
  ];

  return (async () => {
    // Precreate node_modules/express so it's present by the time run 2's
    // verification checks it (the mock driver only simulates package.json
    // writes, not a real `npm install`).
    fs.mkdirSync(path.join(workspace, 'node_modules', 'express'), { recursive: true });

    const result = await orchestrator.runProject('p6proj');
    assert.equal(result.complete, true);
  })();
});

test('a "dependency" verifier blocks (after maxRuns) when the package is never installed', () => {
  const { project, orchestrator } = harness();
  project.tasks[0].maxRuns = 1;
  project.mock.runs = [
    {
      output: 'added express to package.json only',
      writeFile: { path: 'package.json', content: JSON.stringify({ dependencies: { express: '^4.0.0' } }) },
      exitCode: 0, delayMs: 10,
    },
  ];

  return (async () => {
    const result = await orchestrator.runProject('p6proj');
    assert.equal(result.blocked, true);
    assert.match(result.reason, /T1/);
  })();
});
