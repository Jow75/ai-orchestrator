/**
 * Tests for checkpoint construction — a pure data snapshot of "what
 * happened on this task", scoped deliberately to data only (turning this
 * into a Claude-facing briefing is Phase P4, the Continuation Builder).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCheckpoint } from '../src/mission/checkpoint.js';

const TASK = { id: 'T1', objective: 'Scaffold the project' };

test('captures task identity, attempts, and outcome', () => {
  const cp = buildCheckpoint({ task: TASK, attempts: 2, outcome: 'done' });
  assert.equal(cp.taskId, 'T1');
  assert.equal(cp.objective, 'Scaffold the project');
  assert.equal(cp.attempts, 2);
  assert.equal(cp.outcome, 'done');
  assert.ok(cp.at);
});

test('captures files touched (created + modified) and deleted separately', () => {
  const cp = buildCheckpoint({
    task: TASK, attempts: 1, outcome: 'done',
    changes: { created: ['a.txt'], modified: ['b.txt'], deleted: ['c.txt'] },
  });
  assert.deepEqual(cp.filesTouched, ['a.txt', 'b.txt']);
  assert.deepEqual(cp.filesDeleted, ['c.txt']);
});

test('with no changes available, file lists are empty (not null/undefined)', () => {
  const cp = buildCheckpoint({ task: TASK, attempts: 1, outcome: 'blocked' });
  assert.deepEqual(cp.filesTouched, []);
  assert.deepEqual(cp.filesDeleted, []);
});

test('captures the verification result when present', () => {
  const verifyResult = { passed: false, results: [{ type: 'file-exists', passed: false, detail: 'x' }] };
  const cp = buildCheckpoint({ task: TASK, attempts: 3, outcome: 'failed', verifyResult });
  assert.equal(cp.verify.passed, false);
  assert.equal(cp.verify.results.length, 1);
});

test('verify is null when no verification ran', () => {
  const cp = buildCheckpoint({ task: TASK, attempts: 1, outcome: 'done' });
  assert.equal(cp.verify, null);
});

test('summary is truncated to a bounded length', () => {
  const cp = buildCheckpoint({
    task: TASK, attempts: 1, outcome: 'done', resultText: 'x'.repeat(1000),
  });
  assert.ok(cp.summary.length <= 500);
});
