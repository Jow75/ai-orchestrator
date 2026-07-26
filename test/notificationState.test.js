/**
 * Unit tests for notificationState.js (Phase 11 M2) — per-notification
 * idempotency: state/notifications/<project>.json, keyed by a caller
 * dedupe key. Covers the four allowed reasons to send again (never sent,
 * previous delivery failed, reminder interval elapsed, explicit resend)
 * and the fail-safe (no key / unconfigured ⇒ always send).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NotificationState } from '../src/notifications/notificationState.js';
import { silentLogger } from '../src/infra/logger.js';

function state() {
  const notificationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-notifstate-'));
  return new NotificationState({ notificationsDir, logger: silentLogger });
}

test('an unseen key always allows sending', () => {
  const s = state();
  assert.equal(s.shouldSend('proj', 'A1'), true);
});

test('a falsy key always allows sending, even with a store configured', () => {
  const s = state();
  assert.equal(s.shouldSend('proj', null), true);
  assert.equal(s.shouldSend('proj', undefined), true);
  assert.equal(s.shouldSend('proj', ''), true);
});

test('once recorded "sent", the same key is suppressed', () => {
  const s = state();
  s.recordSent('proj', 'A1', { status: 'sent' });
  assert.equal(s.shouldSend('proj', 'A1'), false);
});

test('a previously FAILED delivery always allows a retry', () => {
  const s = state();
  s.recordSent('proj', 'A1', { status: 'failed' });
  assert.equal(s.shouldSend('proj', 'A1'), true);
});

test('a reminder interval elapsing allows sending again', async () => {
  const s = state();
  s.recordSent('proj', 'A1', { status: 'sent' });
  assert.equal(s.shouldSend('proj', 'A1', { reminderMs: 10_000 }), false); // not yet due
  // Manually age the record past the interval instead of a real sleep.
  const record = s.load('proj');
  record.A1.lastReminder = new Date(Date.now() - 20_000).toISOString();
  s.save('proj', record);
  assert.equal(s.shouldSend('proj', 'A1', { reminderMs: 10_000 }), true);
});

test('reminderMs: 0 (default) never reminds automatically', () => {
  const s = state();
  s.recordSent('proj', 'A1', { status: 'sent' });
  const record = s.load('proj');
  record.A1.lastReminder = new Date(Date.now() - 999_999_999).toISOString(); // ancient
  s.save('proj', record);
  assert.equal(s.shouldSend('proj', 'A1', { reminderMs: 0 }), false);
});

test('forceResend clears the sent flag so the next call sends', () => {
  const s = state();
  s.recordSent('proj', 'A1', { status: 'sent' });
  assert.equal(s.shouldSend('proj', 'A1'), false);
  s.forceResend('proj', 'A1');
  assert.equal(s.shouldSend('proj', 'A1'), true);
});

test('forceResend on a key that was never sent is a harmless no-op', () => {
  const s = state();
  s.forceResend('proj', 'never-sent');
  assert.equal(s.shouldSend('proj', 'never-sent'), true);
});

test('recordSent keeps the original notificationTime but advances lastReminder', () => {
  const s = state();
  s.recordSent('proj', 'A1', { status: 'sent' });
  const first = s.load('proj').A1.notificationTime;
  s.forceResend('proj', 'A1');
  s.recordSent('proj', 'A1', { status: 'sent' });
  const second = s.load('proj');
  assert.equal(second.A1.notificationTime, first); // unchanged
  assert.ok(second.A1.lastReminder); // present (may equal or postdate first send)
});

test('channel message ids are recorded and preserved across an update that omits them', () => {
  const s = state();
  s.recordSent('proj', 'A1', { status: 'sent', channelIds: { telegram: '555', email: 'msg-1' } });
  let record = s.load('proj').A1;
  assert.equal(record.telegramMessageId, '555');
  assert.equal(record.emailMessageId, 'msg-1');

  s.forceResend('proj', 'A1');
  s.recordSent('proj', 'A1', { status: 'sent' }); // no channelIds this time
  record = s.load('proj').A1;
  assert.equal(record.telegramMessageId, '555'); // preserved, not clobbered to null
  assert.equal(record.emailMessageId, 'msg-1');
});

test('keys are isolated per project', () => {
  const s = state();
  s.recordSent('proj-a', 'A1', { status: 'sent' });
  assert.equal(s.shouldSend('proj-a', 'A1'), false);
  assert.equal(s.shouldSend('proj-b', 'A1'), true); // different project, same key
});

test('unconfigured store (no notificationsDir) is a safe pass-through', () => {
  const s = new NotificationState({ logger: silentLogger });
  assert.equal(s.shouldSend('proj', 'A1'), true);
  s.recordSent('proj', 'A1', { status: 'sent' }); // must not throw
  assert.equal(s.shouldSend('proj', 'A1'), true); // still true — nothing was persisted
  s.forceResend('proj', 'A1'); // must not throw
});
