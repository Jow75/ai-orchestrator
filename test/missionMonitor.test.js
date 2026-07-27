/**
 * Tests for operator/missionMonitor.js — Phase 12 M2 Priority 4.
 *
 * "Progress must come from real execution. Never fake percentages. Never
 * invent confidence. Never simulate work."
 *
 * So these tests are built on real lifecycle and task-queue files, written the
 * way a mission writes them, and they assert three things in particular:
 *
 *  1. Nothing is announced until something actually changed on disk.
 *  2. A restart does not re-announce history (the baseline is primed silently).
 *  3. The phases a running mission ALREADY notifies about are not re-announced
 *     here — duplicate approval/completion messages are the exact defect class
 *     Phase 11 M2 spent a milestone removing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import MissionMonitor, { ANNOUNCED_PHASES } from '../src/operator/missionMonitor.js';
import MissionLifecycle from '../src/mission/missionLifecycle.js';
import TaskQueue from '../src/mission/taskQueue.js';
import ApprovalStore from '../src/approvals/approvalStore.js';
import EventStore from '../src/events/eventStore.js';
import { ensureRuntimeDirs, resolvePaths } from '../src/infra/paths.js';
import { silentLogger } from '../src/infra/logger.js';

/** A monitor over real stores, with a broadcast spy standing in for a channel. */
function harness({ projects = ['alpha'], config = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-monitor-'));
  const paths = resolvePaths({ root });
  ensureRuntimeDirs(paths);

  const lifecycle = new MissionLifecycle({ lifecycleDir: paths.lifecycleDir, logger: silentLogger });
  const taskQueue = new TaskQueue({ tasksDir: paths.tasksDir, logger: silentLogger, lifecycle });
  const approvalStore = new ApprovalStore({ approvalsDir: paths.approvalsDir, logger: silentLogger });
  const events = new EventStore({ eventsDir: paths.eventsDir, logger: silentLogger });
  const pushed = [];

  const monitor = new MissionMonitor({
    registry: { names: () => projects },
    lifecycle,
    taskQueue,
    approvalStore,
    events,
    gateway: { broadcast: async (text) => { pushed.push(text); return 1; } },
    // No rate limit by default: the limiter has its own test below.
    config: { progressMinIntervalMs: 0, ...config },
    logger: silentLogger,
  });

  return { monitor, lifecycle, taskQueue, approvalStore, events, pushed };
}

/** Seed a queue the way a real mission would have. */
function seedQueue(taskQueue, project, tasks, currentIndex = 0) {
  const queue = taskQueue.ensure(project);
  queue.tasks = tasks;
  queue.currentIndex = currentIndex;
  taskQueue.save(queue);
  return queue;
}

test('the first sighting is a baseline, not news', async () => {
  const { monitor, lifecycle, pushed, events } = harness();
  lifecycle.transition('alpha', 'executing', 'already running before we looked');

  const changes = await monitor.tick();

  assert.deepEqual(changes, [], 'state that predates the monitor is not a change');
  assert.deepEqual(pushed, []);
  assert.equal(events.read().length, 0);
});

test('priming at start does not re-announce a mission that finished last week', async () => {
  const { monitor, lifecycle, pushed } = harness();
  lifecycle.transition('alpha', 'completed', 'finished long ago');

  monitor.prime();
  await monitor.tick();

  assert.deepEqual(pushed, [], 'a service restart must not page the owner about old history');
});

test('a real phase change becomes an event and a push', async () => {
  const { monitor, lifecycle, pushed, events } = harness();
  await monitor.tick(); // baseline

  lifecycle.transition('alpha', 'executing', 'agent launched');
  await monitor.tick();

  assert.equal(pushed.length, 1);
  assert.match(pushed[0], /alpha — Coding/);
  const progress = events.read({ types: ['mission.progress'] });
  assert.equal(progress.length, 1);
  assert.equal(progress[0].payload.state, 'executing');
  assert.equal(progress[0].project, 'alpha');
});

test('progress is counted, never estimated', async () => {
  const { monitor, lifecycle, taskQueue, pushed } = harness();
  seedQueue(taskQueue, 'alpha', [
    { id: 'T1', state: 'done', attempts: 1, checkpoint: null },
    { id: 'T2', state: 'active', attempts: 1, checkpoint: null },
    { id: 'T3', state: 'pending', attempts: 0, checkpoint: null },
  ], 1);
  await monitor.tick();

  lifecycle.transition('alpha', 'verifying', 'checking T2');
  await monitor.tick();

  assert.match(pushed[0], /Tasks: 1\/3 done/, 'a real count of finished work');
  assert.match(pushed[0], /now: T2/);
  assert.doesNotMatch(pushed[0], /%/, 'no percentage is invented from elapsed time');
});

test('a task finishing is recorded even without a phase change', async () => {
  const { monitor, taskQueue, events, pushed } = harness();
  seedQueue(taskQueue, 'alpha', [
    { id: 'T1', state: 'active', attempts: 1, checkpoint: null },
    { id: 'T2', state: 'pending', attempts: 0, checkpoint: null },
  ], 0);
  await monitor.tick();

  seedQueue(taskQueue, 'alpha', [
    { id: 'T1', state: 'done', attempts: 1, checkpoint: null },
    { id: 'T2', state: 'pending', attempts: 0, checkpoint: null },
  ], 1);
  await monitor.tick();

  const progress = events.read({ types: ['mission.progress'] });
  assert.equal(progress.length, 1);
  assert.equal(progress[0].payload.tasksDone, 1);
  assert.deepEqual(pushed, [], 'real progress, but not a phase — recorded, not paged');
});

test('the phases a running mission already announces are NOT re-announced', async () => {
  const { monitor, lifecycle, pushed, events } = harness();
  await monitor.tick();

  for (const state of ['approval-pending', 'approved', 'completed']) {
    lifecycle.transition('alpha', state, 'a real transition');
    // eslint-disable-next-line no-await-in-loop
    await monitor.tick();
  }

  assert.deepEqual(pushed, [],
    'the Approval Manager publishes the request and the mission sends a Mission Card');
  assert.equal(events.read({ types: ['mission.progress'] }).length, 3,
    'but every one of them is still in the durable record');
});

test('a terminal state produces its own event', async () => {
  const { monitor, lifecycle, events } = harness();
  await monitor.tick();

  lifecycle.transition('alpha', 'completed', 'every task verified');
  await monitor.tick();

  assert.equal(events.read({ types: ['mission.completed'] }).length, 1);
});

test('a blocked mission is recorded as blocked', async () => {
  const { monitor, lifecycle, events } = harness();
  await monitor.tick();

  lifecycle.transition('alpha', 'blocked', 'cannot proceed');
  await monitor.tick();

  assert.equal(events.read({ types: ['mission.blocked'] }).length, 1);
});

test('a new pending approval is recorded with its real title', async () => {
  const { monitor, approvalStore, events } = harness();
  await monitor.tick();

  const request = approvalStore.create('alpha', {
    category: 'implementation-plan', approvalClass: 'review', title: 'Plan review — alpha',
  });
  await monitor.tick();

  const recorded = events.read({ types: ['approval.required'] });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].payload.id, request.id);
  assert.equal(recorded[0].payload.title, 'Plan review — alpha');
});

test('an approval already seen is not recorded again on every tick', async () => {
  const { monitor, approvalStore, events } = harness();
  approvalStore.create('alpha', { category: 'x', approvalClass: 'review', title: 'Decide' });
  await monitor.tick();
  await monitor.tick();
  await monitor.tick();

  assert.equal(events.read({ types: ['approval.required'] }).length, 0,
    'it predates the baseline; a poll loop noticing it again is not news');
});

test('the rate limiter suppresses the push but never the record', async () => {
  const { monitor, lifecycle, pushed, events } = harness({ config: { progressMinIntervalMs: 60_000 } });
  await monitor.tick(1_000);

  lifecycle.transition('alpha', 'executing', 'first');
  await monitor.tick(2_000);
  lifecycle.transition('alpha', 'fixing', 'a retry loop flipping states');
  await monitor.tick(3_000);
  lifecycle.transition('alpha', 'executing', 'and back again');
  await monitor.tick(4_000);

  assert.equal(pushed.length, 1, 'a retry loop must not become a notification storm');
  assert.equal(events.read({ types: ['mission.progress'] }).length, 3, 'all three are recorded');
});

test('the rate limit is per project, not global', async () => {
  const { monitor, lifecycle, pushed } = harness({
    projects: ['alpha', 'beta'], config: { progressMinIntervalMs: 60_000 },
  });
  await monitor.tick(1_000);

  lifecycle.transition('alpha', 'executing', 'go');
  lifecycle.transition('beta', 'executing', 'go');
  await monitor.tick(2_000);

  assert.equal(pushed.length, 2, 'one project must not silence another');
});

test('progressUpdates:false records everything and pushes nothing', async () => {
  const { monitor, lifecycle, pushed, events } = harness({ config: { progressUpdates: false } });
  await monitor.tick();

  lifecycle.transition('alpha', 'executing', 'go');
  await monitor.tick();

  assert.deepEqual(pushed, []);
  assert.equal(events.read({ types: ['mission.progress'] }).length, 1);
});

test('projects are observed independently', async () => {
  const { monitor, lifecycle, events } = harness({ projects: ['alpha', 'beta'] });
  await monitor.tick();

  lifecycle.transition('alpha', 'executing', 'alpha only');
  await monitor.tick();

  assert.equal(events.read({ project: 'alpha', types: ['mission.progress'] }).length, 1);
  assert.equal(events.read({ project: 'beta' }).length, 0);
});

test('a failing project list does not take the monitor down', async () => {
  const { monitor } = harness();
  monitor.registry = { names: () => { throw new Error('config unreadable'); } };

  assert.deepEqual(await monitor.tick(), []);
});

test('the announced set is exactly the phases nothing else covers', () => {
  assert.deepEqual([...ANNOUNCED_PHASES], ['planned', 'executing', 'verifying', 'fixing', 'cancelled']);
});
