/**
 * Unit tests for missionLifecycle.js — Phase 10D: state transitions with
 * history, dedupe, unknown-state guarding, approval-event wiring, and
 * safe no-op degradation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { MissionLifecycle, LIFECYCLE_STATES, TERMINAL_STATES } from '../src/mission/missionLifecycle.js';
import { silentLogger } from '../src/infra/logger.js';

function lifecycle() {
  const lifecycleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-lifecycle-'));
  return new MissionLifecycle({ lifecycleDir, logger: silentLogger });
}

test('records transitions with from/to/reason history, persisted', () => {
  const lc = lifecycle();
  lc.transition('proj', 'received', 'mission start requested');
  lc.transition('proj', 'analyzed');
  lc.transition('proj', 'planned', 'plan loaded: 3 task(s)');

  const record = lc.get('proj');
  assert.equal(record.state, 'planned');
  assert.equal(record.history.length, 3);
  assert.deepEqual(record.history.map((h) => [h.from, h.to]), [
    [null, 'received'], ['received', 'analyzed'], ['analyzed', 'planned'],
  ]);
  assert.equal(record.history[2].reason, 'plan loaded: 3 task(s)');
});

test('same-state transitions are deduped (a retry loop cannot flood history)', () => {
  const lc = lifecycle();
  lc.transition('proj', 'executing');
  lc.transition('proj', 'executing');
  lc.transition('proj', 'executing');
  assert.equal(lc.get('proj').history.length, 1);
});

test('an unknown state is refused, leaving the record untouched', () => {
  const lc = lifecycle();
  lc.transition('proj', 'executing');
  lc.transition('proj', 'discombobulated');
  assert.equal(lc.get('proj').state, 'executing');
});

test('every state named by the phase spec exists', () => {
  for (const state of [
    'received', 'analyzed', 'planned', 'approved', 'agents-assigned',
    'executing', 'verifying', 'fixing', 'completed', 'blocked', 'cancelled', 'failed',
  ]) {
    assert.ok(LIFECYCLE_STATES.includes(state), `missing ${state}`);
  }
  assert.deepEqual(TERMINAL_STATES, ['completed', 'blocked', 'cancelled', 'failed']);
});

test('attachApprovals maps approval events to approval-pending/approved', () => {
  const lc = lifecycle();
  const approvals = new EventEmitter();
  lc.attachApprovals(approvals);

  approvals.emit('approval:required', {
    project: 'proj', request: { id: 'A1', category: 'secrets' },
  });
  assert.equal(lc.get('proj').state, 'approval-pending');

  approvals.emit('approval:resolved', {
    project: 'proj', request: { id: 'A1', status: 'approved' },
  });
  assert.equal(lc.get('proj').state, 'approved');

  // A rejection does NOT transition here (the orchestrator records the
  // consequence itself).
  approvals.emit('approval:required', {
    project: 'proj', request: { id: 'A2', category: 'secrets' },
  });
  approvals.emit('approval:resolved', {
    project: 'proj', request: { id: 'A2', status: 'rejected' },
  });
  assert.equal(lc.get('proj').state, 'approval-pending');
});

test('unconfigured lifecycle is a safe no-op', () => {
  const lc = new MissionLifecycle({ logger: silentLogger });
  assert.equal(lc.transition('proj', 'received'), null);
  assert.equal(lc.get('proj'), null);
});
