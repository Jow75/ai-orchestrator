/**
 * Unit tests for workerRegistry.js — Phase 12 M1.
 *
 * The registry re-grains supervision ownership from the MACHINE (the old
 * heartbeat lock) to the PROJECT, which is the single change that makes
 * "start Calculator while Remote Work runs" possible. These tests pin the
 * ownership rules and the crash-detection behaviour that keeps a killed
 * worker from holding its project hostage forever.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkerRegistry } from '../src/daemon/workerRegistry.js';
import { silentLogger } from '../src/infra/logger.js';

const DEAD_PID = 0x7ffffff0;

function registry() {
  const workersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-workers-'));
  return { workersDir, registry: new WorkerRegistry({ workersDir, logger: silentLogger }) };
}

test('registering a project records it as running and held by that pid', () => {
  const { registry: r } = registry();
  const record = r.register('finisher', { pid: process.pid, mode: 'worker' });

  assert.equal(record.project, 'finisher');
  assert.equal(record.state, 'running');
  assert.equal(r.read('finisher').pid, process.pid);
  assert.equal(r.holderOf('finisher').pid, process.pid);
});

test('two different projects are held independently — the point of the registry', () => {
  const { registry: r } = registry();
  r.register('finisher', { pid: process.pid });
  r.register('calculator', { pid: process.pid });

  assert.ok(r.holderOf('finisher'), 'finisher is held');
  assert.ok(r.holderOf('calculator'), 'calculator is held at the SAME time');
  assert.equal(r.listAlive().length, 2);
});

test('a project nobody registered has no holder', () => {
  const { registry: r } = registry();
  assert.equal(r.holderOf('nobody'), null);
});

test('a record whose process is gone does NOT hold the project', () => {
  const { registry: r } = registry();
  r.register('ghost', { pid: DEAD_PID });

  assert.equal(r.holderOf('ghost'), null, 'a dead worker cannot hold a project hostage');
  assert.equal(r.read('ghost').state, 'running', 'but the record still says running (a crash)');
  assert.equal(r.list().find((w) => w.project === 'ghost').alive, false);
});

test('unregister removes the record entirely', () => {
  const { registry: r } = registry();
  r.register('finisher', { pid: process.pid });
  r.unregister('finisher');

  assert.equal(r.read('finisher'), null);
  assert.equal(r.holderOf('finisher'), null);
  assert.equal(r.list().length, 0);
});

test('update merges fields into an existing record and no-ops on a missing one', () => {
  const { registry: r } = registry();
  r.register('finisher', { pid: process.pid });
  const updated = r.update('finisher', { sessionId: 's-1' });

  assert.equal(updated.sessionId, 's-1');
  assert.equal(updated.pid, process.pid, 'existing fields survive');
  assert.equal(r.update('missing', { x: 1 }), null);
});

test('reapStale clears dead records and reports them as crashes', () => {
  const { registry: r } = registry();
  r.register('alive', { pid: process.pid });
  r.register('crashed', { pid: DEAD_PID });

  const reaped = r.reapStale();

  assert.equal(reaped.length, 1);
  assert.equal(reaped[0].project, 'crashed', 'the crash is surfaced, not silently tidied away');
  assert.equal(r.read('crashed'), null, 'and the project becomes startable again');
  assert.ok(r.holderOf('alive'), 'a live worker is left alone');
});

test('project names that are not filesystem-safe still round-trip', () => {
  const { registry: r } = registry();
  r.register('my project/v2', { pid: process.pid });

  assert.equal(r.holderOf('my project/v2').pid, process.pid);
  assert.equal(r.list()[0].project, 'my project/v2', 'the real name is preserved inside the record');
});

// ── stop requests (the graceful, cross-platform stop path) ────────────────

test('a stop request round-trips and is cleared once consumed', () => {
  const { registry: r } = registry();
  assert.equal(r.readStopRequest('finisher'), null, 'nothing pending by default');

  assert.equal(r.requestStop('finisher', 'operator asked'), true);
  assert.equal(r.readStopRequest('finisher').reason, 'operator asked');

  r.clearStop('finisher');
  assert.equal(r.readStopRequest('finisher'), null);
});

test('unregistering a worker also clears its stop request', () => {
  const { registry: r } = registry();
  r.register('finisher', { pid: process.pid });
  r.requestStop('finisher', 'stop it');
  r.unregister('finisher');

  // Otherwise the request outlives the mission it was meant for and would
  // stop the NEXT mission on this project the moment it starts.
  assert.equal(r.readStopRequest('finisher'), null);
});

test('stop requests are per-project, never machine-wide', () => {
  const { registry: r } = registry();
  r.requestStop('finisher', 'stop finisher only');

  assert.ok(r.readStopRequest('finisher'));
  assert.equal(r.readStopRequest('calculator'), null, 'another mission is untouched');
});

test('a corrupt stop file still stops the worker (fail safe, not fail open)', () => {
  const { workersDir, registry: r } = registry();
  fs.writeFileSync(path.join(workersDir, 'finisher.stop'), '{broken', 'utf8');

  const request = r.readStopRequest('finisher');
  assert.ok(request, 'an unreadable stop request is still a stop request');
  assert.equal(request.reason, 'stop requested');
});

test('a corrupt record file does not break enumeration', () => {
  const { workersDir, registry: r } = registry();
  r.register('good', { pid: process.pid });
  fs.writeFileSync(path.join(workersDir, 'broken.json'), '{not json', 'utf8');

  const listed = r.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].project, 'good');
});

test('stop files are never mistaken for worker records', () => {
  const { registry: r } = registry();
  r.register('good', { pid: process.pid });
  r.requestStop('good', 'stop');

  const listed = r.list();
  assert.equal(listed.length, 1, 'only .json files are records');
  assert.equal(listed[0].project, 'good');
});
