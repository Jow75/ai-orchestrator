/**
 * Tests for the guided-recovery hint helpers (Phase 11 M3) — pure functions
 * extracted from the CLI's `tasks list`/`approvals list` commands so they're
 * unit-testable without a Commander/console harness (the CLI itself stays a
 * thin shell that just prints whatever these return).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskRecoveryHint, approvalReplyHint } from '../src/cli/index.js';

test('taskRecoveryHint: null when there is no current task', () => {
  assert.equal(taskRecoveryHint('proj', undefined), null);
  assert.equal(taskRecoveryHint('proj', null), null);
});

test('taskRecoveryHint: null for a task that is not blocked/failed', () => {
  for (const state of ['pending', 'active', 'done']) {
    assert.equal(taskRecoveryHint('proj', { id: 'T1', state }), null);
  }
});

test('taskRecoveryHint: a blocked task names both the retry and skip commands, with real ids filled in', () => {
  const hint = taskRecoveryHint('my-project', { id: 'DEPLOY', state: 'blocked' });
  assert.match(hint, /Task "DEPLOY" is blocked/);
  assert.match(hint, /ai-orchestrator tasks approve my-project DEPLOY/);
  assert.match(hint, /ai-orchestrator tasks skip my-project DEPLOY/);
});

test('taskRecoveryHint: a failed task is worded the same way', () => {
  const hint = taskRecoveryHint('proj', { id: 'T2', state: 'failed' });
  assert.match(hint, /Task "T2" is failed/);
});

test('approvalReplyHint: null once a request is no longer pending', () => {
  for (const status of ['approved', 'rejected', 'modified', 'done', 'expired', 'auto-approved']) {
    assert.equal(approvalReplyHint({ id: 'A1', status, approvalClass: 'owner-gate' }), null);
  }
});

test('approvalReplyHint: a pending owner-gate/implementation-review request gets the full reply grammar', () => {
  const hint = approvalReplyHint({ id: 'A7', status: 'pending', approvalClass: 'owner-gate' });
  assert.match(hint, /Reply: APPROVE A7 · REJECT A7 \[reason\] · MODIFY A7 <changes>/);
  assert.match(hint, /ai-orchestrator approvals approve A7/);
});

test('approvalReplyHint: a pending human-action request only offers DONE', () => {
  const hint = approvalReplyHint({ id: 'A9', status: 'pending', approvalClass: 'human-action' });
  assert.match(hint, /Reply: DONE A9/);
  assert.ok(!hint.includes('APPROVE')); // human-action never offers approve/reject/modify
});
