import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelRouter, FAILURE_CATEGORIES } from '../src/drivers/modelRouter.js';
import { silentLogger } from '../src/infra/logger.js';

test('ModelRouter task-aware routing selects optimal driver and model for roles', () => {
  const router = new ModelRouter({ logger: silentLogger });

  const diag = router.routeTask({ role: 'diagnostic' });
  assert.equal(diag.driverId, 'agy');
  assert.equal(diag.model, 'gemini-3.8-flash-high');

  const arch = router.routeTask({ role: 'architecture' });
  assert.equal(arch.driverId, 'agy');
  assert.equal(arch.model, 'gemini-3.8-flash-high');

  const impl = router.routeTask({ role: 'implementation' });
  assert.equal(impl.driverId, 'agy');
  assert.equal(impl.model, 'gemini-3.8-flash-high');

  const adv = router.routeTask({ role: 'adversarial' });
  assert.equal(adv.driverId, 'agy');
  assert.equal(adv.model, 'claude-opus-4-6-thinking');
});

test('ModelRouter enforces independent verification separation (Section 8.4)', () => {
  const router = new ModelRouter({ logger: silentLogger });

  // When implementation used agy, verification must prefer an independent model (claude)
  const verifyAgy = router.routeTask({ role: 'verification', implementationDriver: 'agy' });
  assert.equal(verifyAgy.driverId, 'claude');
  assert.equal(verifyAgy.model, 'sonnet');

  // When implementation used claude, verification must prefer an independent model (agy)
  const verifyClaude = router.routeTask({ role: 'verification', implementationDriver: 'claude' });
  assert.equal(verifyClaude.driverId, 'agy');
  assert.equal(verifyClaude.model, 'gemini-3.8-flash-high');
});

test('ModelRouter classifies failure categories and retryability correctly', () => {
  const router = new ModelRouter({ logger: silentLogger });

  assert.equal(router.classifyFailure('429 Too Many Requests - quota exceeded'), FAILURE_CATEGORIES.RATE_LIMIT);
  assert.equal(router.isRetryable(FAILURE_CATEGORIES.RATE_LIMIT), true);

  assert.equal(router.classifyFailure('connect ECONNREFUSED 127.0.0.1:443'), FAILURE_CATEGORIES.NETWORK);
  assert.equal(router.isRetryable(FAILURE_CATEGORIES.NETWORK), true);

  assert.equal(router.classifyFailure('Operation aborted: ETIMEDOUT'), FAILURE_CATEGORIES.TIMEOUT);
  assert.equal(router.isRetryable(FAILURE_CATEGORIES.TIMEOUT), true);

  assert.equal(router.classifyFailure('401 Unauthorized: Invalid API token'), FAILURE_CATEGORIES.AUTH);
  assert.equal(router.isRetryable(FAILURE_CATEGORIES.AUTH), false);

  assert.equal(router.classifyFailure('model not found: gpt-xyz'), FAILURE_CATEGORIES.MODEL_NOT_FOUND);
  assert.equal(router.isRetryable(FAILURE_CATEGORIES.MODEL_NOT_FOUND), false);

  assert.equal(router.classifyFailure('SyntaxError: Unexpected token'), FAILURE_CATEGORIES.UNRECOVERABLE);
  assert.equal(router.isRetryable(FAILURE_CATEGORIES.UNRECOVERABLE), false);
});

test('ModelRouter circuit breaker trips after threshold consecutive failures', () => {
  const router = new ModelRouter({
    logger: silentLogger,
    circuitThreshold: 3,
    circuitCooldownMs: 500,
  });

  assert.equal(router.isDriverHealthy('agy'), true);
  router.recordFailure('agy', 'ECONNRESET');
  assert.equal(router.isDriverHealthy('agy'), true);
  router.recordFailure('agy', 'ECONNRESET');
  assert.equal(router.isDriverHealthy('agy'), true);
  router.recordFailure('agy', 'ECONNRESET');

  // 3rd failure trips the breaker
  assert.equal(router.isDriverHealthy('agy'), false);

  // While agy is tripped, routeTask falls back to claude
  const routed = router.routeTask({ role: 'implementation' });
  assert.equal(routed.driverId, 'claude');

  // After successful response, circuit breaker is restored
  router.recordSuccess('agy');
  assert.equal(router.isDriverHealthy('agy'), true);
  const restored = router.routeTask({ role: 'implementation' });
  assert.equal(restored.driverId, 'agy');
});

test('ModelRouter getFallback selects next viable candidate and prevents loops', () => {
  const router = new ModelRouter({ logger: silentLogger });
  const visited = new Set();

  const fb1 = router.getFallback('agy', { visited, requiresTools: true });
  assert.ok(fb1);
  assert.equal(fb1.driverId, 'claude');

  const fb2 = router.getFallback('claude', { visited, requiresTools: true });
  assert.equal(fb2, null, 'No further tool-capable drivers remain in chain');

  // For read-only tasks, nvidia is also in chain
  const visitedReadOnly = new Set();
  const fbReadOnly1 = router.getFallback('agy', { visited: visitedReadOnly, requiresTools: false });
  assert.equal(fbReadOnly1.driverId, 'claude');
  const fbReadOnly2 = router.getFallback('claude', { visited: visitedReadOnly, requiresTools: false });
  assert.equal(fbReadOnly2.driverId, 'nvidia');
  const fbReadOnly3 = router.getFallback('nvidia', { visited: visitedReadOnly, requiresTools: false });
  assert.equal(fbReadOnly3, null, 'All candidates exhausted; no infinite loops');
});

test('ModelRouter getAvailabilityMatrix returns structured report without secrets', () => {
  const router = new ModelRouter({ logger: silentLogger });
  const matrix = router.getAvailabilityMatrix();

  assert.ok(Array.isArray(matrix));
  assert.ok(matrix.length >= 3);
  const agyEntry = matrix.find((m) => m.driverId === 'agy');
  assert.ok(agyEntry);
  assert.equal(agyEntry.status, 'healthy');
  assert.ok(agyEntry.models.includes('gemini-3.8-flash-high'));

  // Ensure no sensitive fields like apiKey or secrets are present
  for (const entry of matrix) {
    assert.equal(entry.apiKey, undefined);
    assert.equal(entry.token, undefined);
    assert.equal(entry.secret, undefined);
  }
});

