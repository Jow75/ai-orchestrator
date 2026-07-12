/**
 * Unit tests for the Phase 10H coordination layer: dependency graph
 * (validation, ready set, conflicts, assignment planning incl. work
 * stealing), cross-mission resource locks, and the agent message bus.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  validateDependencies, depsSatisfied, readyTasks, blockedByDependencies,
  resourceConflicts, planAssignments,
} from '../src/coordination/dependencyGraph.js';
import { ResourceLockManager } from '../src/coordination/resourceLocks.js';
import { AgentMessageBus } from '../src/coordination/agentMessages.js';
import { silentLogger } from '../src/infra/logger.js';

// ── dependency graph ──────────────────────────────────────────────────────

test('validateDependencies: earlier-only rule (self/unknown/later all refused)', () => {
  const ok = validateDependencies([
    { id: 'T1', dependsOn: [] },
    { id: 'T2', dependsOn: ['T1'] },
    { id: 'T3', dependsOn: ['T1', 'T2'] },
  ]);
  assert.deepEqual(ok, []);

  const bad = validateDependencies([
    { id: 'T1', dependsOn: ['T2'] }, // forward reference
    { id: 'T2', dependsOn: ['T2'] }, // self
    { id: 'T3', dependsOn: ['NOPE'] }, // unknown
  ]);
  assert.equal(bad.length, 3);
  assert.match(bad[0], /LATER in the plan/);
  assert.match(bad[1], /cannot depend on itself/);
  assert.match(bad[2], /unknown task/);
});

test('readyTasks/blockedByDependencies split pending work by satisfied deps', () => {
  const queue = {
    currentIndex: 1,
    tasks: [
      { id: 'T1', state: 'done', dependsOn: [] },
      { id: 'T2', state: 'pending', dependsOn: ['T1'] },
      { id: 'T3', state: 'pending', dependsOn: ['T2'] },
      { id: 'T4', state: 'pending', dependsOn: [] },
    ],
  };
  assert.deepEqual(readyTasks(queue).map((t) => t.id), ['T2', 'T4']);
  assert.deepEqual(blockedByDependencies(queue), [{ taskId: 'T3', waitingOn: ['T2'] }]);
  assert.equal(depsSatisfied(queue, queue.tasks[1]), true);
  assert.equal(depsSatisfied(queue, queue.tasks[2]), false);
});

test('resourceConflicts finds shared resources among a set of tasks', () => {
  const conflicts = resourceConflicts([
    { id: 'A', resources: ['db', 'cache'] },
    { id: 'B', resources: ['db'] },
    { id: 'C', resources: ['files'] },
  ]);
  assert.deepEqual(conflicts, [{ resource: 'db', taskIds: ['A', 'B'] }]);
});

test('planAssignments spreads ready tasks across agents, stealing when one is overloaded', () => {
  const roster = [
    { id: 'coder', role: 'coding', enabled: true },
    { id: 'helper', role: 'general', enabled: true },
  ];
  const ready = [
    { id: 'T1', role: 'coding', resources: [] },
    { id: 'T2', role: 'coding', resources: [] }, // same routed agent → steal to helper
    { id: 'T3', role: null, resources: [] }, // no idle agent left → not parallelizable
  ];
  const plan = planAssignments({
    ready, roster, routeFor: () => roster[0], // everything routes to 'coder'
  });
  assert.deepEqual(plan.assignments, [
    { taskId: 'T1', agentId: 'coder', stolen: false },
    { taskId: 'T2', agentId: 'helper', stolen: true, from: 'coder' },
  ]);
  assert.equal(plan.parallelizable, 2);

  // Conflicting resources keep the later task out of the parallel plan.
  const conflicted = planAssignments({
    ready: [
      { id: 'T1', role: null, resources: ['db'] },
      { id: 'T2', role: null, resources: ['db'] },
    ],
    roster,
    routeFor: () => roster[1],
  });
  assert.deepEqual(conflicted.assignments.map((a) => a.taskId), ['T1']);
  assert.equal(conflicted.conflicts.length, 1);
});

// ── resource locks ────────────────────────────────────────────────────────

function locks({ staleMs } = {}) {
  const coordinationDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-locks-'));
  return new ResourceLockManager({ coordinationDir, logger: silentLogger, staleMs });
}

test('acquireAll is all-or-nothing; conflicts name the holder', () => {
  const manager = locks();
  assert.equal(manager.acquireAll(['db', 'cache'], { project: 'alpha', taskId: 'T1' }).ok, true);

  const denied = manager.acquireAll(['cache', 'files'], { project: 'beta', taskId: 'T9' });
  assert.equal(denied.ok, false);
  assert.deepEqual(denied.conflicts.map((c) => c.resource), ['cache']);
  assert.equal(denied.conflicts[0].heldBy.project, 'alpha');
  // 'files' was NOT taken (all-or-nothing).
  assert.equal(manager.held().length, 2);
});

test('the same holder re-acquires its own locks (retry/restart safe)', () => {
  const manager = locks();
  manager.acquireAll(['db'], { project: 'alpha', taskId: 'T1' });
  assert.equal(manager.acquireAll(['db'], { project: 'alpha', taskId: 'T1' }).ok, true);
  // A DIFFERENT task of the same project is still a conflict.
  assert.equal(manager.acquireAll(['db'], { project: 'alpha', taskId: 'T2' }).ok, false);
});

test('stale locks (dead pid) are reclaimed', () => {
  const manager = locks();
  manager.acquireAll(['db'], { project: 'alpha', taskId: 'T1', pid: 999999999 });
  const result = manager.acquireAll(['db'], { project: 'beta', taskId: 'T2' });
  assert.equal(result.ok, true);
  assert.equal(manager.held()[0].holder.project, 'beta');
});

test('releaseAll scopes to task or whole project', () => {
  const manager = locks();
  manager.acquireAll(['db'], { project: 'alpha', taskId: 'T1' });
  manager.acquireAll(['cache'], { project: 'alpha', taskId: 'T2' });
  manager.acquireAll(['files'], { project: 'beta', taskId: 'T1' });

  assert.deepEqual(manager.releaseAll({ project: 'alpha', taskId: 'T1' }), ['db']);
  assert.deepEqual(manager.releaseAll({ project: 'alpha' }), ['cache']);
  assert.equal(manager.held().length, 1); // beta's lock untouched
});

test('unconfigured lock manager is a safe no-op (acquire always succeeds)', () => {
  const manager = new ResourceLockManager({ logger: silentLogger });
  assert.equal(manager.acquireAll(['anything'], { project: 'p' }).ok, true);
  assert.deepEqual(manager.releaseAll({ project: 'p' }), []);
});

// ── agent message bus ─────────────────────────────────────────────────────

function bus() {
  const coordinationDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-msgs-'));
  return new AgentMessageBus({ coordinationDir, logger: silentLogger });
}

test('messages address an agent id, a role, or everyone', () => {
  const b = bus();
  b.post('proj', { from: 'coder', to: 'tester', topic: 'handoff', text: 'T1 done' });
  b.post('proj', { from: 'coder', to: 'role:documentation', text: 'API changed' });
  b.post('proj', { from: 'tester', to: 'all', text: 'flaky test disabled' });

  const forTester = b.unreadFor('proj', { agentId: 'tester', role: 'testing' });
  assert.deepEqual(forTester.map((m) => m.text), ['T1 done']);

  const forDocs = b.unreadFor('proj', { agentId: 'writer', role: 'documentation' });
  assert.deepEqual(forDocs.map((m) => m.text), ['API changed', 'flaky test disabled']);

  // Senders never see their own messages.
  const forCoder = b.unreadFor('proj', { agentId: 'coder', role: 'coding' });
  assert.deepEqual(forCoder.map((m) => m.text), ['flaky test disabled']);
});

test('markRead removes messages from that agent’s future briefings only', () => {
  const b = bus();
  const posted = b.post('proj', { from: 'a', to: 'all', text: 'hello' });
  b.markRead('proj', [posted.id], 'tester');
  assert.equal(b.unreadFor('proj', { agentId: 'tester' }).length, 0);
  assert.equal(b.unreadFor('proj', { agentId: 'writer' }).length, 1);
});

test('the log is capped at 200 messages', () => {
  const b = bus();
  for (let i = 0; i < 210; i += 1) {
    b.post('proj', { from: 'a', to: 'all', text: `m${i}` });
  }
  const all = b.list('proj');
  assert.equal(all.length, 200);
  assert.equal(all[0].text, 'm10'); // oldest ten dropped
});
