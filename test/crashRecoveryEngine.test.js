/**
 * Tests for crash recovery policy: exponential backoff and the give-up
 * threshold.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CrashRecoveryEngine } from '../src/core/crashRecoveryEngine.js';
import { silentLogger } from '../src/infra/logger.js';

const config = {
  maxConsecutiveCrashes: 4,
  crashBackoffBaseMs: 100,
  crashBackoffMaxMs: 350,
};

test('backoff doubles per consecutive crash and caps at the max', () => {
  const engine = new CrashRecoveryEngine({ config, logger: silentLogger });

  assert.deepEqual(
    [1, 2, 3].map((n) => engine.decide({ consecutiveCrashes: n }).delayMs),
    [100, 200, 350] // 400 would exceed the cap
  );
});

test('restarts below the threshold', () => {
  const engine = new CrashRecoveryEngine({ config, logger: silentLogger });
  assert.equal(engine.decide({ consecutiveCrashes: 3 }).action, 'restart');
});

test('gives up at the threshold', () => {
  const engine = new CrashRecoveryEngine({ config, logger: silentLogger });
  const decision = engine.decide({ consecutiveCrashes: 4 });
  assert.equal(decision.action, 'give-up');
  assert.match(decision.reason, /consecutive crashes/);
});
