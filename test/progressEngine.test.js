/**
 * Tests for the Phase P1 progress engine: structured change facts
 * (created/modified/deleted), git-commit detection, snapshot persistence,
 * and the fix for the P0 gap where git-ignored directories registered as
 * "no progress" even when the agent legitimately worked inside them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ProgressEngine, diffSnapshots, sampleChanges } from '../src/progress/progressEngine.js';
import { silentLogger } from '../src/infra/logger.js';

function tempDir(prefix = 'aio-pe-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function engine() {
  const progressDir = tempDir('aio-pe-state-');
  return new ProgressEngine({ progressDir, logger: silentLogger });
}

function project(workspace, name = 'p') {
  return { name, workingDirectory: workspace };
}

test('baseline() persists a snapshot and returns its hash', () => {
  const e = engine();
  const ws = tempDir();
  fs.writeFileSync(path.join(ws, 'a.txt'), 'hello');

  const hash = e.baseline(project(ws));
  assert.ok(hash);
  assert.ok(e.loadSnapshot('p'));
});

test('baseline() on a missing directory returns null (fails closed)', () => {
  const e = engine();
  const hash = e.baseline(project(path.join(os.tmpdir(), 'does-not-exist-xyz')));
  assert.equal(hash, null);
});

test('analyze(): no prior snapshot means changes is null but hash is still computed', () => {
  const e = engine();
  const ws = tempDir();
  fs.writeFileSync(path.join(ws, 'a.txt'), 'hello');

  const report = e.analyze(project(ws));
  assert.ok(report.hash);
  assert.equal(report.changes, null);
});

test('analyze(): detects created, modified, and deleted files across two runs', () => {
  const e = engine();
  const ws = tempDir();
  fs.writeFileSync(path.join(ws, 'keep.txt'), 'v1');
  fs.writeFileSync(path.join(ws, 'remove.txt'), 'bye');
  e.baseline(project(ws));

  fs.writeFileSync(path.join(ws, 'keep.txt'), 'v2'); // modified
  fs.writeFileSync(path.join(ws, 'new.txt'), 'new'); // created
  fs.rmSync(path.join(ws, 'remove.txt')); // deleted

  const report = e.analyze(project(ws));
  assert.deepEqual(report.changes.created, ['new.txt']);
  assert.deepEqual(report.changes.modified, ['keep.txt']);
  assert.deepEqual(report.changes.deleted, ['remove.txt']);
  assert.deepEqual(report.changes.counts, { created: 1, modified: 1, deleted: 1 });
});

test('diffSnapshots() returns COMPLETE, untruncated lists even for >25 changed files', () => {
  // Regression guard: verification (files-changed) reads these lists
  // directly, so silently truncating here would be a correctness bug, not
  // a cosmetic one (see sampleChanges() for the display-only cap).
  const prevFiles = {};
  const currFiles = {};
  for (let i = 0; i < 40; i += 1) currFiles[`file${i}.txt`] = '1:100';
  const diff = diffSnapshots({ files: prevFiles }, { files: currFiles });
  assert.equal(diff.created.length, 40);
  assert.equal(diff.counts.created, 40);
});

test('sampleChanges() caps each list for display without touching counts', () => {
  const full = { created: Array.from({ length: 40 }, (_, i) => `f${i}`), modified: [], deleted: [],
    counts: { created: 40, modified: 0, deleted: 0 }, committed: false };
  const sampled = sampleChanges(full, 25);
  assert.equal(sampled.created.length, 25);
  assert.equal(sampled.counts.created, 40); // counts stay accurate
});

test('sampleChanges(null) is a safe no-op', () => {
  assert.equal(sampleChanges(null), null);
});

test('analyze(): identical workspace across two calls yields no changes', () => {
  const e = engine();
  const ws = tempDir();
  fs.writeFileSync(path.join(ws, 'a.txt'), 'stable');
  e.baseline(project(ws));

  const report = e.analyze(project(ws));
  assert.deepEqual(report.changes.counts, { created: 0, modified: 0, deleted: 0 });
  // A successful scan that found no change is a trustworthy "no progress"
  // verdict (medium) — 'low' is reserved for workspaces we could not
  // measure at all (method 'none'), not for a clean scan result.
  assert.equal(report.confidence.level, 'medium');
});

test('ignores noise directories (node_modules) by default', () => {
  const e = engine();
  const ws = tempDir();
  fs.writeFileSync(path.join(ws, 'a.txt'), 'x');
  e.baseline(project(ws));

  fs.mkdirSync(path.join(ws, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'node_modules', 'pkg', 'index.js'), 'noise');

  const report = e.analyze(project(ws));
  assert.deepEqual(report.changes.counts, { created: 0, modified: 0, deleted: 0 });
});

test('THE P0 GAP FIX: work inside a git-ignored directory now counts as progress', () => {
  // In P0, computeWorkspaceSignature relied on `git status`, so anything
  // matched by .gitignore was invisible. P1 scans the real filesystem
  // (skipping only noise dirs, not respecting .gitignore), so this must
  // now register as progress.
  const e = engine();
  const ws = tempDir();
  let gitAvailable = true;
  try {
    execFileSync('git', ['-C', ws, 'init', '-q'], { stdio: 'ignore' });
    execFileSync('git', ['-C', ws, 'config', 'user.email', 't@t'], { stdio: 'ignore' });
    execFileSync('git', ['-C', ws, 'config', 'user.name', 't'], { stdio: 'ignore' });
    fs.writeFileSync(path.join(ws, '.gitignore'), 'ignored-dir/\n');
  } catch {
    gitAvailable = false;
  }
  if (!gitAvailable) return; // skip when git is unavailable in this environment

  e.baseline(project(ws));

  fs.mkdirSync(path.join(ws, 'ignored-dir'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'ignored-dir', 'output.log'), 'real agent output here');

  const report = e.analyze(project(ws));
  assert.equal(report.changes.counts.created, 1);
  assert.deepEqual(report.changes.created, ['ignored-dir/output.log']);
});

test('git commit between runs is flagged as `committed` and raises confidence', () => {
  const e = engine();
  const ws = tempDir();
  let gitAvailable = true;
  try {
    execFileSync('git', ['-C', ws, 'init', '-q'], { stdio: 'ignore' });
    execFileSync('git', ['-C', ws, 'config', 'user.email', 't@t'], { stdio: 'ignore' });
    execFileSync('git', ['-C', ws, 'config', 'user.name', 't'], { stdio: 'ignore' });
  } catch {
    gitAvailable = false;
  }
  if (!gitAvailable) return;

  fs.writeFileSync(path.join(ws, 'a.txt'), 'v1');
  execFileSync('git', ['-C', ws, 'add', '.'], { stdio: 'ignore' });
  execFileSync('git', ['-C', ws, 'commit', '-q', '-m', 'init'], { stdio: 'ignore' });
  e.baseline(project(ws));

  fs.writeFileSync(path.join(ws, 'b.txt'), 'v2');
  execFileSync('git', ['-C', ws, 'add', '.'], { stdio: 'ignore' });
  execFileSync('git', ['-C', ws, 'commit', '-q', '-m', 'work'], { stdio: 'ignore' });

  const report = e.analyze(project(ws));
  assert.equal(report.changes.committed, true);
  assert.ok(report.confidence.signals.includes('git-commit'));
  assert.equal(report.confidence.level, 'high');
});

test('diffSnapshots is a pure function usable independently', () => {
  const prev = { head: 'a', files: { 'x.txt': '1:100' } };
  const curr = { head: 'a', files: { 'x.txt': '2:200', 'y.txt': '1:50' } };
  const diff = diffSnapshots(prev, curr);
  assert.deepEqual(diff.created, ['y.txt']);
  assert.deepEqual(diff.modified, ['x.txt']);
  assert.deepEqual(diff.deleted, []);
  assert.equal(diff.committed, false); // same head
});

test('snapshot survives being reloaded by a fresh ProgressEngine instance (persistence)', () => {
  const progressDir = tempDir('aio-pe-persist-');
  const ws = tempDir();
  fs.writeFileSync(path.join(ws, 'a.txt'), 'hello');

  const first = new ProgressEngine({ progressDir, logger: silentLogger });
  first.baseline(project(ws));

  fs.writeFileSync(path.join(ws, 'b.txt'), 'world');

  const second = new ProgressEngine({ progressDir, logger: silentLogger });
  const report = second.analyze(project(ws));
  assert.deepEqual(report.changes.created, ['b.txt']);
});
