import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgyDriver, AGY_DEFAULT_MODEL, AGY_SUPPORTED_MODELS } from '../src/drivers/agyDriver.js';
import { silentLogger } from '../src/infra/logger.js';

test('AgyDriver has correct defaults and supported models', () => {
  const driver = new AgyDriver({ logger: silentLogger });
  assert.equal(driver.id, 'agy');
  assert.match(driver.name, /Antigravity CLI/i);
  assert.equal(AGY_DEFAULT_MODEL, 'gemini-3.8-flash-high');
  assert.ok(AGY_SUPPORTED_MODELS.includes('gemini-3.8-flash-high'));
  assert.ok(AGY_SUPPORTED_MODELS.includes('claude-sonnet-4-6'));
  assert.ok(AGY_SUPPORTED_MODELS.includes('claude-opus-4-6-thinking'));
  assert.ok(AGY_SUPPORTED_MODELS.includes('gpt-oss-120b-medium'));
});

test('AgyDriver resolves model per project and default provider', () => {
  const driver = new AgyDriver({
    logger: silentLogger,
    defaultModelProvider: () => 'claude-sonnet-4-6',
  });

  // Project overrides default
  assert.equal(driver.resolveModel({ agy: { model: 'gpt-oss-120b-medium' } }), 'gpt-oss-120b-medium');
  // Default used when project unset
  assert.equal(driver.resolveModel({}), 'claude-sonnet-4-6');
  // Fallback to gemini-3.8-flash-high when unknown model given
  assert.equal(driver.resolveModel({ agy: { model: 'unknown-model-xyz' } }), 'claude-sonnet-4-6');
});

test('AgyDriver classifies usage limit and network exits correctly', () => {
  const driver = new AgyDriver({ logger: silentLogger });
  const usageMatches = driver.exitPatterns.usageLimit.some((pat) => pat.test('Error: 429 Quota Exceeded'));
  assert.equal(usageMatches, true);

  const networkMatches = driver.exitPatterns.network.some((pat) => pat.test('fetch failed: ECONNREFUSED'));
  assert.equal(networkMatches, true);
});

test('AgyDriver checkInstallation succeeds when binary is present', async () => {
  const driver = new AgyDriver({ logger: silentLogger });
  const result = await driver.checkInstallation();
  assert.equal(result.ok, true);
  assert.match(result.version, /Antigravity CLI/);
});

