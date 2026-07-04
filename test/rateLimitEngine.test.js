/**
 * Tests for usage-limit wait policy: parsed reset times, fallback waits,
 * clamping, and interruptible waiting.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimitEngine } from '../src/core/rateLimitEngine.js';
import { silentLogger } from '../src/infra/logger.js';

const config = {
  minWaitMs: 10,
  defaultWaitMs: 500,
  maxWaitMs: 2_000,
  resumeGraceMs: 0,
};

/** A fake driver whose reset-time parser we control per test. */
function driverReturning(date) {
  return { extractLimitResetTime: () => date };
}

test('uses the driver-parsed reset time when available', () => {
  const engine = new RateLimitEngine({ config, logger: silentLogger });
  const target = new Date(Date.now() + 1_000);
  const { waitMs, source } = engine.computeWait({
    driver: driverReturning(target),
    outputTail: '',
  });
  assert.equal(source, 'parsed');
  assert.ok(waitMs > 900 && waitMs <= 1_100, `waitMs was ${waitMs}`);
});

test('falls back to defaultWaitMs when parsing fails', () => {
  const engine = new RateLimitEngine({ config, logger: silentLogger });
  const { waitMs, source } = engine.computeWait({
    driver: driverReturning(null),
    outputTail: 'no reset info here',
  });
  assert.equal(source, 'default');
  assert.equal(waitMs, config.defaultWaitMs);
});

test('clamps a reset time in the past up to minWaitMs', () => {
  const engine = new RateLimitEngine({ config, logger: silentLogger });
  const { waitMs } = engine.computeWait({
    driver: driverReturning(new Date(Date.now() - 60_000)),
    outputTail: '',
  });
  assert.equal(waitMs, config.minWaitMs);
});

test('clamps an absurdly distant reset time down to maxWaitMs', () => {
  const engine = new RateLimitEngine({ config, logger: silentLogger });
  const { waitMs } = engine.computeWait({
    driver: driverReturning(new Date(Date.now() + 999_999_999)),
    outputTail: '',
  });
  assert.equal(waitMs, config.maxWaitMs);
});

test('waitUntil elapses normally', async () => {
  const engine = new RateLimitEngine({ config, logger: silentLogger });
  const result = await engine.waitUntil(new Date(Date.now() + 30));
  assert.equal(result, 'elapsed');
});

test('waitUntil aborts promptly when the signal fires', async () => {
  const engine = new RateLimitEngine({ config, logger: silentLogger });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);

  const startedAt = Date.now();
  const result = await engine.waitUntil(new Date(Date.now() + 60_000), {
    signal: controller.signal,
  });
  assert.equal(result, 'aborted');
  assert.ok(Date.now() - startedAt < 5_000, 'abort should not wait out the timer');
});
