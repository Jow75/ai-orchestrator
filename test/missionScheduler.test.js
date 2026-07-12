/**
 * Unit tests for missionScheduler.js — Phase 10G: schedule validation,
 * occurrence math, first-sighting anchoring, missed-run recovery, the
 * launch path (fake spawner), busy deferral, and summary digests.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MissionScheduler } from '../src/scheduler/missionScheduler.js';
import { writeJsonAtomic } from '../src/state/statePersistence.js';
import { silentLogger } from '../src/infra/logger.js';

function harness({ schedules = [], heartbeat = null, notifications = null, buildSummary = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-sched-'));
  const schedulesFile = path.join(root, 'schedules.json');
  const stateFile = path.join(root, 'state.json');
  const heartbeatFile = path.join(root, 'heartbeat.json');
  if (schedules.length) writeJsonAtomic(schedulesFile, { schedules });
  if (heartbeat) writeJsonAtomic(heartbeatFile, heartbeat);

  const spawned = [];
  const scheduler = new MissionScheduler({
    schedulesFile, stateFile, heartbeatFile, rootDir: root,
    logger: silentLogger,
    spawnFn: (args) => spawned.push(args),
    notifications, buildSummary,
  });
  return { scheduler, spawned, stateFile, root };
}

test('validates schedules; broken entries are skipped and reported', () => {
  const { scheduler } = harness({
    schedules: [
      { id: 'good', project: 'p', type: 'daily', time: '02:00' },
      { id: 'bad-type', project: 'p', type: 'sometimes' },
      { id: 'bad-cron', project: 'p', type: 'cron', cron: 'not a cron' },
      { project: 'p', type: 'daily', time: '02:00' }, // missing id
      { id: 'good', project: 'p', type: 'daily', time: '03:00' }, // duplicate id
    ],
  });
  const { schedules, problems } = scheduler.loadSchedules();
  assert.deepEqual(schedules.map((s) => s.id), ['good']);
  assert.equal(problems.length, 4);
});

test('nextOccurrence: daily, weekly, once, cron', () => {
  const { scheduler } = harness();
  const after = new Date(2026, 6, 12, 10, 0); // Sunday

  assert.deepEqual(
    scheduler.nextOccurrence({ type: 'daily', time: '02:00' }, after),
    new Date(2026, 6, 13, 2, 0)
  );
  assert.deepEqual(
    scheduler.nextOccurrence({ type: 'daily', time: '18:30' }, after),
    new Date(2026, 6, 12, 18, 30)
  );
  assert.deepEqual(
    scheduler.nextOccurrence({ type: 'weekly', day: 'monday', time: '09:00' }, after),
    new Date(2026, 6, 13, 9, 0)
  );
  assert.deepEqual(
    scheduler.nextOccurrence({ type: 'once', date: '2026-08-01T05:00:00' }, after),
    new Date('2026-08-01T05:00:00')
  );
  assert.equal(scheduler.nextOccurrence({ type: 'once', date: '2026-01-01' }, after), null);
  assert.deepEqual(
    scheduler.nextOccurrence({ type: 'cron', cron: '0 */6 * * *' }, after),
    new Date(2026, 6, 12, 12, 0)
  );
});

test('first sighting anchors the schedule instead of firing immediately', () => {
  const { scheduler } = harness({
    schedules: [{ id: 's1', project: 'p', type: 'daily', time: '02:00' }],
  });
  // First check: the schedule was just seen; nothing is due yet.
  assert.deepEqual(scheduler.dueRuns(new Date(2026, 6, 12, 10, 0)), []);
  // The NEXT 02:00 after first sighting is due once reached.
  const due = scheduler.dueRuns(new Date(2026, 6, 13, 2, 1));
  assert.equal(due.length, 1);
  assert.equal(due[0].schedule.id, 's1');
});

test('missed occurrences are recovered by default, skipped with recoverMissed:false', () => {
  const past = new Date(2026, 6, 10, 2, 0).toISOString();
  const { scheduler, stateFile } = harness({
    schedules: [
      { id: 'recover', project: 'p', type: 'daily', time: '02:00' },
      { id: 'strict', project: 'p', type: 'daily', time: '02:00', recoverMissed: false },
    ],
  });
  // Both ran last on the 10th; the machine slept through the 11th & 12th.
  writeJsonAtomic(stateFile, {
    recover: { lastRunAt: past },
    strict: { lastRunAt: past },
  });

  const now = new Date(2026, 6, 12, 10, 0);
  const due = scheduler.dueRuns(now);
  // 'recover' is due (missed run recovered); 'strict' skipped forward.
  assert.deepEqual(due.map((d) => d.schedule.id), ['recover']);
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.strict.lastOutcome, 'missed-not-recovered');
});

test('runDue launches via the spawner and records the run', async () => {
  const { scheduler, spawned, stateFile } = harness({
    schedules: [{ id: 's1', project: 'the-proj', type: 'daily', time: '02:00', fresh: true }],
  });
  writeJsonAtomic(stateFile, { s1: { lastRunAt: new Date(2026, 6, 11, 2, 0).toISOString() } });

  const actions = await scheduler.runDue(new Date(2026, 6, 12, 2, 5));
  assert.deepEqual(actions, [{ id: 's1', project: 'the-proj', action: 'launched' }]);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].project, 'the-proj');
  assert.equal(spawned[0].fresh, true);
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.s1.lastOutcome, 'launched');
});

test('a live orchestrator defers launches (they stay due for the next tick)', async () => {
  const { scheduler, spawned } = harness({
    schedules: [{ id: 's1', project: 'p', type: 'daily', time: '02:00' }],
    heartbeat: { state: 'running', pid: process.pid }, // this test process is alive
  });
  const { stateFile } = scheduler;
  writeJsonAtomic(stateFile, { s1: { lastRunAt: new Date(2026, 6, 11, 2, 0).toISOString() } });

  const actions = await scheduler.runDue(new Date(2026, 6, 12, 2, 5));
  assert.deepEqual(actions.map((a) => a.action), ['deferred-already-running']);
  assert.equal(spawned.length, 0);
  // Still due next time (lastRunAt unchanged).
  assert.equal(scheduler.dueRuns(new Date(2026, 6, 12, 2, 6)).length, 1);
});

test('summary digests fire on their own schedule through the notification engine', async () => {
  const notified = [];
  const { scheduler, stateFile } = harness({
    notifications: { notify: async (event, payload) => notified.push({ event, payload }) },
    buildSummary: ({ sinceMs }) => `digest covering ${sinceMs}ms`,
  });
  scheduler.configureSummaries({ daily: { enabled: true, time: '20:00' } });

  // Anchor the digest, then cross 20:00.
  writeJsonAtomic(stateFile, {
    '__summary-daily': { lastRunAt: new Date(2026, 6, 11, 20, 0).toISOString() },
  });
  await scheduler.runDue(new Date(2026, 6, 12, 20, 1));
  assert.equal(notified.length, 1);
  assert.equal(notified[0].event, 'summary:daily');
  assert.match(notified[0].payload.text, /digest covering 86400000ms/);

  // Not due again immediately.
  await scheduler.runDue(new Date(2026, 6, 12, 20, 2));
  assert.equal(notified.length, 1);
});

test('add/remove/setEnabled manage the definitions file', () => {
  const { scheduler } = harness();
  assert.equal(scheduler.add({ id: 's1', project: 'p', type: 'daily', time: '04:00' }).ok, true);
  assert.equal(scheduler.add({ id: 's1', project: 'p', type: 'daily', time: '04:00' }).ok, false);
  assert.equal(scheduler.setEnabled('s1', false).ok, true);
  assert.equal(scheduler.loadSchedules().schedules[0].enabled, false);
  assert.equal(scheduler.remove('s1').ok, true);
  assert.equal(scheduler.remove('s1').ok, false);
});

test('report() merges definitions, run state, and next-due times', () => {
  const { scheduler, stateFile } = harness({
    schedules: [{ id: 's1', project: 'p', type: 'daily', time: '02:00' }],
  });
  writeJsonAtomic(stateFile, {
    s1: { lastRunAt: new Date(2026, 6, 12, 2, 0).toISOString(), lastOutcome: 'launched' },
  });
  const report = scheduler.report(new Date(2026, 6, 12, 10, 0));
  assert.equal(report.schedules[0].lastOutcome, 'launched');
  assert.deepEqual(new Date(report.schedules[0].nextDueAt), new Date(2026, 6, 13, 2, 0));
});
