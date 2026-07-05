/**
 * Tests for standardized per-run outcome classification.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveExitReason, ExitReason } from '../src/core/exitReason.js';
import { ExitCause } from '../src/core/exitClassifier.js';

test('operator stop overrides everything', () => {
  assert.equal(
    deriveExitReason({ cause: ExitCause.CRASH, stopRequested: true }),
    ExitReason.USER_STOP
  );
});

test('usage limit → rate_limit', () => {
  assert.equal(deriveExitReason({ cause: ExitCause.USAGE_LIMIT }), ExitReason.RATE_LIMIT);
});

test('network → network', () => {
  assert.equal(deriveExitReason({ cause: ExitCause.NETWORK }), ExitReason.NETWORK);
});

test('spawn failure → spawn_failure', () => {
  assert.equal(deriveExitReason({ cause: ExitCause.SPAWN_FAILURE }), ExitReason.SPAWN_FAILURE);
});

test('crash and external interrupt → crash', () => {
  assert.equal(deriveExitReason({ cause: ExitCause.CRASH }), ExitReason.CRASH);
  assert.equal(deriveExitReason({ cause: ExitCause.INTERRUPTED }), ExitReason.CRASH);
});

test('completed + marker → completed', () => {
  assert.equal(
    deriveExitReason({ cause: ExitCause.COMPLETED, markerHit: true }),
    ExitReason.COMPLETED
  );
});

test('completed + progress → progress', () => {
  assert.equal(
    deriveExitReason({ cause: ExitCause.COMPLETED, markerHit: false, progressed: true }),
    ExitReason.PROGRESS
  );
});

test('completed + no progress + no block → no_progress', () => {
  assert.equal(
    deriveExitReason({ cause: ExitCause.COMPLETED, progressed: false }),
    ExitReason.NO_PROGRESS
  );
});

test('blocked categories map to the right blocked reasons', () => {
  const base = { cause: ExitCause.COMPLETED, progressed: false };
  assert.equal(
    deriveExitReason({ ...base, blocked: { blocked: true, category: 'permission-denied' } }),
    ExitReason.BLOCKED_PERMISSION
  );
  assert.equal(
    deriveExitReason({ ...base, blocked: { blocked: true, category: 'no-access' } }),
    ExitReason.BLOCKED_TOOL
  );
  assert.equal(
    deriveExitReason({ ...base, blocked: { blocked: true, category: 'missing-file' } }),
    ExitReason.BLOCKED_MISSING_FILE
  );
  assert.equal(
    deriveExitReason({ ...base, blocked: { blocked: true, category: 'cannot-proceed' } }),
    ExitReason.BLOCKED_OTHER
  );
});

test('progress wins over a blocked mention (blocked only matters with no progress)', () => {
  assert.equal(
    deriveExitReason({
      cause: ExitCause.COMPLETED,
      progressed: true,
      blocked: { blocked: true, category: 'permission-denied' },
    }),
    ExitReason.PROGRESS
  );
});
