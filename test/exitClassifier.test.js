/**
 * Tests for the exit-cause classifier — the decision table that picks a
 * recovery strategy. Every cause and every precedence rule is pinned here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyExit, ExitCause } from '../src/core/exitClassifier.js';

const patterns = {
  usageLimit: [/usage limit reached/i, /quota exceeded/i],
  network: [/ECONNREFUSED|ETIMEDOUT/, /fetch failed/i],
};

test('clean exit with no limit message is COMPLETED', () => {
  const verdict = classifyExit(
    { code: 0, signal: null, outputTail: 'all done' },
    patterns
  );
  assert.equal(verdict.cause, ExitCause.COMPLETED);
});

test('usage limit beats a clean exit code', () => {
  const verdict = classifyExit(
    { code: 0, signal: null, outputTail: 'Claude AI usage limit reached|1751234567' },
    patterns
  );
  assert.equal(verdict.cause, ExitCause.USAGE_LIMIT);
});

test('usage limit is also found in the structured result text', () => {
  const verdict = classifyExit(
    { code: 1, signal: null, outputTail: '', resultText: 'quota exceeded, sorry' },
    patterns
  );
  assert.equal(verdict.cause, ExitCause.USAGE_LIMIT);
});

test('spawn error is SPAWN_FAILURE regardless of anything else', () => {
  const verdict = classifyExit(
    { code: null, signal: null, outputTail: '', spawnError: new Error('ENOENT') },
    patterns
  );
  assert.equal(verdict.cause, ExitCause.SPAWN_FAILURE);
});

test('SIGTERM is INTERRUPTED', () => {
  const verdict = classifyExit(
    { code: null, signal: 'SIGTERM', outputTail: '' },
    patterns
  );
  assert.equal(verdict.cause, ExitCause.INTERRUPTED);
});

test('exit code 130 (Ctrl+C convention) is INTERRUPTED', () => {
  const verdict = classifyExit({ code: 130, signal: null, outputTail: '' }, patterns);
  assert.equal(verdict.cause, ExitCause.INTERRUPTED);
});

test('non-zero exit with network noise is NETWORK', () => {
  const verdict = classifyExit(
    { code: 1, signal: null, outputTail: 'Error: fetch failed (ETIMEDOUT)' },
    patterns
  );
  assert.equal(verdict.cause, ExitCause.NETWORK);
});

test('non-zero exit with no recognisable message is CRASH', () => {
  const verdict = classifyExit(
    { code: 1, signal: null, outputTail: 'segfault-ish mystery' },
    patterns
  );
  assert.equal(verdict.cause, ExitCause.CRASH);
});

test('clean exit with engine-flagged error result is still COMPLETED (continue logic handles it)', () => {
  const verdict = classifyExit(
    { code: 0, signal: null, outputTail: '', resultText: 'max turns', resultIsError: true },
    patterns
  );
  assert.equal(verdict.cause, ExitCause.COMPLETED);
});
