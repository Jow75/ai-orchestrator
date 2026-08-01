/**
 * Unit tests for operator/missionTemplates.js (Phase 14 M6) — the fixed
 * objective text `/review`, `/architecture`, `/docgen`, and `/refactor`
 * submit as mission requests. Runs `buildReviewObjective()` against real,
 * throwaway git work trees (no repo / clean / dirty), the same way
 * gitVisibility.test.js and repoSearch.test.js test their own real-disk
 * primitives — no mocking of `git` itself.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  buildReviewObjective, buildArchitectureObjective, buildDocgenObjective, buildRefactorObjective,
} from '../src/operator/missionTemplates.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aio-missiontpl-'));
}

function makeRepo({ dirty = false } = {}) {
  const dir = tmpDir();
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], {
    stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
  });
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  git('add', '.');
  git('commit', '-m', 'first commit');
  if (dirty) fs.writeFileSync(path.join(dir, 'a.txt'), 'changed');
  return dir;
}

// ───────────────────────────────────────────────────────── buildReviewObjective ──

test('reviewing a non-git directory asks for a whole-project review, never a fabricated diff', () => {
  const objective = buildReviewObjective(tmpDir());
  assert.match(objective, /not a git repository/);
  assert.match(objective, /review the project's source code as a whole/i);
  assert.doesNotMatch(objective, /git diff/);
});

test('reviewing a dirty repo asks for the uncommitted diff', () => {
  const objective = buildReviewObjective(makeRepo({ dirty: true }));
  assert.match(objective, /current uncommitted changes/);
  assert.match(objective, /git status.*git diff/);
});

test('reviewing a clean repo asks for the recent commit(s), not a diff that does not exist', () => {
  const objective = buildReviewObjective(makeRepo({ dirty: false }));
  assert.match(objective, /no uncommitted changes/);
  assert.match(objective, /most recent commit/);
  assert.doesNotMatch(objective, /git diff/, 'a clean repo has no diff to point the mission at');
});

test('every review variant carries the same ground rules: real problems only, no fabricated fixes', () => {
  for (const objective of [
    buildReviewObjective(tmpDir()),
    buildReviewObjective(makeRepo({ dirty: true })),
    buildReviewObjective(makeRepo({ dirty: false })),
  ]) {
    assert.match(objective, /bugs, correctness issues, security concerns/);
    assert.match(objective, /Do NOT modify any files/);
  }
});

// ─────────────────────────────────────────────────── buildArchitectureObjective ──

test('the architecture objective is fixed and read-only', () => {
  const objective = buildArchitectureObjective();
  assert.match(objective, /components\/modules/);
  assert.match(objective, /Do NOT modify any files/);
  assert.equal(objective, buildArchitectureObjective(), 'no randomness — same text every call');
});

// ────────────────────────────────────────────────────────── buildDocgenObjective ──

test('the docgen objective embeds the exact target path, verbatim', () => {
  const objective = buildDocgenObjective('src/operator/commandRouter.js');
  assert.match(objective, /Draft documentation for: src\/operator\/commandRouter\.js/);
  assert.match(objective, /public interface/);
});

// ──────────────────────────────────────────────────────── buildRefactorObjective ──

test('the refactor objective embeds the description and refuses implementation, even post-approval', () => {
  const objective = buildRefactorObjective('extract the retry logic into its own module');
  assert.match(objective, /PROPOSAL for: extract the retry logic into its own module/);
  assert.match(objective, /Do NOT implement/);
  assert.match(objective, /not even after your plan is approved/);
  assert.match(objective, /separate, later mission request/);
});
