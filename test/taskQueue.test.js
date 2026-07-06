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
import { MemoryStore } from '../src/memory/memoryStore.js';
import { silentLogger } from '../src/infra/logger.js';

function queue() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-tq-'));
  return new TaskQueue({ tasksDir: dir, logger: silentLogger });
}

/** A TaskQueue wired to a real MemoryStore, for archiving tests (Phase P5). */
function queueWithMemory() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-tq-'));
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-tq-mem-'));
  const memoryStore = new MemoryStore({ memoryDir, logger: silentLogger });
  return { q: new TaskQueue({ tasksDir: dir, logger: silentLogger, memoryStore }), memoryStore };
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

// ---------------------------------------------------------------------------
// Phase P7: operator overrides (approveRetry / operatorSkip)
// ---------------------------------------------------------------------------

test('approveRetry() resets a BLOCKED current task back to PENDING with a clean slate', () => {
  const q = queue();
  let state = q.initialize('proj', PLAN, 'sess-1');
  state = q.recordAttempt(state);
  state = q.recordVerifyResult(state, { passed: false, results: [] });
  state = q.markBlocked(state, { summary: 'stuck' });

  const result = q.approveRetry(state, 'T1');
  assert.equal(result.ok, true);
  const task = q.current(state);
  assert.equal(task.state, TaskState.PENDING);
  assert.equal(task.attempts, 0);
  assert.equal(task.checkpoint, null);
  assert.equal(task.lastVerifyResult, null);
});

test('approveRetry() refuses a task that is not blocked/failed', () => {
  const q = queue();
  let state = q.initialize('proj', PLAN, 'sess-1');
  state = q.recordAttempt(state); // ACTIVE, not terminal

  const result = q.approveRetry(state, 'T1');
  assert.equal(result.ok, false);
  assert.match(result.reason, /not blocked\/failed/);
});

test('approveRetry() refuses a task id that is not the current task', () => {
  const q = queue();
  const state = q.initialize('proj', PLAN, 'sess-1');
  const result = q.approveRetry(state, 'T2'); // T1 is current, not T2
  assert.equal(result.ok, false);
  assert.match(result.reason, /not the current task/);
});

test('approveRetry() lets the queue be ADOPTED (not restarted) by the next session', () => {
  const q = queue();
  let state = q.initialize('proj', PLAN, 'sess-1');
  state = q.recordAttempt(state);
  state = q.markFailed(state, { summary: 'exhausted retries' });
  q.approveRetry(state, 'T1');

  const adopted = q.getOrInitialize('proj', PLAN, 'sess-2');
  assert.equal(adopted.currentIndex, 0);
  assert.equal(adopted.tasks[0].state, TaskState.PENDING);
  assert.equal(adopted.sessionId, 'sess-2'); // reattached, not reinitialized from scratch
});

test('operatorSkip() marks a FAILED current task done-via-override and advances', () => {
  const q = queue();
  let state = q.initialize('proj', PLAN, 'sess-1');
  state = q.recordAttempt(state);
  state = q.markFailed(state, { summary: 'could not verify' });

  const result = q.operatorSkip(state, 'T1', 'confirmed manually, moving on');
  assert.equal(result.ok, true);
  assert.equal(state.currentIndex, 1);
  assert.equal(state.tasks[0].state, TaskState.DONE);
  assert.equal(state.tasks[0].checkpoint.outcome, 'operator-skipped');
  assert.equal(state.tasks[0].checkpoint.summary, 'confirmed manually, moving on');
  assert.equal(q.current(state).id, 'T2'); // advanced to the next task
});

test('operatorSkip() refuses a task that is not blocked/failed', () => {
  const q = queue();
  const state = q.initialize('proj', PLAN, 'sess-1'); // T1 is PENDING
  const result = q.operatorSkip(state, 'T1');
  assert.equal(result.ok, false);
  assert.match(result.reason, /not blocked\/failed/);
});

test('operatorSkip() refuses a task id that is not the current task', () => {
  const q = queue();
  let state = q.initialize('proj', PLAN, 'sess-1');
  state = q.recordAttempt(state);
  state = q.markFailed(state, {});
  const result = q.operatorSkip(state, 'T2');
  assert.equal(result.ok, false);
  assert.match(result.reason, /not the current task/);
});

test('recordVerifyResult() stores the latest verification outcome on the current task, independent of checkpoint', () => {
  const q = queue();
  let state = q.initialize('proj', PLAN, 'sess-1');
  const verifyResult = { passed: false, results: [{ type: 'file-exists', passed: false, detail: 'not found' }] };

  state = q.recordVerifyResult(state, verifyResult);
  assert.deepEqual(q.current(state).lastVerifyResult, verifyResult);
  assert.equal(q.current(state).checkpoint, null); // unaffected — still no terminal outcome

  // A fresh instance reloading from disk sees it too (persisted).
  const reloaded = q.load('proj');
  assert.deepEqual(reloaded.tasks[0].lastVerifyResult, verifyResult);
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

test('getOrInitialize() archives the outgoing queue\'s terminal tasks to memory before reinitializing (Phase P5)', () => {
  const { q, memoryStore } = queueWithMemory();
  let state = q.initialize('proj', PLAN, 'sess-1');
  state = q.recordAttempt(state);
  state = q.markDone(state, { summary: 'T1 done successfully' }); // terminal
  state = q.advance(state); // T2 now current
  state = q.recordAttempt(state); // T2 is ACTIVE, NOT terminal

  const changedPlan = [{ id: 'X1' }, { id: 'X2' }];
  q.getOrInitialize('proj', changedPlan, 'sess-1');

  const history = memoryStore.taskHistoryFor('proj', 'T1');
  assert.equal(history.length, 1);
  assert.equal(history[0].outcome, TaskState.DONE);
  assert.equal(history[0].summary, 'T1 done successfully');
  // T2 was never terminal — nothing to archive for it.
  assert.deepEqual(memoryStore.taskHistoryFor('proj', 'T2'), []);
});

test('getOrInitialize() ADOPTS a different session\'s queue when the current task is still pending (Phase P3)', () => {
  // A new session id alone is not reason to discard perfectly good pending
  // work — this is exactly what lets CLI-queued tasks (never attached to a
  // session) or tasks appended after a prior completion get picked up.
  const q = queue();
  let state = q.initialize('proj', PLAN, 'sess-1');
  state = q.recordAttempt(state);
  state = q.markDone(state, {});
  state = q.advance(state); // T2 now current, PENDING, never attempted

  const adopted = q.getOrInitialize('proj', PLAN, 'sess-2');
  assert.equal(adopted.currentIndex, 1); // NOT reset to 0
  assert.equal(adopted.tasks[0].state, TaskState.DONE); // T1's history preserved
  assert.equal(adopted.sessionId, 'sess-2'); // reattached to the new session
});

test('getOrInitialize() NEVER re-adopts a BLOCKED task under a new session (loop-prevention safety net)', () => {
  // The critical safety property: a mission that was blocked must not be
  // silently re-attached to a fresh session — that would re-enter exactly
  // the futile loop blocking exists to stop.
  const q = queue();
  let state = q.initialize('proj', PLAN, 'sess-1');
  state = q.recordAttempt(state);
  state = q.markBlocked(state, { reason: 'stagnation' }); // T1 blocked, currentIndex still 0

  const fresh = q.getOrInitialize('proj', PLAN, 'sess-2');
  assert.equal(fresh.currentIndex, 0);
  assert.equal(fresh.tasks[0].state, TaskState.PENDING); // reinitialized, not adopted
  assert.notDeepEqual(fresh.tasks[0].checkpoint, { reason: 'stagnation' });
});

test('getOrInitialize() NEVER re-adopts a fully-complete queue under a new session', () => {
  const q = queue();
  let state = q.initialize('proj', [{ id: 'T1' }], 'sess-1');
  state = q.recordAttempt(state);
  state = q.markDone(state, {});
  state = q.advance(state); // currentIndex 1 === tasks.length -> complete, current() is null

  const fresh = q.getOrInitialize('proj', [{ id: 'T1' }], 'sess-2');
  assert.equal(fresh.currentIndex, 0);
  assert.equal(fresh.tasks[0].state, TaskState.PENDING);
});

// ---------------------------------------------------------------------------
// Phase P3: runtime queue mutation (enqueue / removeTask / reorderTask)
// ---------------------------------------------------------------------------

test('ensure() creates an empty, session-less queue when none exists', () => {
  const q = queue();
  const created = q.ensure('proj');
  assert.equal(created.sessionId, null);
  assert.deepEqual(created.tasks, []);

  // Idempotent: calling again returns the SAME (not a new) queue.
  const again = q.ensure('proj');
  assert.deepEqual(again, created);
});

test('enqueue() appends a task carrying its full definition', () => {
  const q = queue();
  let state = q.ensure('proj');
  state = q.enqueue(state, { id: 'T1', objective: 'do a thing', resolvedPromptFile: '/x/p.md', verify: [], maxRuns: 5 });

  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].id, 'T1');
  assert.equal(state.tasks[0].objective, 'do a thing');
  assert.equal(state.tasks[0].resolvedPromptFile, '/x/p.md');
  assert.equal(state.tasks[0].state, TaskState.PENDING);
  assert.equal(state.tasks[0].attempts, 0);
});

test('enqueue() onto a fully-completed queue makes it resumable again', () => {
  const q = queue();
  let state = q.initialize('proj', [{ id: 'T1' }], 'sess-1');
  state = q.recordAttempt(state);
  state = q.markDone(state, {});
  state = q.advance(state);
  assert.equal(q.isComplete(state), true);

  state = q.enqueue(state, { id: 'T2' });
  assert.equal(q.isComplete(state), false);
  assert.equal(q.current(state).id, 'T2');
  assert.equal(q.currentIsResumable(state), true);
});

test('removeTask() removes a PENDING task', () => {
  const q = queue();
  let state = q.initialize('proj', PLAN, 'sess-1');
  const result = q.removeTask(state, 'T2');
  assert.equal(result.ok, true);
  assert.deepEqual(state.tasks.map((t) => t.id), ['T1', 'T3']);
});

test('removeTask() refuses to remove an ACTIVE, DONE, FAILED, or BLOCKED task', () => {
  const q = queue();
  let state = q.initialize('proj', PLAN, 'sess-1');
  state = q.recordAttempt(state); // T1 -> ACTIVE

  const activeResult = q.removeTask(state, 'T1');
  assert.equal(activeResult.ok, false);
  assert.match(activeResult.reason, /not pending/);

  state = q.markDone(state, {});
  const doneResult = q.removeTask(state, 'T1');
  assert.equal(doneResult.ok, false);
  assert.equal(state.tasks.some((t) => t.id === 'T1'), true); // never removed
});

test('removeTask() reports a clear error for an unknown id', () => {
  const q = queue();
  const state = q.initialize('proj', PLAN, 'sess-1');
  const result = q.removeTask(state, 'ghost');
  assert.equal(result.ok, false);
  assert.match(result.reason, /No task "ghost"/);
});

test('reorderTask() moves a pending task up and down among other pending tasks', () => {
  const q = queue();
  let state = q.initialize('proj', PLAN, 'sess-1'); // T1(current), T2, T3 all pending initially

  // T3 can move up past T2.
  let result = q.reorderTask(state, 'T3', 'up');
  assert.equal(result.ok, true);
  assert.deepEqual(state.tasks.map((t) => t.id), ['T1', 'T3', 'T2']);

  // ...and back down.
  result = q.reorderTask(state, 'T3', 'down');
  assert.equal(result.ok, true);
  assert.deepEqual(state.tasks.map((t) => t.id), ['T1', 'T2', 'T3']);
});

test('reorderTask() cannot move a task past the current (non-pending) task', () => {
  const q = queue();
  let state = q.initialize('proj', PLAN, 'sess-1');
  state = q.recordAttempt(state); // T1 -> ACTIVE (current)

  const result = q.reorderTask(state, 'T2', 'up'); // would swap with ACTIVE T1
  assert.equal(result.ok, false);
  assert.match(result.reason, /already active/i);
  assert.deepEqual(state.tasks.map((t) => t.id), ['T1', 'T2', 'T3']); // unchanged
});

test('reorderTask() refuses to reorder a non-pending task itself', () => {
  const q = queue();
  let state = q.initialize('proj', PLAN, 'sess-1');
  state = q.recordAttempt(state); // T1 -> ACTIVE

  const result = q.reorderTask(state, 'T1', 'down');
  assert.equal(result.ok, false);
  assert.match(result.reason, /not pending/);
});

test('reorderTask() refuses to move past the boundary of the queue', () => {
  const q = queue();
  const state = q.initialize('proj', PLAN, 'sess-1');
  const result = q.reorderTask(state, 'T3', 'down'); // already last
  assert.equal(result.ok, false);
  assert.match(result.reason, /already at that end/);
});
