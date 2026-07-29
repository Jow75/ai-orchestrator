/**
 * Tests for drivers/capabilities.js (Phase 13 M5) — pure reference data, no
 * behaviour to exercise beyond its own shape and the "never invent an
 * answer" principle (`cli`'s `toolUse: 'unknown'`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DRIVER_CAPABILITIES, capabilitiesOf } from '../src/drivers/capabilities.js';
import { DriverRegistry } from '../src/drivers/driverRegistry.js';
import { silentLogger } from '../src/infra/logger.js';

test('every built-in driver has a capabilities entry', () => {
  const registry = new DriverRegistry({ logger: silentLogger });
  for (const id of registry.listDrivers()) {
    assert.ok(DRIVER_CAPABILITIES[id], `missing capabilities entry for "${id}"`);
  }
});

test('each entry has the complete, correctly-typed shape', () => {
  for (const [id, caps] of Object.entries(DRIVER_CAPABILITIES)) {
    assert.equal(typeof caps.label, 'string', `${id}.label`);
    assert.ok(Array.isArray(caps.models), `${id}.models`);
    assert.equal(typeof caps.streaming, 'boolean', `${id}.streaming`);
    assert.equal(typeof caps.cancellation, 'boolean', `${id}.cancellation`);
    assert.ok(
      typeof caps.toolUse === 'boolean' || caps.toolUse === 'unknown',
      `${id}.toolUse must be boolean or the literal 'unknown', got ${caps.toolUse}`
    );
  }
});

test('claude declares its real model set', () => {
  assert.deepEqual(DRIVER_CAPABILITIES.claude.models, ['sonnet', 'opus', 'haiku']);
});

test('cli reports toolUse as "unknown", never a confident guess (a generic wrapper cannot know)', () => {
  assert.equal(DRIVER_CAPABILITIES.cli.toolUse, 'unknown');
});

test('mock never claims streaming or tool use — it is a fixture', () => {
  assert.equal(DRIVER_CAPABILITIES.mock.streaming, false);
  assert.equal(DRIVER_CAPABILITIES.mock.toolUse, false);
});

test('capabilitiesOf returns null for an unknown driver id, never a fabricated default', () => {
  assert.equal(capabilitiesOf('nonexistent'), null);
});

test('capabilitiesOf returns the same object listDrivers would answer for', () => {
  assert.equal(capabilitiesOf('claude'), DRIVER_CAPABILITIES.claude);
});

test('the whole map and every entry are frozen (reference data, never mutated)', () => {
  assert.ok(Object.isFrozen(DRIVER_CAPABILITIES));
  for (const caps of Object.values(DRIVER_CAPABILITIES)) assert.ok(Object.isFrozen(caps));
});
