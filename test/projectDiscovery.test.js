/**
 * Unit tests for operator/projectDiscovery.js (Phase 13 M2) — the algorithm
 * details commandRouter.test.js's real-installation harness can't easily
 * exercise: self-exclusion of AI-Orchestrator's own checkout, nested-repo
 * boundaries, and duplicate basenames under two different roots.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanRoots } from '../src/operator/projectDiscovery.js';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aio-discover-'));
}

function mkdir(...segments) {
  const dir = path.join(...segments);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function touch(dir, file) {
  fs.writeFileSync(path.join(dir, file), '');
}

test('a directory with a marker file is a candidate', () => {
  const root = tmpRoot();
  const p = mkdir(root, 'my-app');
  touch(p, 'package.json');

  const { candidates } = scanRoots([root]);

  assert.deepEqual(candidates, [{ name: 'my-app', path: p }]);
});

test('a directory with no marker at all is never a candidate', () => {
  const root = tmpRoot();
  mkdir(root, 'random-stuff');

  const { candidates } = scanRoots([root]);

  assert.deepEqual(candidates, []);
});

test('a marker found deeper than maxDepth does not count', () => {
  const root = tmpRoot();
  const p = mkdir(root, 'shallow');
  const deep = mkdir(p, 'a', 'b', 'c');
  touch(deep, 'package.json'); // 3 levels deep, default maxDepth is 2

  const { candidates } = scanRoots([root]);

  assert.deepEqual(candidates, []);
});

test('an ignored folder name is never a candidate, and is never descended into for markers', () => {
  const root = tmpRoot();
  const nm = mkdir(root, 'node_modules');
  touch(nm, 'package.json');

  const { candidates } = scanRoots([root]);

  assert.deepEqual(candidates, []);
});

test('a directory containing .git is a scan leaf — markers belonging to a nested project do not surface it', () => {
  const root = tmpRoot();
  const repo = mkdir(root, 'a-real-repo');
  touch(repo, '.git'); // stand-in for the real .git directory; presence is what matters
  const nested = mkdir(repo, 'examples', 'demo');
  touch(nested, 'package.json'); // a nested, unrelated project marker

  const { candidates } = scanRoots([root]);

  // The repo itself IS a candidate (it has its own .git marker); the nested
  // demo is never independently discovered.
  assert.deepEqual(candidates, [{ name: 'a-real-repo', path: repo }]);
});

test('AI-Orchestrator\'s own checkout is never discovered, even as a direct child of a configured root', () => {
  const root = tmpRoot();
  const selfRoot = mkdir(root, 'AI-Orchestrator'); // stands in for the real ROOT_DIR
  touch(selfRoot, 'package.json');
  const sibling = mkdir(root, 'a-real-project');
  touch(sibling, 'package.json');

  const { candidates } = scanRoots([root], { selfRoot });

  assert.deepEqual(candidates, [{ name: 'a-real-project', path: sibling }]);
});

test('an already-registered workingDirectory is excluded, even with different casing/slashes', () => {
  const root = tmpRoot();
  const p = mkdir(root, 'registered');
  touch(p, 'package.json');

  const { candidates } = scanRoots([root], { existingDirs: [p.toUpperCase()] });

  assert.deepEqual(candidates, []);
});

test('two different directories that share a basename under different roots are BOTH reported, not collapsed', () => {
  const rootA = tmpRoot();
  const rootB = tmpRoot();
  const a = mkdir(rootA, 'demo');
  const b = mkdir(rootB, 'demo');
  touch(a, 'package.json');
  touch(b, 'package.json');

  const { candidates } = scanRoots([rootA, rootB]);

  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.map((c) => c.path).sort(), [a, b].sort());
});

test('the same real directory reached via two configured roots is reported only once', () => {
  const root = tmpRoot();
  const p = mkdir(root, 'dupe');
  touch(p, 'package.json');

  const { candidates } = scanRoots([root, root]); // the same root listed twice

  assert.equal(candidates.length, 1);
});

test('a missing configured root is reported, not thrown', () => {
  const { candidates, rootsScanned, rootsMissing } = scanRoots(['C:\\definitely\\not\\a\\real\\path\\xyz']);
  assert.deepEqual(candidates, []);
  assert.deepEqual(rootsScanned, []);
  assert.equal(rootsMissing.length, 1);
});

test('an empty or undefined roots list scans nothing and throws nothing', () => {
  assert.deepEqual(scanRoots([]).candidates, []);
  assert.deepEqual(scanRoots(undefined).candidates, []);
});

test('custom markers/ignore/maxDepth are honoured', () => {
  const root = tmpRoot();
  const p = mkdir(root, 'python-thing');
  touch(p, 'setup.cfg'); // not in the default marker list

  assert.deepEqual(scanRoots([root]).candidates, []); // default markers miss it
  assert.deepEqual(
    scanRoots([root], { markers: ['setup.cfg'] }).candidates,
    [{ name: 'python-thing', path: p }]
  );
});
