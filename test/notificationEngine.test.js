/**
 * Unit tests for notificationEngine.js — severity filtering (Phase 10F,
 * previously untested at the unit level) plus the Phase 11 M2 idempotency
 * wiring (dedupeKeyFor + notificationState integration).
 *
 * The constructor builds real channel classes from config (desktop pops an
 * actual OS toast via node-notifier) — undesirable in a test. Every test
 * here constructs the engine with NO channels enabled via config, then
 * pushes fake channel objects directly onto `engine.channels` (a plain
 * array property `notify()` only ever reads) instead.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { NotificationEngine, dedupeKeyFor } from '../src/notifications/notificationEngine.js';
import { NotificationState } from '../src/notifications/notificationState.js';
import { silentLogger } from '../src/infra/logger.js';

/** A fake channel: records every send; `behavior` controls success/failure/messageId. */
function fakeChannel(name, behavior = {}) {
  return {
    name,
    minSeverity: behavior.minSeverity ?? null,
    sent: [],
    async send(payload) {
      this.sent.push(payload);
      if (behavior.fail) throw new Error(behavior.fail);
      return behavior.messageId ? { messageId: behavior.messageId } : undefined;
    },
  };
}

function engineWith(channels, { config = {}, withState = false } = {}) {
  const notificationsDir = withState ? fs.mkdtempSync(path.join(os.tmpdir(), 'aio-engstate-')) : undefined;
  const notificationState = withState ? new NotificationState({ notificationsDir, logger: silentLogger }) : null;
  const engine = new NotificationEngine({
    config: { events: [], ...config }, logger: silentLogger, notificationState,
  });
  engine.channels = channels; // bypass config-driven construction (see file header)
  return { engine, notificationState };
}

test('dedupeKeyFor: approval/human-action requests use the request id; other events have none', () => {
  const request = { id: 'A7' };
  assert.equal(dedupeKeyFor('approval:required', { request }), 'A7');
  assert.equal(dedupeKeyFor('human-action:required', { request }), 'A7');
  assert.equal(dedupeKeyFor('approval:resolved', { request }), 'A7:resolved');
  assert.equal(dedupeKeyFor('mission:complete', { request }), null);
  assert.equal(dedupeKeyFor('session:crashed', {}), null);
  assert.equal(dedupeKeyFor('approval:required', {}), null); // no request on the payload
});

test('without a notificationState, every notify() call sends (pre-M2 behaviour preserved)', async () => {
  const c = fakeChannel('fake');
  const { engine } = engineWith([c]); // withState: false
  const request = { id: 'A1' };
  await engine.notify('approval:required', { project: 'p', request });
  await engine.notify('approval:required', { project: 'p', request });
  assert.equal(c.sent.length, 2); // no dedup without a store
});

test('a second approval:required for the SAME request id is suppressed', async () => {
  const c = fakeChannel('fake');
  const { engine } = engineWith([c], { withState: true });
  const request = { id: 'A1' };
  await engine.notify('approval:required', { project: 'p', request });
  await engine.notify('approval:required', { project: 'p', request }); // same id — a poll noticing it still exists
  assert.equal(c.sent.length, 1);
});

test('a DIFFERENT request id still gets its own notification', async () => {
  const c = fakeChannel('fake');
  const { engine } = engineWith([c], { withState: true });
  await engine.notify('approval:required', { project: 'p', request: { id: 'A1' } });
  await engine.notify('approval:required', { project: 'p', request: { id: 'A2' } });
  assert.equal(c.sent.length, 2);
});

test('approval:resolved for the same id still sends — a real state change, not a duplicate', async () => {
  const c = fakeChannel('fake');
  const { engine } = engineWith([c], { withState: true });
  const request = { id: 'A1', status: 'pending' };
  await engine.notify('approval:required', { project: 'p', request });
  request.status = 'approved';
  await engine.notify('approval:resolved', { project: 'p', request });
  assert.equal(c.sent.length, 2); // required + resolved are different dedupe keys
});

test('events with no stable identity are never deduped', async () => {
  const c = fakeChannel('fake');
  const { engine } = engineWith([c], { withState: true });
  await engine.notify('session:crashed', { project: 'p', consecutiveCrashes: 1, restartInMs: 100 });
  await engine.notify('session:crashed', { project: 'p', consecutiveCrashes: 2, restartInMs: 200 });
  assert.equal(c.sent.length, 2); // each crash is genuinely distinct
});

test('a channel failure records "failed"; the next call for the same id retries', async () => {
  const c = fakeChannel('fake', { fail: 'boom' });
  const { engine } = engineWith([c], { withState: true });
  const request = { id: 'A1' };
  await engine.notify('approval:required', { project: 'p', request }); // fails
  await engine.notify('approval:required', { project: 'p', request }); // retried, not suppressed
  assert.equal(c.sent.length, 2);
});

test('once ANY channel succeeds, status is "sent" even if another channel failed', async () => {
  const ok = fakeChannel('ok');
  const bad = fakeChannel('bad', { fail: 'boom' });
  const { engine, notificationState } = engineWith([ok, bad], { withState: true });
  const request = { id: 'A1' };
  await engine.notify('approval:required', { project: 'p', request });
  await engine.notify('approval:required', { project: 'p', request }); // must be suppressed now
  assert.equal(ok.sent.length, 1);
  assert.equal(bad.sent.length, 1);
  const record = notificationState.load('p').A1;
  assert.equal(record.status, 'sent');
});

test('per-channel message ids are captured into the notification state', async () => {
  const c = fakeChannel('telegram', { messageId: '999' });
  const { engine, notificationState } = engineWith([c], { withState: true });
  const request = { id: 'A1' };
  await engine.notify('approval:required', { project: 'p', request });
  const record = notificationState.load('p').A1;
  assert.equal(record.telegramMessageId, '999');
});

test('notify resend flow: forceResend then notify() bypasses the dedup', async () => {
  const c = fakeChannel('fake');
  const { engine, notificationState } = engineWith([c], { withState: true });
  const request = { id: 'A1' };
  await engine.notify('approval:required', { project: 'p', request });
  await engine.notify('approval:required', { project: 'p', request }); // suppressed
  assert.equal(c.sent.length, 1);

  notificationState.forceResend('p', 'A1'); // operator ran `notify resend`
  await engine.notify('approval:required', { project: 'p', request });
  assert.equal(c.sent.length, 2);
});

// ── Phase 10F severity filtering (previously untested at the unit level) ──

test('global minSeverity filters out lower-severity events entirely', async () => {
  const c = fakeChannel('fake');
  const { engine } = engineWith([c], { config: { minSeverity: 'critical' } });
  await engine.notify('task:done', { project: 'p', taskId: 'T1' }); // 'info'
  assert.equal(c.sent.length, 0);
  await engine.notify('mission:blocked', { project: 'p', reason: 'x' }); // 'critical'
  assert.equal(c.sent.length, 1);
});

test('a channel with its own minSeverity only receives events at or above it', async () => {
  const chatty = fakeChannel('chatty'); // no floor
  const picky = fakeChannel('picky', { minSeverity: 'critical' });
  const { engine } = engineWith([chatty, picky]);
  await engine.notify('task:done', { project: 'p', taskId: 'T1' }); // 'info'
  assert.equal(chatty.sent.length, 1);
  assert.equal(picky.sent.length, 0);
  await engine.notify('mission:blocked', { project: 'p', reason: 'x' }); // 'critical'
  assert.equal(chatty.sent.length, 2);
  assert.equal(picky.sent.length, 1);
});

test('attach() only forwards events present in config.events', () => {
  const emitter = new EventEmitter();
  const c = fakeChannel('fake');
  const { engine } = engineWith([c], { config: { events: ['mission:complete'] } });
  const notified = [];
  engine.notify = async (event) => { notified.push(event); };
  engine.attach(emitter);
  emitter.emit('mission:complete', { project: 'p', summary: 'done' });
  emitter.emit('session:crashed', { project: 'p' }); // NOT subscribed
  assert.deepEqual(notified, ['mission:complete']);
});
