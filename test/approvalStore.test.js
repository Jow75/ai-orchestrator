/**
 * Unit tests for approvalStore.js — persisted approval requests with
 * globally-unique ids, decisions, cross-project lookup, and safe no-op
 * degradation when unconfigured.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApprovalStore } from '../src/approvals/approvalStore.js';
import { silentLogger } from '../src/infra/logger.js';

function store() {
  const approvalsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-approvals-'));
  return new ApprovalStore({ approvalsDir, logger: silentLogger });
}

const FIELDS = {
  category: 'tests', approvalClass: 'automatic', title: 'Run the tests',
};

test('create() assigns globally-unique ids across projects', () => {
  const s = store();
  const a = s.create('projA', FIELDS);
  const b = s.create('projB', FIELDS);
  const c = s.create('projA', FIELDS);
  assert.notEqual(a.id, b.id);
  assert.notEqual(b.id, c.id);
  assert.match(a.id, /^A\d+$/);
  assert.equal(a.status, 'pending');
});

test('resolve() decides a pending request exactly once', () => {
  const s = store();
  const request = s.create('proj', FIELDS);
  const result = s.resolve('proj', request.id, { decision: 'approved', by: 'me', via: 'cli' });
  assert.equal(result.ok, true);
  assert.equal(result.request.status, 'approved');
  assert.ok(result.request.decidedAt);

  // A second decision is refused.
  const again = s.resolve('proj', request.id, { decision: 'rejected' });
  assert.equal(again.ok, false);
  assert.match(again.reason, /already approved/);
});

test('resolve() refuses unknown decisions and unknown ids', () => {
  const s = store();
  const request = s.create('proj', FIELDS);
  assert.equal(s.resolve('proj', request.id, { decision: 'maybe' }).ok, false);
  assert.equal(s.resolve('proj', 'A999', { decision: 'approved' }).ok, false);
});

test('resolveById() finds the request without knowing its project', () => {
  const s = store();
  s.create('alpha', FIELDS);
  const target = s.create('beta', { ...FIELDS, category: 'secrets', approvalClass: 'owner-gate' });
  const result = s.resolveById(target.id, { decision: 'rejected', note: 'no', via: 'telegram' });
  assert.equal(result.ok, true);
  assert.equal(s.get('beta', target.id).status, 'rejected');
  assert.equal(s.get('beta', target.id).decisionNote, 'no');
});

test('pending()/pendingAll() list only undecided requests, oldest first', () => {
  const s = store();
  const p1 = s.create('one', FIELDS);
  s.create('one', { ...FIELDS, status: 'auto-approved' });
  const p2 = s.create('two', FIELDS);
  s.resolve('one', p1.id, { decision: 'done' });

  assert.deepEqual(s.pending('one'), []);
  assert.deepEqual(s.pendingAll().map((r) => r.id), [p2.id]);
});

test('findPending() matches on (project, taskId, category); null taskId matches null', () => {
  const s = store();
  const withTask = s.create('proj', { ...FIELDS, taskId: 'T1' });
  const legacy = s.create('proj', { ...FIELDS, category: 'secrets' }); // taskId omitted -> null

  assert.equal(s.findPending('proj', { taskId: 'T1', category: 'tests' }).id, withTask.id);
  assert.equal(s.findPending('proj', { category: 'secrets' }).id, legacy.id); // default taskId: null
  assert.equal(s.findPending('proj', { taskId: 'T2', category: 'tests' }), null); // different task
  assert.equal(s.findPending('other-proj', { taskId: 'T1', category: 'tests' }), null); // different project
});

test('findPending() ignores requests that are already decided', () => {
  const s = store();
  const request = s.create('proj', { ...FIELDS, taskId: 'T1' });
  s.resolve('proj', request.id, { decision: 'approved' });
  assert.equal(s.findPending('proj', { taskId: 'T1', category: 'tests' }), null);
});

test('annotate() merges details without touching status', () => {
  const s = store();
  const request = s.create('proj', { ...FIELDS, details: { version: '1.0.0' } });
  s.resolve('proj', request.id, { decision: 'approved' });
  const result = s.annotate('proj', request.id, { consumedAt: '2026-01-01T00:00:00Z' });
  assert.equal(result.ok, true);
  const stored = s.get('proj', request.id);
  assert.equal(stored.status, 'approved');
  assert.equal(stored.details.version, '1.0.0');
  assert.equal(stored.details.consumedAt, '2026-01-01T00:00:00Z');
});

test('unconfigured store degrades to safe no-ops', () => {
  const s = new ApprovalStore({ logger: silentLogger });
  assert.equal(s.create('p', FIELDS), null);
  assert.deepEqual(s.pendingAll(), []);
  assert.equal(s.load('p'), null);
});

test('listProjects() ignores the counter and provider state files', () => {
  const s = store();
  s.create('realproj', FIELDS);
  fs.writeFileSync(path.join(s.approvalsDir, 'telegram.offset'), '{"offset":5}');
  assert.deepEqual(s.listProjects(), ['realproj']);
});
