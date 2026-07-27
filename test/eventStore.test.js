/**
 * Unit tests for events/eventStore.js — Phase 12 M2.
 *
 * The event log is the spine the whole milestone rests on: every interface is
 * meant to read it rather than participate in mission logic. So the properties
 * pinned here are the ones an interface actually depends on — that the
 * sequence is monotonic ACROSS RESTARTS (a client tailing with `sinceSeq` must
 * never see a number twice), that a torn line costs one event and not the
 * history, and that a misspelled type never enters the permanent record.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import EventStore, { LOG_FILENAME } from '../src/events/eventStore.js';
import { EVENT_TYPES, isKnownEventType, approvalEventFor, missionEventFor } from '../src/events/eventTypes.js';
import { silentLogger } from '../src/infra/logger.js';

function store(options = {}) {
  const eventsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-events-'));
  return { eventsDir, store: new EventStore({ eventsDir, logger: silentLogger, ...options }) };
}

test('an appended event carries a sequence, a timestamp, and what was given', () => {
  const { store: s } = store();
  const event = s.append({
    type: 'mission.created', project: 'finisher', actor: 'telegram:owner',
    payload: { id: 'M1' },
  });

  assert.equal(event.seq, 1);
  assert.equal(event.type, 'mission.created');
  assert.equal(event.project, 'finisher');
  assert.equal(event.actor, 'telegram:owner');
  assert.deepEqual(event.payload, { id: 'M1' });
  assert.ok(Date.parse(event.at) > 0);
});

test('sequence numbers are monotonic and survive a restart', () => {
  const { eventsDir, store: first } = store();
  first.append({ type: 'daemon.started' });
  first.append({ type: 'worker.started', project: 'a' });
  assert.equal(first.latestSeq(), 2);

  // A new process (a restarted service) must continue the sequence, not
  // replay numbers a client has already consumed.
  const second = new EventStore({ eventsDir, logger: silentLogger });
  const next = second.append({ type: 'worker.completed', project: 'a' });

  assert.equal(next.seq, 3);
  assert.equal(second.read().length, 3);
});

test('an unknown event type is refused, not silently written', () => {
  const { store: s } = store();
  const result = s.append({ type: 'mission.exploded', project: 'a' });

  assert.equal(result, null, 'nothing was written');
  assert.equal(s.read().length, 0);
  assert.equal(isKnownEventType('mission.exploded'), false);
});

test('a torn final line costs one event, never the history', () => {
  const { eventsDir, store: s } = store();
  s.append({ type: 'daemon.started' });
  s.append({ type: 'worker.started', project: 'a' });
  // Simulate a crash mid-append.
  fs.appendFileSync(path.join(eventsDir, LOG_FILENAME), '{"seq":3,"type":"worker.comp');

  const events = s.read();

  assert.equal(events.length, 2, 'both intact events survive');
  assert.equal(events[1].type, 'worker.started');
});

test('read filters by project, type, and sequence', () => {
  const { store: s } = store();
  s.append({ type: 'worker.started', project: 'alpha' });
  s.append({ type: 'worker.started', project: 'beta' });
  s.append({ type: 'mission.progress', project: 'alpha' });

  assert.equal(s.read({ project: 'alpha' }).length, 2);
  assert.equal(s.read({ types: ['worker.started'] }).length, 2);
  assert.equal(s.read({ project: 'alpha', types: ['mission.progress'] }).length, 1);
  assert.equal(s.read({ sinceSeq: 2 }).length, 1, 'sinceSeq is exclusive — how a client tails');
});

test('read caps at the most recent N', () => {
  const { store: s } = store();
  for (let i = 0; i < 10; i += 1) s.append({ type: 'mission.progress', project: 'a' });

  const recent = s.read({ limit: 3 });

  assert.equal(recent.length, 3);
  assert.deepEqual(recent.map((e) => e.seq), [8, 9, 10], 'the LAST three, oldest first');
});

test('subscribers see events as they are appended, and a throwing one is contained', () => {
  const { store: s } = store();
  const seen = [];
  s.subscribe(() => { throw new Error('this listener is broken'); });
  const unsubscribe = s.subscribe((event) => seen.push(event.type));

  s.append({ type: 'daemon.started' });
  unsubscribe();
  s.append({ type: 'daemon.stopped' });

  assert.deepEqual(seen, ['daemon.started'], 'a broken listener never blocks the others or the write');
  assert.equal(s.read().length, 2, 'and both events were still written');
});

test('the log rotates once it passes maxBytes, and keeps serving the live file', () => {
  const { eventsDir, store: s } = store({ maxBytes: 400 });
  for (let i = 0; i < 20; i += 1) {
    s.append({ type: 'mission.progress', project: 'alpha', payload: { i, pad: 'x'.repeat(40) } });
  }

  const archives = fs.readdirSync(eventsDir).filter((f) => f.startsWith('events-'));
  assert.ok(archives.length >= 1, 'at least one archive was cut');
  assert.ok(fs.existsSync(path.join(eventsDir, LOG_FILENAME)), 'the live log still exists');
  assert.ok(s.read().length >= 1, 'and still answers');
});

test('with no eventsDir every method is a safe no-op', () => {
  const s = new EventStore({ logger: silentLogger });

  assert.equal(s.append({ type: 'daemon.started' }), null);
  assert.deepEqual(s.read(), []);
  assert.deepEqual(s.recent(5), []);
  assert.equal(s.latestSeq(), 0);
});

test('decision and lifecycle mappings only produce types the store accepts', () => {
  for (const decision of ['approved', 'rejected', 'modified', 'done', 'expired']) {
    const type = approvalEventFor(decision);
    assert.ok(EVENT_TYPES.includes(type), `${decision} → ${type} is a real event type`);
  }
  for (const state of ['completed', 'blocked', 'cancelled', 'failed']) {
    assert.ok(EVENT_TYPES.includes(missionEventFor(state)));
  }
  assert.equal(approvalEventFor('pending'), null, 'no event is invented for a non-decision');
  assert.equal(missionEventFor('executing'), null);
});
