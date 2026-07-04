/**
 * Integration tests for the supervision loop, using the scriptable mock
 * driver and real state managers on temp directories. These exercise the
 * flows that matter most:
 *
 *   - mission completes when the completion marker appears
 *   - clean-but-unfinished runs continue automatically
 *   - usage limit → wait → resume → complete (the headline feature)
 *   - repeated crashes → backoff → give up, with the session preserved
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

/** Tuned-for-tests global config (milliseconds instead of minutes). */
const TEST_CONFIG = {
  supervision: {
    statusUpdateIntervalMs: 1_000,
    heartbeatIntervalMs: 1_000,
    childProcessScanIntervalMs: 0, // no child scans in tests
  },
  recovery: {
    maxConsecutiveCrashes: 2,
    crashBackoffBaseMs: 10,
    crashBackoffMaxMs: 40,
    networkRetryDelayMs: 10,
  },
  rateLimit: {
    minWaitMs: 5,
    defaultWaitMs: 50,
    maxWaitMs: 500,
    resumeGraceMs: 0,
  },
};

/** Build an orchestrator wired to temp state and a scripted mock project. */
function harness({ mockRuns, maxRuns = 0 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-orch-'));
  const promptFile = path.join(dir, 'prompt.md');
  fs.writeFileSync(promptFile, '# test mission');

  const project = {
    name: 'testproj',
    driver: 'mock',
    workingDirectory: dir,
    promptFile: 'prompt.md',
    resolvedPromptFile: promptFile,
    mission: {
      completionMarker: 'MISSION COMPLETE',
      continuePrompt: 'continue',
      maxRuns,
    },
    mock: { runs: mockRuns },
  };

  const configManager = {
    getAll: () => TEST_CONFIG,
    getProject: () => project,
  };
  const sessionManager = new SessionManager({
    sessionsDir: path.join(dir, 'sessions'),
    logger: silentLogger,
  });
  const statusManager = new StatusManager({
    statusFile: path.join(dir, 'status.json'),
    logger: silentLogger,
  });
  const orchestrator = new Orchestrator({
    configManager,
    driverRegistry: new DriverRegistry({ logger: silentLogger }),
    sessionManager,
    statusManager,
    logger: silentLogger,
  });

  return { orchestrator, sessionManager, statusManager };
}

test('mission completes when the marker appears', async () => {
  const { orchestrator, sessionManager } = harness({
    mockRuns: [
      { output: 'did everything\nMISSION COMPLETE', result: 'MISSION COMPLETE', exitCode: 0 },
    ],
  });

  const events = [];
  orchestrator.on('mission:complete', () => events.push('mission:complete'));

  const result = await orchestrator.runProject('testproj');

  assert.equal(result.complete, true);
  assert.deepEqual(events, ['mission:complete']);
  // Session archived: no active session remains, one history record exists.
  assert.equal(sessionManager.getActiveSession('testproj'), null);
  assert.equal(sessionManager.getHistory('testproj').length, 1);
});

test('clean-but-unfinished run continues automatically', async () => {
  const { orchestrator } = harness({
    mockRuns: [
      { output: 'phase 1 done, more to do', exitCode: 0 },
      { output: 'MISSION COMPLETE', result: 'MISSION COMPLETE', exitCode: 0 },
    ],
  });

  const result = await orchestrator.runProject('testproj');

  assert.equal(result.complete, true);
  assert.equal(result.session.runs, 2);
  assert.equal(result.session.resumes, 1);
});

test('usage limit: waits, resumes the same session, then completes', async () => {
  const { orchestrator } = harness({
    mockRuns: [
      // Mock reset-time format: epoch ms after the pipe.
      { output: `usage limit reached|${Date.now() + 40}`, exitCode: 1 },
      { output: 'MISSION COMPLETE', result: 'MISSION COMPLETE', exitCode: 0 },
    ],
  });

  const events = [];
  orchestrator.on('session:rate-limited', ({ waitMs }) => events.push(['limited', waitMs]));
  orchestrator.on('session:resumed', () => events.push(['resumed']));

  const result = await orchestrator.runProject('testproj');

  assert.equal(result.complete, true);
  assert.equal(result.session.rateLimits, 1);
  assert.equal(result.session.resumes, 1);
  assert.equal(events[0][0], 'limited');
  assert.ok(events.some(([name]) => name === 'resumed'));
  // The engine conversation id survived the wait — same session resumed.
  assert.ok(result.session.engineSessionId);
});

test('repeated crashes: backoff, then give up with the session preserved', async () => {
  const { orchestrator, sessionManager } = harness({
    mockRuns: [
      { output: 'boom', exitCode: 1 },
      { output: 'boom again', exitCode: 1 },
    ],
  });

  const events = [];
  orchestrator.on('session:crashed', () => events.push('crashed'));
  orchestrator.on('session:gave-up', () => events.push('gave-up'));

  const result = await orchestrator.runProject('testproj');

  assert.equal(result.complete, false);
  // maxConsecutiveCrashes = 2 → one restart, then give up.
  assert.deepEqual(events, ['crashed', 'gave-up']);

  // The mission is preserved and resumable — giving up is never abandoning.
  const preserved = sessionManager.getResumableSession('testproj');
  assert.ok(preserved);
  assert.equal(preserved.state, SessionState.GAVE_UP);
  assert.equal(preserved.crashes, 2);
});

test('maxRuns is a hard safety valve', async () => {
  const { orchestrator } = harness({
    mockRuns: [{ output: 'never finishing', exitCode: 0 }],
    maxRuns: 3,
  });

  const result = await orchestrator.runProject('testproj');

  assert.equal(result.complete, false);
  assert.match(result.reason, /maximum of 3 runs/);
  assert.equal(result.session.runs, 3);
});

test('a fresh start after give-up resumes the same engine conversation', async () => {
  const first = harness({
    mockRuns: [
      { output: 'boom', exitCode: 1 },
      { output: 'boom again', exitCode: 1 },
    ],
  });
  const firstResult = await first.orchestrator.runProject('testproj');
  const engineSessionId = firstResult.session.engineSessionId;
  assert.ok(engineSessionId);

  // New orchestrator instance, same session store (simulates a new process).
  const second = new Orchestrator({
    configManager: {
      getAll: () => TEST_CONFIG,
      getProject: () => ({
        name: 'testproj',
        driver: 'mock',
        mission: { completionMarker: 'MISSION COMPLETE', continuePrompt: 'continue', maxRuns: 0 },
        resolvedPromptFile: path.join(os.tmpdir(), 'unused.md'),
        mock: { runs: [{ output: 'MISSION COMPLETE', result: 'MISSION COMPLETE', exitCode: 0 }] },
      }),
    },
    driverRegistry: new DriverRegistry({ logger: silentLogger }),
    sessionManager: first.sessionManager,
    statusManager: first.statusManager,
    logger: silentLogger,
  });

  const events = [];
  second.on('session:recovered', () => events.push('recovered'));

  const result = await second.runProject('testproj');

  assert.equal(result.complete, true);
  assert.deepEqual(events, ['recovered']);
  // Same session record continued — not a restart from scratch.
  assert.equal(result.session.id, firstResult.session.id);
});
