/**
 * Unit tests for operator/gitVisibility.js (Phase 14 M1) — real git facts
 * for the `/git` command: branch, dirty state, HEAD, recent commits, and
 * ahead/behind. Runs against a real, throwaway git work tree the same way
 * projectRegistry.test.js's own git tests do — no mocking of `git` itself.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isGitRepo, gitReport } from '../src/operator/gitVisibility.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aio-gitvis-'));
}

function makeRepo({ branch = 'main' } = {}) {
  const dir = tmpDir();
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], {
    stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
  });
  git('init', '-b', branch);
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  return { dir, git };
}

test('a non-repo directory is not a git repo, and gitReport() returns null', () => {
  const dir = tmpDir();
  assert.equal(isGitRepo(dir), false);
  assert.equal(gitReport(dir), null);
});

test('a fresh repo with no commits reports branch and "no commits yet", never invented facts', () => {
  const { dir } = makeRepo({ branch: 'payroll' });
  assert.equal(isGitRepo(dir), true);

  const report = gitReport(dir);
  assert.equal(report.branch, 'payroll');
  assert.equal(report.head, null);
  assert.deepEqual(report.recentCommits, []);
  assert.equal(report.aheadBehind, null);
});

test('a clean repo after one commit reports HEAD, one recent commit, and dirty:false', () => {
  const { dir, git } = makeRepo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  git('add', '.');
  git('commit', '-m', 'first commit');

  const report = gitReport(dir);
  assert.equal(report.branch, 'main');
  assert.match(report.head.hash, /^[0-9a-f]{7,}$/);
  assert.equal(report.head.subject, 'first commit');
  assert.equal(report.status.dirty, false);
  assert.equal(report.status.changedCount, 0);
  assert.equal(report.recentCommits.length, 1);
  assert.equal(report.recentCommits[0].subject, 'first commit');
});

test('uncommitted changes are reported dirty with a changed-file count', () => {
  const { dir, git } = makeRepo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  git('add', '.');
  git('commit', '-m', 'first commit');

  fs.writeFileSync(path.join(dir, 'a.txt'), 'changed');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'new file');

  const report = gitReport(dir);
  assert.equal(report.status.dirty, true);
  assert.equal(report.status.changedCount, 2);
});

test('recent commits are capped at commitCount, newest first', () => {
  const { dir, git } = makeRepo();
  for (let i = 1; i <= 5; i += 1) {
    fs.writeFileSync(path.join(dir, `f${i}.txt`), String(i));
    git('add', '.');
    git('commit', '-m', `commit ${i}`);
  }

  const report = gitReport(dir, { commitCount: 3 });
  assert.equal(report.recentCommits.length, 3);
  assert.deepEqual(report.recentCommits.map((c) => c.subject), ['commit 5', 'commit 4', 'commit 3']);
});

test('a branch with no upstream reports aheadBehind as null, not a fabricated 0/0', () => {
  const { dir, git } = makeRepo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  git('add', '.');
  git('commit', '-m', 'first commit');

  assert.equal(gitReport(dir).aheadBehind, null);
});

test('a branch tracking a local upstream reports real ahead/behind counts', () => {
  const upstream = makeRepo({ branch: 'main' });
  fs.writeFileSync(path.join(upstream.dir, 'a.txt'), 'hello');
  upstream.git('add', '.');
  upstream.git('commit', '-m', 'upstream commit');

  const cloneDir = tmpDir();
  execFileSync('git', ['clone', upstream.dir, cloneDir], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  const cloneGit = (...args) => execFileSync('git', ['-C', cloneDir, ...args], {
    stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
  });
  cloneGit('config', 'user.email', 'test@example.com');
  cloneGit('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(cloneDir, 'b.txt'), 'local work');
  cloneGit('add', '.');
  cloneGit('commit', '-m', 'local-only commit');

  const report = gitReport(cloneDir);
  assert.deepEqual(report.aheadBehind, { ahead: 1, behind: 0 });
});
