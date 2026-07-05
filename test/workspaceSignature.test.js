/**
 * Tests for workspace progress measurement (git-aware, filescan fallback,
 * fail-closed behaviour).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { computeWorkspaceSignature } from '../src/progress/workspaceSignature.js';
import { silentLogger } from '../src/infra/logger.js';

function tempDir(prefix = 'aio-sig-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('missing directory fails closed (hash null)', () => {
  const sig = computeWorkspaceSignature(path.join(os.tmpdir(), 'does-not-exist-xyz'));
  assert.equal(sig.hash, null);
  assert.equal(sig.method, 'none');
});

test('filescan: identical content → identical signature', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  const first = computeWorkspaceSignature(dir);
  const second = computeWorkspaceSignature(dir);
  assert.equal(first.method, 'filescan');
  assert.equal(first.hash, second.hash);
  assert.ok(first.hash);
});

test('filescan: adding a file changes the signature (progress detected)', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  const before = computeWorkspaceSignature(dir).hash;
  fs.writeFileSync(path.join(dir, 'b.txt'), 'world');
  const after = computeWorkspaceSignature(dir).hash;
  assert.notEqual(before, after);
});

test('filescan: ignores node_modules noise', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  const before = computeWorkspaceSignature(dir).hash;
  fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'index.js'), 'x');
  const after = computeWorkspaceSignature(dir).hash;
  assert.equal(before, after, 'node_modules changes must not count as progress');
});

test('git: an uncommitted edit changes the signature', () => {
  const dir = tempDir('aio-siggit-');
  try {
    execFileSync('git', ['-C', dir, 'init', '-q'], { stdio: 'ignore' });
    execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t'], { stdio: 'ignore' });
    execFileSync('git', ['-C', dir, 'config', 'user.name', 't'], { stdio: 'ignore' });
  } catch {
    return; // git not available in this environment — skip
  }
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one');
  const sig1 = computeWorkspaceSignature(dir);
  assert.equal(sig1.method, 'git');
  const before = sig1.hash;

  fs.writeFileSync(path.join(dir, 'a.txt'), 'two'); // same status line, new content
  const after = computeWorkspaceSignature(dir).hash;
  assert.notEqual(before, after, 'content edits must move the signature even if git status is unchanged');
});
