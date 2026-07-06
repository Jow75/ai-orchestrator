/**
 * Tests for the Phase P5 MemoryStore: durable operator notes, the
 * auto-recorded failure catalog, and archived task history for a task id
 * whose live queue entry was discarded by a plan-shape reinitialization.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../src/memory/memoryStore.js';
import { TaskState } from '../src/mission/taskState.js';
import { silentLogger } from '../src/infra/logger.js';

function store() {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-memory-'));
  return new MemoryStore({ memoryDir, logger: silentLogger });
}

test('load() returns null for a project with no recorded memory', () => {
  assert.equal(store().load('nope'), null);
});

test('ensure() creates an empty record and persists it', () => {
  const s = store();
  const mem = s.ensure('proj');
  assert.deepEqual(mem, { project: 'proj', notes: [], failures: [], taskHistory: [] });
  assert.deepEqual(s.load('proj'), mem);
});

test('addNote() appends a note with an incrementing id and timestamp', () => {
  const s = store();
  s.addNote('proj', { category: 'architecture', text: 'build via npm run build' });
  s.addNote('proj', { category: 'project', text: 'deploy on Fridays only' });

  const mem = s.load('proj');
  assert.equal(mem.notes.length, 2);
  assert.equal(mem.notes[0].id, 1);
  assert.equal(mem.notes[1].id, 2);
  assert.equal(mem.notes[0].category, 'architecture');
  assert.ok(mem.notes[0].at);
});

test('recentNotes() returns most-recent-first, capped to the limit', () => {
  const s = store();
  for (let i = 1; i <= 5; i += 1) s.addNote('proj', { category: 'project', text: `note ${i}` });

  const recent = s.recentNotes('proj', 2);
  assert.deepEqual(recent.map((n) => n.text), ['note 5', 'note 4']);
});

test('recordFailure() auto-records a failure as unresolved', () => {
  const s = store();
  s.recordFailure('proj', { category: 'verification-failed', reason: 'X never happens', hint: 'check Y', taskId: 'T1' });

  const mem = s.load('proj');
  assert.equal(mem.failures.length, 1);
  assert.equal(mem.failures[0].resolved, false);
  assert.equal(mem.failures[0].taskId, 'T1');
});

test('activeFailures() excludes resolved failures and orders most-recent-first', () => {
  const s = store();
  s.recordFailure('proj', { category: 'a', reason: 'first problem' });
  s.recordFailure('proj', { category: 'b', reason: 'second problem' });
  const mem = s.load('proj');
  const firstId = mem.failures[0].id;
  s.resolveFailure('proj', firstId);

  const active = s.activeFailures('proj');
  assert.equal(active.length, 1);
  assert.equal(active[0].reason, 'second problem');
});

test('resolveFailure() reports a clear error for an unknown id', () => {
  const s = store();
  s.ensure('proj');
  const result = s.resolveFailure('proj', 999);
  assert.equal(result.ok, false);
  assert.match(result.reason, /999/);
});

test('archiveTaskHistory() records only terminally-attempted tasks, not PENDING ones', () => {
  const s = store();
  const tasks = [
    { id: 'T1', state: TaskState.DONE, attempts: 1, checkpoint: { summary: 'wrote index.js' } },
    { id: 'T2', state: TaskState.FAILED, attempts: 3, checkpoint: { summary: null } },
    { id: 'T3', state: TaskState.PENDING, attempts: 0, checkpoint: null },
  ];
  s.archiveTaskHistory('proj', tasks);

  const mem = s.load('proj');
  assert.equal(mem.taskHistory.length, 2);
  assert.deepEqual(mem.taskHistory.map((h) => h.taskId), ['T1', 'T2']);
  assert.equal(mem.taskHistory[0].summary, 'wrote index.js');
});

test('archiveTaskHistory() is a no-op when nothing is archivable', () => {
  const s = store();
  s.archiveTaskHistory('proj', [{ id: 'T1', state: TaskState.PENDING, attempts: 0 }]);
  assert.equal(s.load('proj'), null); // never even created a record
});

test('taskHistoryFor() returns only entries matching the given task id, oldest first', () => {
  const s = store();
  s.archiveTaskHistory('proj', [
    { id: 'T1', state: TaskState.FAILED, attempts: 2, checkpoint: { summary: 'attempt one' } },
  ]);
  s.archiveTaskHistory('proj', [
    { id: 'T1', state: TaskState.DONE, attempts: 1, checkpoint: { summary: 'attempt two, succeeded' } },
    { id: 'T2', state: TaskState.DONE, attempts: 1, checkpoint: { summary: 'unrelated' } },
  ]);

  const history = s.taskHistoryFor('proj', 'T1');
  assert.equal(history.length, 2);
  assert.equal(history[0].summary, 'attempt one');
  assert.equal(history[1].summary, 'attempt two, succeeded');
});

test('a project with no memoryDir configured degrades to safe no-ops (legacy test harnesses)', () => {
  const s = new MemoryStore({ memoryDir: undefined, logger: silentLogger });
  assert.equal(s.load('proj'), null);
  assert.doesNotThrow(() => s.recordFailure('proj', { category: 'x', reason: 'y' }));
  assert.doesNotThrow(() => s.archiveTaskHistory('proj', [{ id: 'T1', state: TaskState.DONE, attempts: 1 }]));
  assert.deepEqual(s.recentNotes('proj'), []);
  assert.deepEqual(s.activeFailures('proj'), []);
  assert.deepEqual(s.taskHistoryFor('proj', 'T1'), []);
});

test('a fresh MemoryStore instance reloads persisted memory (crash/restart survival)', () => {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-memory-'));
  const first = new MemoryStore({ memoryDir, logger: silentLogger });
  first.addNote('proj', { category: 'project', text: 'persisted fact' });

  const second = new MemoryStore({ memoryDir, logger: silentLogger });
  assert.equal(second.recentNotes('proj')[0].text, 'persisted fact');
});
