/**
 * Tests for drivers/driverRegistry.js — previously untested at the unit
 * level. Phase 13 M5 adds `defaultModelProvider` forwarding; everything
 * else here is pre-existing behaviour getting its first real coverage.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DriverRegistry } from '../src/drivers/driverRegistry.js';
import { ClaudeDriver } from '../src/drivers/claudeDriver.js';
import { silentLogger } from '../src/infra/logger.js';

test('listDrivers returns every built-in driver id, sorted', () => {
  const registry = new DriverRegistry({ logger: silentLogger });
  assert.deepEqual(registry.listDrivers(), ['claude', 'cli', 'mock', 'nvidia']);
});

test('getDriver lazily creates and caches one instance per id', () => {
  const registry = new DriverRegistry({ logger: silentLogger });
  const first = registry.getDriver('claude');
  const second = registry.getDriver('claude');
  assert.equal(first, second, 'the same instance is reused, not rebuilt');
  assert.ok(first instanceof ClaudeDriver);
});

test('getDriver throws a clear error for an unknown id', () => {
  const registry = new DriverRegistry({ logger: silentLogger });
  assert.throws(() => registry.getDriver('nonexistent'), /Unknown driver "nonexistent"/);
});

test('registerDriver adds a plugin driver with zero core changes, and refuses a colliding id', () => {
  const registry = new DriverRegistry({ logger: silentLogger });
  class FakeGeminiDriver extends ClaudeDriver {} // stand-in for a real plugin driver
  registry.registerDriver('gemini', FakeGeminiDriver);
  assert.ok(registry.listDrivers().includes('gemini'));
  assert.ok(registry.getDriver('gemini') instanceof FakeGeminiDriver);
  assert.throws(() => registry.registerDriver('gemini', FakeGeminiDriver), /already registered/);
});

// ── Phase 13 M5: defaultModelProvider forwarding ────────────────────────

test('defaultModelProvider is forwarded to a claude driver instance it creates', () => {
  const registry = new DriverRegistry({
    logger: silentLogger,
    defaultModelProvider: () => 'opus',
  });
  const claude = registry.getDriver('claude');
  const args = claude.buildArgs({ model: '' }, null);
  assert.equal(args[args.indexOf('--model') + 1], 'opus');
});

test('a registry built with no defaultModelProvider behaves exactly as before this milestone', () => {
  const registry = new DriverRegistry({ logger: silentLogger });
  const claude = registry.getDriver('claude');
  const args = claude.buildArgs({ model: '' }, null);
  assert.ok(!args.includes('--model'));
});

test('passing defaultModelProvider to a driver that ignores it (mock, cli, nvidia) is harmless', () => {
  const registry = new DriverRegistry({
    logger: silentLogger,
    defaultModelProvider: () => 'opus',
  });
  assert.doesNotThrow(() => registry.getDriver('mock'));
  assert.doesNotThrow(() => registry.getDriver('cli'));
  assert.doesNotThrow(() => registry.getDriver('nvidia'));
});

// ── reconciliation pass, 2026-07-30: safeModeProvider forwarding ────────

test('safeModeProvider is forwarded to a claude driver instance it creates', () => {
  const registry = new DriverRegistry({
    logger: silentLogger,
    safeModeProvider: () => true,
  });
  const claude = registry.getDriver('claude');
  const args = claude.buildArgs({ model: '', permissionMode: 'acceptEdits' }, null);
  assert.ok(!args.includes('--permission-mode'), 'Safe Mode reached the driver this registry created');
});

test('a registry built with no safeModeProvider behaves exactly as before Safe Mode existed', () => {
  const registry = new DriverRegistry({ logger: silentLogger });
  const claude = registry.getDriver('claude');
  const args = claude.buildArgs({ model: '', permissionMode: 'acceptEdits' }, null);
  assert.ok(args.includes('--permission-mode'), 'a project\'s own permission settings still apply with no Safe Mode wiring at all');
});

test('passing safeModeProvider to a driver that ignores it (mock, cli, nvidia) is harmless', () => {
  const registry = new DriverRegistry({
    logger: silentLogger,
    safeModeProvider: () => true,
  });
  assert.doesNotThrow(() => registry.getDriver('mock'));
  assert.doesNotThrow(() => registry.getDriver('cli'));
  assert.doesNotThrow(() => registry.getDriver('nvidia'));
});

test('nvidiaConfigProvider is forwarded to an nvidia driver instance it creates', async () => {
  const registry = new DriverRegistry({
    logger: silentLogger,
    nvidiaConfigProvider: () => ({ apiKey: 'nv-key' }),
  });
  const nvidia = registry.getDriver('nvidia');
  const result = await nvidia.checkInstallation();
  assert.equal(result.ok, true);
});

test('a registry built with no nvidiaConfigProvider still returns a usable nvidia driver', async () => {
  const registry = new DriverRegistry({ logger: silentLogger });
  const nvidia = registry.getDriver('nvidia');
  const result = await nvidia.checkInstallation();
  assert.equal(result.ok, false, 'unconfigured, so checkInstallation reports it instead of throwing');
});
