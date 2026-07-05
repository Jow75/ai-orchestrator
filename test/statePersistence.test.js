/**
 * Tests for crash-safe state storage: atomic writes, corruption quarantine,
 * and torn-line-tolerant history files.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  writeJsonAtomic,
  readJsonSafe,
  appendJsonl,
  readJsonl,
} from '../src/state/statePersistence.js';
import { silentLogger } from '../src/infra/logger.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aio-test-'));
}

test('writeJsonAtomic + readJsonSafe round-trip', () => {
  const file = path.join(tempDir(), 'state.json');
  writeJsonAtomic(file, { hello: 'world', n: 42 });
  assert.deepEqual(readJsonSafe(file), { hello: 'world', n: 42 });
});

test('writeJsonAtomic creates parent directories and leaves no temp files', () => {
  const dir = tempDir();
  const file = path.join(dir, 'nested', 'deep', 'state.json');
  writeJsonAtomic(file, { ok: true });
  assert.deepEqual(readJsonSafe(file), { ok: true });
  const leftovers = fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp'));
  assert.equal(leftovers.length, 0);
});

test('readJsonSafe returns null for a missing file', () => {
  assert.equal(readJsonSafe(path.join(tempDir(), 'nope.json')), null);
});

test('writeJsonAtomic cleans up its temp file when the rename fails', () => {
  // Reproduce the incident bug: a failing rename must not orphan a .tmp file.
  // Renaming a file over an EXISTING directory reliably throws (EPERM/EISDIR).
  const dir = tempDir();
  const target = path.join(dir, 'target'); // a directory, so rename-over fails
  fs.mkdirSync(target);

  assert.throws(() => writeJsonAtomic(target, { hello: 'world' }));

  const strays = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  assert.equal(strays.length, 0, 'no temp file should be left behind');
});

test('readJsonSafe quarantines a corrupt file instead of throwing', () => {
  const dir = tempDir();
  const file = path.join(dir, 'broken.json');
  fs.writeFileSync(file, '{ this is not json');

  const result = readJsonSafe(file, { logger: silentLogger });
  assert.equal(result, null);
  assert.ok(!fs.existsSync(file), 'corrupt file should be moved away');
  const quarantined = fs.readdirSync(dir).filter((f) => f.includes('.corrupt-'));
  assert.equal(quarantined.length, 1);
});

test('appendJsonl + readJsonl round-trip, skipping torn lines', () => {
  const file = path.join(tempDir(), 'history.jsonl');
  appendJsonl(file, { run: 1 });
  appendJsonl(file, { run: 2 });
  fs.appendFileSync(file, '{"run": 3, "torn": tr'); // simulated power loss

  assert.deepEqual(readJsonl(file), [{ run: 1 }, { run: 2 }]);
});
