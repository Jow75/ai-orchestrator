/**
 * Tests for missionCard.js (Phase 11 M2) — the executive Mission Card
 * builder. Every field must come from real, passed-in data; nothing here
 * invents a fact the caller didn't supply.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildMissionCard, renderMissionCardText, renderArtifactSummary } from '../src/notifications/missionCard.js';

test('a bare card (no session/queue) still has project + status', () => {
  const card = buildMissionCard({ project: 'p', status: 'complete' });
  assert.deepEqual(card, { project: 'p', status: 'complete' });
});

test('duration is computed from session.createdAt', () => {
  const createdAt = new Date(Date.now() - 65_000).toISOString();
  const card = buildMissionCard({ project: 'p', session: { createdAt } });
  assert.ok(card.duration); // formatDuration's exact string isn't asserted here
  assert.match(card.duration, /\d/);
});

test('resumes/crashes are surfaced only when non-zero (no noise on a clean run)', () => {
  const clean = buildMissionCard({ project: 'p', session: { createdAt: new Date().toISOString(), runs: 1, resumes: 0, crashes: 0 } });
  assert.equal(clean.resumes, undefined);
  assert.equal(clean.crashes, undefined);
  assert.equal(clean.runs, 1);

  const rocky = buildMissionCard({ project: 'p', session: { createdAt: new Date().toISOString(), runs: 4, resumes: 2, crashes: 1 } });
  assert.equal(rocky.resumes, 2);
  assert.equal(rocky.crashes, 1);
});

test('task/file/test aggregation across a completed queue', () => {
  const queue = {
    tasks: [
      {
        state: 'done',
        checkpoint: {
          filesTouched: ['a.js', 'b.js'], filesDeleted: [],
          verify: { passed: true, results: [{ type: 'file-exists', passed: true }, { type: 'command', passed: true }] },
        },
      },
      {
        state: 'done',
        checkpoint: {
          filesTouched: ['b.js', 'c.js'], filesDeleted: ['old.js'], // b.js overlaps -> deduped
          verify: { passed: true, results: [{ type: 'command', passed: true }] },
        },
      },
    ],
  };
  const card = buildMissionCard({ project: 'p', queue });
  assert.equal(card.tasksDone, 2);
  assert.equal(card.tasksTotal, 2);
  assert.deepEqual(new Set(card.filesChanged), new Set(['a.js', 'b.js', 'c.js', 'old.js (deleted)']));
  assert.deepEqual(card.tests, { passed: 3, total: 3 });
  assert.equal(card.confidence, 'verified');
});

test('confidence is "partial" when some verifiers failed, "unverified" when none ran at all', () => {
  const partial = buildMissionCard({
    project: 'p',
    queue: { tasks: [{ state: 'done', checkpoint: { verify: { results: [{ passed: true }, { passed: false }] } } }] },
  });
  assert.equal(partial.confidence, 'partial');
  assert.deepEqual(partial.tests, { passed: 1, total: 2 });

  const unverified = buildMissionCard({
    project: 'p',
    queue: { tasks: [{ state: 'done', checkpoint: { filesTouched: ['a.js'], verify: null } }] },
  });
  assert.equal(unverified.confidence, 'unverified');
  assert.equal(unverified.tests, undefined);
});

// ─────────────────────── the completion marker is not a test ────────────────
//
// Regression for the 2026-07-28 live validation. A mock-driver mission that
// wrote nothing came back as "Tests: 1/1 passed · Confidence: Verified". Its
// only verifier result was the `marker` fallback — the agent's own claim that
// it had finished. A claim is not a check.

test('the completion marker is not counted as a passing test', () => {
  const card = buildMissionCard({
    project: 'p',
    queue: {
      tasks: [{
        state: 'done',
        checkpoint: {
          filesTouched: [], filesDeleted: [],
          verify: { passed: true, results: [{ type: 'marker', passed: true, detail: 'Completion marker found' }] },
        },
      }],
    },
  });
  assert.equal(card.tests, undefined, 'a marker produces no test count at all');
  assert.equal(card.confidence, 'unverified',
    'a task whose only "result" was the agent announcing success is unverified');
});

test('real verifiers still count when a marker sits alongside them', () => {
  const card = buildMissionCard({
    project: 'p',
    queue: {
      tasks: [{
        state: 'done',
        checkpoint: {
          filesTouched: ['a.js'],
          verify: {
            passed: true,
            results: [
              { type: 'marker', passed: true },
              { type: 'command', passed: true },
              { type: 'file-exists', passed: true },
            ],
          },
        },
      }],
    },
  });
  assert.deepEqual(card.tests, { passed: 2, total: 2 }, 'the marker is excluded, the two real checks are not');
  assert.equal(card.confidence, 'verified');
});

test('a completed mission that touched no file says so', () => {
  const card = buildMissionCard({
    project: 'p',
    status: 'complete',
    queue: { tasks: [{ state: 'done', checkpoint: { filesTouched: [], filesDeleted: [], verify: null } }] },
  });
  assert.equal(card.noFilesChanged, true);
  assert.match(renderMissionCardText(card), /completed without writing anything/);

  const wrote = buildMissionCard({
    project: 'p',
    status: 'complete',
    queue: { tasks: [{ state: 'done', checkpoint: { filesTouched: ['a.js'], verify: null } }] },
  });
  assert.equal(wrote.noFilesChanged, undefined);
});

test('a simulated mission is disclosed above its status line', () => {
  const card = buildMissionCard({ project: 'p', status: 'complete', simulated: true });
  assert.equal(card.simulated, true);

  const text = renderMissionCardText(card);
  assert.match(text, /Simulated project/);
  assert.ok(
    text.indexOf('Simulated project') < text.indexOf('Status:'),
    'a notification preview shows the first line — "complete" must not travel alone'
  );

  assert.doesNotMatch(
    renderMissionCardText(buildMissionCard({ project: 'p', status: 'complete' })),
    /Simulated/,
    'a real mission carries no notice'
  );
});

// Phase 13 M7: found via this milestone's own live validation — a simulated
// mission whose mock driver actually wrote real (scripted) files must never
// say "no code was written" one line above a real "Created:" list.
test('a simulated mission that DID write real (scripted) files never claims "no code was written"', () => {
  const card = buildMissionCard({
    project: 'p', status: 'complete', simulated: true,
    queue: { tasks: [{ state: 'done', checkpoint: { filesCreated: ['a.js'], filesModified: [], filesDeleted: [] } }] },
  });
  const text = renderMissionCardText(card);
  assert.doesNotMatch(text, /no code was written/);
  assert.match(text, /Simulated project — this mission was a rehearsal/);
});

test('a simulated mission that wrote nothing keeps the original, accurate notice', () => {
  const card = buildMissionCard({ project: 'p', status: 'complete', simulated: true });
  assert.match(renderMissionCardText(card), /no code was written/);
});

test('a task with no checkpoint yet (still pending) is counted but contributes nothing else', () => {
  const card = buildMissionCard({
    project: 'p',
    queue: { tasks: [{ state: 'done', checkpoint: { filesTouched: ['a.js'], verify: null } }, { state: 'pending', checkpoint: null }] },
  });
  assert.equal(card.tasksDone, 1);
  assert.equal(card.tasksTotal, 2);
  assert.deepEqual(card.filesChanged, ['a.js']);
});

test('reason, operatorAction, and nextRecommendation pass through only when supplied', () => {
  const bare = buildMissionCard({ project: 'p' });
  assert.equal(bare.reason, undefined);
  assert.equal(bare.operatorAction, undefined);
  assert.equal(bare.nextRecommendation, undefined);

  const full = buildMissionCard({
    project: 'p', status: 'blocked', reason: 'approval rejected',
    operatorAction: 'tasks approve p DEPLOY', nextRecommendation: 'review the plan and retry',
  });
  assert.equal(full.reason, 'approval rejected');
  assert.equal(full.operatorAction, 'tasks approve p DEPLOY');
  assert.equal(full.nextRecommendation, 'review the plan and retry');
});

test('commit resolves the REAL git HEAD of the working directory, truncated', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-card-git-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'f.txt'), 'x');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  const realHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

  const card = buildMissionCard({ project: 'p', workingDirectory: dir });
  assert.equal(card.commit, realHead.slice(0, 12));
});

test('commit is omitted (never invented) when the directory is not a git repo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-card-nogit-'));
  const card = buildMissionCard({ project: 'p', workingDirectory: dir });
  assert.equal(card.commit, undefined);
});

// ── renderMissionCardText ───────────────────────────────────────────────

test('renders a minimal card without crashing on missing optional fields', () => {
  const text = renderMissionCardText({ project: 'p', status: 'complete' });
  assert.match(text, /Mission: p/);
  assert.match(text, /Status: ✅ Complete/);
});

test('renders every populated field, in a stable, readable order', () => {
  const card = {
    project: 'demo', status: 'complete', duration: '5m 12s',
    tasksDone: 3, tasksTotal: 3, tests: { passed: 5, total: 5 }, confidence: 'verified',
    filesChanged: ['a.js', 'b.js'], commit: 'abc123def456',
    reason: 'all tasks completed and verified',
  };
  const text = renderMissionCardText(card);
  assert.match(text, /Duration: 5m 12s/);
  assert.match(text, /Tasks: 3\/3 done/);
  assert.match(text, /Tests: 5\/5 passed/);
  assert.match(text, /Confidence: Verified/);
  assert.match(text, /Files changed \(2\): a\.js, b\.js/);
  assert.match(text, /Commit: abc123def456/);
  assert.match(text, /Reason: all tasks completed and verified/);
});

test('a blocked card surfaces operatorAction as the actionable next step', () => {
  const text = renderMissionCardText({
    project: 'p', status: 'blocked', reason: 'approval A7 was rejected',
    operatorAction: 'ai-orchestrator tasks approve p DEPLOY',
  });
  assert.match(text, /Status: ⛔ Blocked/);
  assert.match(text, /Action needed: ai-orchestrator tasks approve p DEPLOY/);
});

test('a long file list is truncated with a "+N more" summary', () => {
  const filesChanged = Array.from({ length: 12 }, (_, i) => `file${i}.js`);
  const text = renderMissionCardText({ project: 'p', status: 'complete', filesChanged });
  assert.match(text, /Files changed \(12\):.*\+4 more/);
});

// ── created/modified/deleted aggregation (Phase 13 M7) ────────────────────

test('buildMissionCard separates created from modified when checkpoints supply the split', () => {
  const queue = {
    tasks: [
      { state: 'done', checkpoint: { filesCreated: ['a.js'], filesModified: ['b.js'], filesDeleted: [] } },
      { state: 'done', checkpoint: { filesCreated: ['c.js'], filesModified: ['b.js'], filesDeleted: ['old.js'] } },
    ],
  };
  const card = buildMissionCard({ project: 'p', queue });
  assert.deepEqual(new Set(card.filesCreated), new Set(['a.js', 'c.js']));
  assert.deepEqual(card.filesModified, ['b.js']); // deduped across tasks
  assert.deepEqual(card.filesDeleted, ['old.js']);
});

test('a legacy checkpoint (filesTouched only, no split) produces no filesCreated/filesModified', () => {
  const queue = {
    tasks: [{ state: 'done', checkpoint: { filesTouched: ['a.js', 'b.js'], filesDeleted: [] } }],
  };
  const card = buildMissionCard({ project: 'p', queue });
  assert.equal(card.filesCreated, undefined);
  assert.equal(card.filesModified, undefined);
  assert.deepEqual(card.filesChanged, ['a.js', 'b.js']); // still available, just unsplit
});

// ── renderArtifactSummary (Phase 13 M7) ────────────────────────────────────

test('renderArtifactSummary lists real paths under Created/Modified/Deleted, uncapped', () => {
  const files = Array.from({ length: 20 }, (_, i) => `src/file${i}.js`);
  const card = { filesCreated: files, filesModified: ['package.json'], filesDeleted: ['old.js'] };
  const text = renderArtifactSummary(card);
  assert.match(text, /^Created:/);
  for (const f of files) assert.ok(text.includes(`• ${f}`), `missing ${f}`);
  assert.match(text, /Modified:\n• package\.json/);
  assert.match(text, /Deleted:\n• old\.js/);
});

test('renderArtifactSummary omits a bucket entirely when it is empty', () => {
  const text = renderArtifactSummary({ filesCreated: ['a.js'] });
  assert.match(text, /Created:/);
  assert.doesNotMatch(text, /Modified:/);
  assert.doesNotMatch(text, /Deleted:/);
});

test('renderArtifactSummary falls back to a neutral "Changed" heading for legacy data (never invents a split)', () => {
  const text = renderArtifactSummary({ filesChanged: ['a.js', 'b.js (deleted)'] });
  assert.match(text, /^Changed:/);
  assert.ok(text.includes('• a.js'));
  assert.ok(text.includes('• b.js (deleted)'));
  assert.doesNotMatch(text, /Created:|Modified:|Deleted:/);
});

test('renderArtifactSummary is empty when the card has nothing to report', () => {
  assert.equal(renderArtifactSummary({}), '');
  assert.equal(renderArtifactSummary({ noFilesChanged: true }), '');
});
