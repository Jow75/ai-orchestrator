/**
 * Tests for config/liveConfig.js (Phase 13 M4) — the first mechanism for
 * the daemon to accept a config change without a restart.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ConfigManager from '../src/config/configManager.js';
import { LiveConfigLayer, LIVE_MUTABLE_PATHS } from '../src/config/liveConfig.js';

function scaffold() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-liveconfig-'));
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  const configManager = new ConfigManager({ rootDir: root });
  configManager.load();
  return { root, configManager };
}

// ── allowlist enforcement ────────────────────────────────────────────────

test('applyPatch accepts every path on the allowlist', () => {
  const { configManager } = scaffold();
  const live = new LiveConfigLayer({ configManager });
  for (const key of LIVE_MUTABLE_PATHS) {
    assert.doesNotThrow(() => live.applyPatch({ [key]: 'x' }));
  }
});

test('applyPatch refuses a key that is not on the allowlist, and writes NOTHING', () => {
  const { configManager } = scaffold();
  const live = new LiveConfigLayer({ configManager });
  const before = configManager.get('daemon.pollIntervalMs');

  assert.throws(
    () => live.applyPatch({ 'daemon.pollIntervalMs': 500 }),
    /Not remotely configurable.*daemon\.pollIntervalMs/
  );
  assert.equal(configManager.get('daemon.pollIntervalMs'), before,
    'a restart-only setting must never look live');
});

test('applyPatch is all-or-nothing: one bad key in a multi-key patch blocks the whole patch', () => {
  const { configManager } = scaffold();
  const live = new LiveConfigLayer({ configManager });

  assert.throws(() => live.applyPatch({
    'operator.projectRoots': ['C:\\ok'],
    'api.port': 9999, // not allowlisted
  }));
  assert.deepEqual(configManager.get('operator.projectRoots'), ['C:\\Users\\Admin\\Music'],
    'the allowlisted key in the SAME patch was not applied either');
});

test('an empty patch is a no-op that changes nothing and throws nothing', () => {
  const { configManager } = scaffold();
  const live = new LiveConfigLayer({ configManager });
  assert.deepEqual(live.applyPatch({}), []);
});

// ── in-place mutation (no subsystem needs to "reload") ──────────────────

test('applyPatch mutates the SAME config object reference every subsystem already holds', () => {
  const { configManager } = scaffold();
  const live = new LiveConfigLayer({ configManager });

  // Simulate daemon.js:105 — a subsystem grabs the reference ONCE, at startup.
  const subsystemsConfig = configManager.getAll();
  assert.notEqual(subsystemsConfig.operator.projectRoots, undefined);

  live.applyPatch({ 'operator.projectRoots': ['C:\\New\\Root'] });

  // The subsystem never called getAll() again — it's still looking at the
  // SAME object it grabbed at construction — and yet sees the new value.
  assert.deepEqual(subsystemsConfig.operator.projectRoots, ['C:\\New\\Root']);
  assert.equal(subsystemsConfig, configManager.getAll(), 'still the identical reference');
});

test('a patch to a nested path that did not exist yet creates the intermediate object', () => {
  const { configManager } = scaffold();
  const live = new LiveConfigLayer({ configManager });
  live.applyPatch({ 'approvals.mode': 'owner-gate' });
  assert.equal(configManager.getAll().approvals.mode, 'owner-gate');
});

// ── restart survival (the disk half, independent of the memory half) ─────

test('a change made through applyPatch survives a fresh ConfigManager against the same root', () => {
  const { root, configManager } = scaffold();
  const live = new LiveConfigLayer({ configManager });

  live.applyPatch({ 'operator.projectRoots': ['C:\\Survives\\A\\Restart'] });

  const restarted = new ConfigManager({ rootDir: root });
  restarted.load();
  assert.deepEqual(restarted.get('operator.projectRoots'), ['C:\\Survives\\A\\Restart']);
});

test('the write goes through config/local.json, never the tracked orchestrator.json', () => {
  const { root, configManager } = scaffold();
  const live = new LiveConfigLayer({ configManager });
  live.applyPatch({ 'operator.defaultModel': 'opus' });

  assert.ok(fs.existsSync(path.join(root, 'config', 'local.json')));
  assert.ok(!fs.existsSync(path.join(root, 'config', 'orchestrator.json')));
});
