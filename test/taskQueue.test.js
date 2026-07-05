/**
 * Tests for the persistent task queue: attempts, transitions, advancement,
 * and — critically — that it survives being reloaded by a fresh instance
 * (simulating a crash/restart mid-mission) exactly where it left off.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskQueue } from '../src/mission/taskQueue.js';
import { TaskState } from '../src/mission/taskState.js';
import { silentLogger } from '../src/infra/logger.js';

function queue() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-tq-'));
  return new TaskQueue({ tasksDir: dir, logger: silentLogger });
}

const PLAN = [{ id: 'T1' }, { id: 'T2' }, { id: 'T3' }];

test('initialize() creates all tasks PENDING with zero attempts', () => {
  const q = queue();
  const state = q.initialize('proj', PLAN, 'sess-1');
  assert.equal(state.currentIndex, 0);
  assert.equal(state.tasks.length, 3);
  assert.ok(state.tasks.every((t) => t.state === TaskState.PENDING && t.attempts === 0));
});

test('recordAttempt() increments attempts and moves PENDING -> ACTIVE', () => {
  const q = queue();
  let state = q.initialize('proj', PLAN, 'sess-1');
  state = q.recordAttempt(state);
  assert.equal(q.current(state).state, TaskState.ACTIVE);
  assert.equal(q.current(state).attempts, 1);
  state = q.recordAttempt(state);
  assert.equal(q.current(state).attempts, 2);
});

test('markDone() stores the checkpoint and advance() moves to the next task', () => {
  const q = queue();
  let state = q.initialize('proj', PLAN, 'sess-1');
  state = q.recordAttempt(state);
  state = q.markDone(state, { taskId: 'T1', outcome: 'done' });
  assert.equal(q.current(state).state, TaskState.DONE);
  assert.deepEqual(q.current(state).checkpoint, { taskId: 'T1', outcome: 'done' });

  state = q.advance(state);
  assert.equal(state.currentIndex, 1);
  assert.equal(q.current(state).id, 'T2');
});

test('isComplete() is true only once every task has been advanced past', () => {
  const q = queue();
  let state = q.initialize('proj', [{ id: 'T1' }], 'sess-1');
  assert.equal(q.isComplete(state), false);
  state = q.markDone(state, {});
  state = q.advance(state);
  assert.equal(q.isComplete(state), true);
  assert.equal(q.current(state), null);
});

test('markFailed() and markBlocked() set the expected terminal states', () => {
  const q = queue();
  let state = q.initialize('proj', PLAN, 'sess-1');
  state = q.markFailed(state, { reason: 'verification never passed' });
  assert.equal(q.current(state).state, TaskState.FAILED);

  state = q.initialize('proj2', PLAN, 'sess-1');
  state = q.markBlocked(state, { reason: 'agent reported blocked' });
  assert.equal(q.current(state).state, TaskState.BLOCKED);
});

test('currentIsResumable() reflects PENDING/ACTIVE vs terminal states', () => {
  const q = queue();
  let state = q.initialize('proj', PLAN, 'sess-1');
  assert.equal(q.currentIsResumable(state), true); // PENDING
  state = q.recordAttempt(state);
  assert.equal(q.currentIsResumable(state), true); // ACTIVE
  state = q.markDone(state, {});
  assert.equal(q.currentIsResumable(state), false); // DONE
});

test('a fresh TaskQueue instance reloads persisted progress (crash/restart survival)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-tq-'));
  const first = new TaskQueue({ tasksDir: dir, logger: silentLogger });
  let state = first.initialize('proj', PLAN, 'sess-1');
  state = first.recordAttempt(state);
  state = first.markDone(state, { taskId: 'T1' });
  state = first.advance(state);
  state = first.recordAttempt(state); // T2, attempt 1

  const second = new TaskQueue({ tasksDir: dir, logger: silentLogger });
  const reloaded = second.getOrInitialize('proj', PLAN, 'sess-1');
  assert.equal(reloaded.currentIndex, 1);
  assert.equal(second.current(reloaded).id, 'T2');
  assert.equal(second.current(reloaded).attempts, 1);
  assert.equal(reloaded.tasks[0].state, TaskState.DONE);
});

test('getOrInitialize() reinitializes when the plan changes shape mid-session', () => {
  const q = queue();
  let state = q.initialize('proj', PLAN, 'sess-1');
  state = q.recordAttempt(state);

  // Same session, but the task list now has different ids (project edited).
  const changedPlan = [{ id: 'X1' }, { id: 'X2' }];
  const reinitialized = q.getOrInitialize('proj', changedPlan, 'sess-1');
  assert.equal(reinitialized.tasks.length, 2);
  assert.equal(reinitialized.tasks[0].id, 'X1');
  assert.equal(reinitialized.currentIndex, 0);
});

test('getOrInitialize() starts fresh for a new session id (new mission, not a resume)', () => {
  const q = queue();
  let state = q.initialize('proj', PLAN, 'sess-1');
  state = q.recordAttempt(state);
  state = q.markDone(state, {});
  state = q.advance(state);

  const fresh = q.getOrInitialize('proj', PLAN, 'sess-2');
  assert.equal(fresh.currentIndex, 0);
  assert.equal(fresh.tasks[0].state, TaskState.PENDING);
});
