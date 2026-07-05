/**
 * Tests for the Mission Timeline — verifies it records the right high-signal
 * events from orchestrator emissions and filters out the noise.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { MissionTimeline } from '../src/state/missionTimeline.js';
import { silentLogger } from '../src/infra/logger.js';

function timeline() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-timeline-'));
  return new MissionTimeline({ timelineDir: dir, logger: silentLogger });
}

test('records mission start, progress, rate limit, and completion', () => {
  const t = timeline();
  const orch = new EventEmitter();
  t.attach(orch);

  orch.emit('session:launched', { project: 'p', resumed: false });
  orch.emit('session:progress', { project: 'p', progressed: true, confidence: 'high' });
  orch.emit('session:rate-limited', { project: 'p', resumeAt: new Date('2026-07-05T05:00:00Z') });
  orch.emit('session:resumed', { project: 'p', note: 'usage limit reset; resuming' });
  orch.emit('mission:complete', { project: 'p' });

  const entries = t.read('p');
  assert.deepEqual(
    entries.map((e) => e.event),
    ['mission-started', 'progress', 'rate-limit', 'resumed', 'complete']
  );
});

test('no-progress runs and routine resumes are filtered out (kept high-signal)', () => {
  const t = timeline();
  const orch = new EventEmitter();
  t.attach(orch);

  orch.emit('session:progress', { project: 'p', progressed: false, confidence: 'high' });
  orch.emit('session:resumed', { project: 'p', note: 'run finished; mission not complete — continuing' });
  orch.emit('session:launched', { project: 'p', resumed: true }); // not a mission start

  assert.equal(t.read('p').length, 0);
});

test('records blocked with its reason', () => {
  const t = timeline();
  const orch = new EventEmitter();
  t.attach(orch);

  orch.emit('mission:blocked', { project: 'p', reason: 'permission denied' });
  const entries = t.read('p');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].event, 'blocked');
  assert.match(entries[0].label, /permission denied/);
});

test('records task:done with the task id (Phase P2)', () => {
  const t = timeline();
  const orch = new EventEmitter();
  t.attach(orch);

  orch.emit('task:done', { project: 'p', taskId: 'T1' });
  const entries = t.read('p');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].event, 'task-done');
  assert.match(entries[0].label, /"T1"/);
});

test('timelines are isolated per project', () => {
  const t = timeline();
  const orch = new EventEmitter();
  t.attach(orch);
  orch.emit('mission:complete', { project: 'alpha' });
  orch.emit('mission:complete', { project: 'beta' });
  assert.equal(t.read('alpha').length, 1);
  assert.equal(t.read('beta').length, 1);
});
