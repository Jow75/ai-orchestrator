/**
 * Tests for the Verification Engine (core): the individual verifiers and
 * the registry that runs them. "Claude does not determine success —
 * verification determines success" is the principle under test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runVerifiers, isKnownVerifierType, listVerifierTypes,
} from '../src/verify/verifierRegistry.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aio-verify-'));
}

test('registry knows its built-in types', () => {
  assert.ok(isKnownVerifierType('file-exists'));
  assert.ok(isKnownVerifierType('command'));
  assert.ok(isKnownVerifierType('output-contains'));
  assert.ok(isKnownVerifierType('files-changed'));
  assert.equal(isKnownVerifierType('nonsense'), false);
  assert.deepEqual(
    listVerifierTypes(),
    ['command', 'file-exists', 'files-changed', 'output-contains']
  );
});

test('unknown verifier type fails clearly instead of throwing', () => {
  const { passed, results } = runVerifiers([{ type: 'not-a-real-type' }], {});
  assert.equal(passed, false);
  assert.match(results[0].detail, /Unknown verifier type/);
});

test('a throwing verifier config fails only itself, not the whole run', () => {
  // command verifier with a run string this shell cannot execute at all
  // still returns a normal failed result rather than propagating.
  const { passed, results } = runVerifiers(
    [{ type: 'file-exists' }], // missing required "path" -> throws-safe path
    { workingDirectory: tempDir() }
  );
  assert.equal(passed, false);
  assert.match(results[0].detail, /missing "path"/);
});

test('file-exists: passes when the file is present', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
  const { passed } = runVerifiers(
    [{ type: 'file-exists', path: 'a.txt' }],
    { workingDirectory: dir }
  );
  assert.equal(passed, true);
});

test('file-exists: fails when the file is absent', () => {
  const { passed, results } = runVerifiers(
    [{ type: 'file-exists', path: 'missing.txt' }],
    { workingDirectory: tempDir() }
  );
  assert.equal(passed, false);
  assert.match(results[0].detail, /Not found/);
});

test('command: passes on the expected exit code', () => {
  const { passed } = runVerifiers(
    [{ type: 'command', run: process.platform === 'win32' ? 'exit 0' : 'true', expectExit: 0 }],
    { workingDirectory: tempDir() }
  );
  assert.equal(passed, true);
});

test('command: fails and reports the actual exit code on mismatch', () => {
  const { passed, results } = runVerifiers(
    [{ type: 'command', run: process.platform === 'win32' ? 'exit 3' : 'exit 3', expectExit: 0 }],
    { workingDirectory: tempDir() }
  );
  assert.equal(passed, false);
  assert.match(results[0].detail, /exited 3/);
});

test('output-contains: plain substring match', () => {
  const { passed } = runVerifiers(
    [{ type: 'output-contains', pattern: 'all good' }],
    { resultText: 'run finished: all good', outputTail: '' }
  );
  assert.equal(passed, true);
});

test('output-contains: regex mode', () => {
  const { passed } = runVerifiers(
    [{ type: 'output-contains', pattern: '\\d+ tests passed', regex: true }],
    { resultText: '42 tests passed', outputTail: '' }
  );
  assert.equal(passed, true);
});

test('output-contains: invalid regex fails cleanly', () => {
  const { passed, results } = runVerifiers(
    [{ type: 'output-contains', pattern: '(unterminated', regex: true }],
    { resultText: 'x', outputTail: '' }
  );
  assert.equal(passed, false);
  assert.match(results[0].detail, /Invalid regex/);
});

test('files-changed: passes when required paths were created/modified', () => {
  const { passed } = runVerifiers(
    [{ type: 'files-changed', paths: ['src/index.js'] }],
    { changes: { created: ['src/index.js'], modified: [] } }
  );
  assert.equal(passed, true);
});

test('files-changed: directory-prefix matching', () => {
  const { passed } = runVerifiers(
    [{ type: 'files-changed', paths: ['src/utils/'] }],
    { changes: { created: [], modified: ['src/utils/helpers.js'] } }
  );
  assert.equal(passed, true);
});

test('files-changed: fails when nothing matches', () => {
  const { passed, results } = runVerifiers(
    [{ type: 'files-changed', paths: ['src/index.js'] }],
    { changes: { created: ['other.js'], modified: [] } }
  );
  assert.equal(passed, false);
  assert.match(results[0].detail, /Not changed/);
});

test('files-changed: no prior change data (first run) fails, not throws', () => {
  const { passed, results } = runVerifiers(
    [{ type: 'files-changed', paths: ['a.js'] }],
    { changes: null }
  );
  assert.equal(passed, false);
  assert.match(results[0].detail, /No change data/);
});

test('multiple verifiers must ALL pass', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
  const { passed, results } = runVerifiers(
    [
      { type: 'file-exists', path: 'a.txt' },
      { type: 'file-exists', path: 'b.txt' },
    ],
    { workingDirectory: dir }
  );
  assert.equal(passed, false);
  assert.equal(results[0].passed, true);
  assert.equal(results[1].passed, false);
});

test('empty verifier list trivially passes', () => {
  assert.equal(runVerifiers([], {}).passed, true);
  assert.equal(runVerifiers(undefined, {}).passed, true);
});
