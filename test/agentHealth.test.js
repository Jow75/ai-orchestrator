/**
 * Unit tests for agentHealth.js — per-agent install checks + performance
 * tallies, persisted, and always degrading safely (no healthFile = no-op).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentHealth } from '../src/agents/agentHealth.js';
import { silentLogger } from '../src/infra/logger.js';

function health() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aio-health-')), 'health.json');
  return new AgentHealth({ healthFile: file, logger: silentLogger });
}

test('recordOutcome accumulates per-agent tallies across outcomes', () => {
  const h = health();
  h.recordOutcome('coder', 'done', 2);
  h.recordOutcome('coder', 'done', 1);
  h.recordOutcome('coder', 'failed', 3);
  h.recordOutcome('tester', 'blocked', 1);
  const coder = h.get('coder');
  assert.equal(coder.tasksDone, 2);
  assert.equal(coder.tasksFailed, 1);
  assert.equal(coder.totalAttempts, 6);
  assert.equal(coder.lastOutcome, 'failed');
  assert.equal(h.get('tester').tasksBlocked, 1);
});

test('check() records installation status from the driver', async () => {
  const h = health();
  const okDriver = { id: 'mock', checkInstallation: async () => ({ ok: true, version: 'mock-1.0.0' }) };
  const result = await h.check({ id: 'm', driver: 'mock' }, okDriver, {});
  assert.equal(result.ok, true);
  const rec = h.get('m');
  assert.equal(rec.installed, true);
  assert.equal(rec.version, 'mock-1.0.0');
  assert.ok(rec.lastCheckedAt);
});

test('check() records a failed installation with its error', async () => {
  const h = health();
  const badDriver = { id: 'cli', checkInstallation: async () => ({ ok: false, error: 'not on PATH' }) };
  const result = await h.check({ id: 'g', driver: 'cli' }, badDriver, {});
  assert.equal(result.ok, false);
  assert.equal(h.get('g').installed, false);
  assert.equal(h.get('g').installError, 'not on PATH');
});

test('check() swallows a driver that throws (records ok:false)', async () => {
  const h = health();
  const throwing = { id: 'cli', checkInstallation: async () => { throw new Error('boom'); } };
  const result = await h.check({ id: 't', driver: 'cli' }, throwing, {});
  assert.equal(result.ok, false);
  assert.equal(h.get('t').installError, 'boom');
});

test('report() returns one enriched record per agent in the roster', () => {
  const h = health();
  h.recordOutcome('coder', 'done', 1);
  const roster = [
    { id: 'coder', role: 'coding', driver: 'claude', capabilities: ['code'], enabled: true },
    { id: 'new', role: 'testing', driver: 'mock', capabilities: [], enabled: true },
  ];
  const report = h.report(roster);
  assert.equal(report.length, 2);
  assert.equal(report[0].role, 'coding');
  assert.equal(report[0].tasksDone, 1);
  assert.equal(report[1].tasksDone, 0); // never-seen agent backfilled with zeros
});

test('every method is a safe no-op when no healthFile is configured', () => {
  const h = new AgentHealth({ healthFile: undefined, logger: silentLogger });
  assert.deepEqual(h.load(), {});
  h.recordOutcome('x', 'done', 1); // must not throw
  h.markUsed('x');
  assert.equal(h.get('x').tasksDone, 0);
});
