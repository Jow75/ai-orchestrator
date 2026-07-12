/**
 * Unit tests for releaseManager.js — Phase 10J: draft generation from
 * mission data, the approval gate (auto in balanced for 'commit',
 * owner-gated when configured), and the apply steps against a temp
 * project (fake git).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReleaseManager } from '../src/release/releaseManager.js';
import { ApprovalManager } from '../src/approvals/approvalManager.js';
import { ApprovalStore } from '../src/approvals/approvalStore.js';
import { ORCHESTRATOR_DEFAULTS } from '../src/config/defaults.js';
import { silentLogger } from '../src/infra/logger.js';

function harness({ mode = 'balanced', approvalCategory = 'commit', queue = null, runs = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-release-'));
  const workingDirectory = path.join(root, 'project');
  fs.mkdirSync(workingDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(workingDirectory, 'package.json'),
    `${JSON.stringify({ name: 'target', version: '0.9.0' }, null, 2)}\n`
  );

  const store = new ApprovalStore({
    approvalsDir: path.join(root, 'approvals'), logger: silentLogger,
  });
  const approvalManager = new ApprovalManager({
    config: { ...ORCHESTRATOR_DEFAULTS.approvals, mode, decisionPollMs: 10 },
    store, providers: [], logger: silentLogger,
  });

  const gitCalls = [];
  const manager = new ReleaseManager({
    configManager: { getProject: () => ({ name: 'proj', workingDirectory }) },
    taskQueue: { load: () => queue },
    ledger: { recent: () => runs },
    approvalManager,
    releasesDir: path.join(root, 'releases'),
    releaseConfig: { tagPrefix: 'v', approvalCategory },
    logger: silentLogger,
    execGit: (args) => {
      gitCalls.push(args);
      return { ok: true, detail: 'faked' };
    },
  });
  return { manager, store, workingDirectory, gitCalls };
}

const QUEUE = {
  currentIndex: 2,
  tasks: [
    {
      id: 'T1', objective: 'build the API', state: 'done',
      checkpoint: {
        summary: 'API built with 3 endpoints', agentId: 'coder',
        verify: { passed: true, results: [{ type: 'command', passed: true, detail: 'tests pass' }] },
      },
    },
    {
      id: 'T2', objective: 'write docs', state: 'done',
      checkpoint: {
        summary: 'Docs written', agentId: 'writer',
        verify: { passed: true, results: [{ type: 'file-exists', passed: true, detail: 'Found' }] },
      },
    },
  ],
};

test('prepare() writes notes + verification report + release.json from mission data', () => {
  const { manager } = harness({
    queue: QUEUE,
    runs: [
      { progressed: true, durationMs: 60_000 },
      { progressed: false, durationMs: 30_000 },
    ],
  });
  const events = [];
  manager.on('release:created', (e) => events.push(e));

  const result = manager.prepare('proj', { version: '1.0.0', highlights: 'First stable cut.' });
  assert.equal(result.ok, true);

  const notes = fs.readFileSync(result.notesPath, 'utf8');
  assert.match(notes, /# proj v1\.0\.0/);
  assert.match(notes, /First stable cut\./);
  assert.match(notes, /\*\*T1\*\* — build the API/);
  assert.match(notes, /Runs: 2 \(1 made measurable progress\)/);

  const report = fs.readFileSync(result.reportPath, 'utf8');
  assert.match(report, /## T1 — done/);
  assert.match(report, /✔ \*\*command\*\* — tests pass/);

  assert.equal(events.length, 1);
  assert.equal(events[0].version, '1.0.0');
});

test('prepare() rejects a malformed version', () => {
  const { manager } = harness();
  assert.equal(manager.prepare('proj', { version: 'not-a-version' }).ok, false);
});

test('apply() in balanced mode auto-approves (commit is routine) and performs every step', async () => {
  const { manager, workingDirectory, gitCalls } = harness({ queue: QUEUE });
  manager.prepare('proj', { version: '1.0.0' });

  const result = await manager.apply('proj', { version: '1.0.0' });
  assert.equal(result.ok, true, JSON.stringify(result.steps));

  const pkg = JSON.parse(fs.readFileSync(path.join(workingDirectory, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '1.0.0');

  const changelog = fs.readFileSync(path.join(workingDirectory, 'CHANGELOG.md'), 'utf8');
  assert.match(changelog, /^## v1\.0\.0 — \d{4}-\d{2}-\d{2}/);

  // git add → commit → tag, and NEVER a push.
  assert.deepEqual(gitCalls.map((args) => args[0]), ['add', 'commit', 'tag']);
  assert.deepEqual(gitCalls[2], ['tag', 'v1.0.0']);
});

test('apply() with an owner-gated category pauses; an approved request is consumed on rerun', async () => {
  const { manager, store } = harness({ queue: QUEUE, approvalCategory: 'production-deployment' });
  manager.prepare('proj', { version: '2.0.0' });

  const paused = await manager.apply('proj', { version: '2.0.0' });
  assert.equal(paused.ok, false);
  assert.ok(paused.pendingRequest);

  // The owner approves out-of-band (CLI/Telegram/desktop)...
  store.resolve('proj', paused.pendingRequest.id, { decision: 'approved', via: 'cli' });

  // ...and the rerun uses (and consumes) that approval.
  const applied = await manager.apply('proj', { version: '2.0.0' });
  assert.equal(applied.ok, true);
  const consumed = store.get('proj', paused.pendingRequest.id);
  assert.ok(consumed.details.consumedAt);

  // A THIRD run must not reuse the consumed approval.
  const third = await manager.apply('proj', { version: '2.0.0' });
  assert.equal(third.ok, false);
  assert.ok(third.pendingRequest);
});

test('apply() without a prepared release refuses clearly', async () => {
  const { manager } = harness();
  const result = await manager.apply('proj', { version: '9.9.9' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /release prepare/);
});
