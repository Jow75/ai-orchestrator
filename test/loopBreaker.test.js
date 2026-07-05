/**
 * Tests for the progress circuit breaker — the primary guard against
 * unbounded no-progress relaunch loops.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoopBreaker, BreakerAction } from '../src/core/loopBreaker.js';
import { silentLogger } from '../src/infra/logger.js';

const breaker = () =>
  new LoopBreaker({ config: { maxConsecutiveNoProgress: 3 }, logger: silentLogger });

test('continues when the run made progress', () => {
  const d = breaker().decide({ progressed: true, consecutiveNoProgress: 0 });
  assert.equal(d.action, BreakerAction.CONTINUE);
});

test('progress overrides a stale no-progress count', () => {
  const d = breaker().decide({ progressed: true, consecutiveNoProgress: 99 });
  assert.equal(d.action, BreakerAction.CONTINUE);
});

test('continues below the no-progress threshold', () => {
  assert.equal(
    breaker().decide({ progressed: false, consecutiveNoProgress: 2 }).action,
    BreakerAction.CONTINUE
  );
});

test('trips at the no-progress threshold', () => {
  const d = breaker().decide({ progressed: false, consecutiveNoProgress: 3 });
  assert.equal(d.action, BreakerAction.TRIP);
  assert.equal(d.category, 'stagnation');
});

test('trips immediately on an explicit block with no progress', () => {
  const d = breaker().decide({
    progressed: false,
    consecutiveNoProgress: 1, // well below threshold
    blocked: { blocked: true, category: 'permission-denied', hint: 'set permissionMode' },
  });
  assert.equal(d.action, BreakerAction.TRIP);
  assert.equal(d.category, 'permission-denied');
  assert.equal(d.hint, 'set permissionMode');
});

test('a blocked message alongside real progress does NOT trip', () => {
  // Progress wins: the agent mentioned permissions but still changed the workspace.
  const d = breaker().decide({
    progressed: true,
    consecutiveNoProgress: 0,
    blocked: { blocked: true, category: 'permission-denied' },
  });
  assert.equal(d.action, BreakerAction.CONTINUE);
});
