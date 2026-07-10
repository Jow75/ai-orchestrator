/**
 * Tests for the Status Manager: the live status.json snapshot. Previously
 * only exercised indirectly via orchestrator tests — this adds direct
 * coverage, including the new (P2) task-queue sync used for mission mode.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StatusManager } from '../src/state/statusManager.js';
import { silentLogger } from '../src/infra/logger.js';

function manager() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-status-'));
  return new StatusManager({ statusFile: path.join(dir, 'status.json'), logger: silentLogger });
}

test('defaults include a legacy mission section', () => {
  const s = manager();
  assert.deepEqual(s.get().mission, {
    mode: 'legacy', currentTaskId: null, taskIndex: null,
    totalTasks: 0, taskState: null, taskAttempts: 0,
    currentAgent: null, currentAgentRole: null,
  });
});

test('set() merges into a section without clobbering siblings', () => {
  const s = manager();
  s.set({ agent: { pid: 123 } });
  s.set({ agent: { state: 'running' } });
  assert.equal(s.get().agent.pid, 123);
  assert.equal(s.get().agent.state, 'running');
});

test('set() persists to disk atomically', () => {
  const s = manager();
  s.set({ project: 'demo' });
  const onDisk = JSON.parse(fs.readFileSync(s.statusFile, 'utf8'));
  assert.equal(onDisk.project, 'demo');
});

test('syncSession() copies session fields and derives rateLimit.estimatedWaitMs', () => {
  const s = manager();
  const resumeAt = new Date(Date.now() + 60_000).toISOString();
  s.syncSession({
    id: 'sess-1', project: 'demo', engineSessionId: 'eng-1', state: 'waiting-rate-limit',
    createdAt: '2026-01-01T00:00:00.000Z', runs: 3, resumes: 2, crashes: 0, rateLimits: 1, resumeAt,
  });
  const status = s.get();
  assert.equal(status.session.id, 'sess-1');
  assert.equal(status.counters.runs, 3);
  assert.equal(status.rateLimit.waiting, true);
  assert.ok(status.rateLimit.estimatedWaitMs > 0);
});

test('syncTaskQueue(null) reports legacy mode', () => {
  const s = manager();
  s.syncTaskQueue({ tasks: [{ id: 'T1', state: 'active', attempts: 1 }], currentIndex: 0 });
  s.syncTaskQueue(null);
  assert.deepEqual(s.get().mission, {
    mode: 'legacy', currentTaskId: null, taskIndex: null,
    totalTasks: 0, taskState: null, taskAttempts: 0,
    currentAgent: null, currentAgentRole: null,
  });
});

test('syncTaskQueue() reports the current task\'s id, state, and attempts', () => {
  const s = manager();
  const queue = {
    currentIndex: 1,
    tasks: [
      { id: 'T1', state: 'done', attempts: 1 },
      { id: 'T2', state: 'active', attempts: 2 },
      { id: 'T3', state: 'pending', attempts: 0 },
    ],
  };
  s.syncTaskQueue(queue);
  assert.deepEqual(s.get().mission, {
    mode: 'tasks', currentTaskId: 'T2', taskIndex: 1,
    totalTasks: 3, taskState: 'active', taskAttempts: 2,
    currentAgent: null, currentAgentRole: null,
  });
});

test('syncTaskQueue() reports totalTasks as the index once every task is done', () => {
  const s = manager();
  const queue = { currentIndex: 2, tasks: [{ id: 'T1', state: 'done', attempts: 1 }, { id: 'T2', state: 'done', attempts: 1 }] };
  s.syncTaskQueue(queue);
  const mission = s.get().mission;
  assert.equal(mission.currentTaskId, null);
  assert.equal(mission.taskIndex, 2);
  assert.equal(mission.taskState, 'done');
});

test('stopUpdates() writes a final snapshot with the given state', () => {
  const s = manager();
  s.stopUpdates('gave-up');
  assert.equal(s.get().orchestrator.state, 'gave-up');
});
