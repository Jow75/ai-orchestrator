/**
 * Tests for infra/errors.js — the remedy-first error contract every
 * user-facing throw in the CLI should follow (Phase 11 M3).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { userFacingError } from '../src/infra/errors.js';

test('sets userFacing and combines cause only when that is all that is given', () => {
  const error = userFacingError({ cause: 'Something happened.' });
  assert.equal(error.userFacing, true);
  assert.equal(error.message, 'Something happened.');
});

test('combines cause + impact + fix in order, fix prefixed clearly', () => {
  const error = userFacingError({
    cause: 'No project named "x".',
    impact: 'Nothing can be started.',
    fix: 'run "ai-orchestrator projects list".',
  });
  assert.equal(
    error.message,
    'No project named "x". Nothing can be started. Fix: run "ai-orchestrator projects list".'
  );
});

test('omits impact cleanly when not supplied', () => {
  const error = userFacingError({ cause: 'Bad input.', fix: 'try again.' });
  assert.equal(error.message, 'Bad input. Fix: try again.');
});

test('is a real Error instance usable with instanceof/throw', () => {
  const error = userFacingError({ cause: 'x' });
  assert.ok(error instanceof Error);
  assert.throws(() => { throw error; }, /x/);
});
