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
import { NotificationEngine, dedupeKeyFor, EVENT_ATTACHMENT } from '../src/notifications/notificationEngine.js';
import { NotificationState } from '../src/notifications/notificationState.js';
import { silentLogger } from '../src/infra/logger.js';

/** A fake channel: records every send; `behavior` controls success/failure/messageId. */
function fakeChannel(name, behavior = {}) {
  const c = {
    name,
    minSeverity: behavior.minSeverity ?? null,
    sent: [],
    async send(payload) {
      this.sent.push(payload);
      if (behavior.fail) throw new Error(behavior.fail);
      return behavior.messageId ? { messageId: behavior.messageId } : undefined;
    },
  };
  // Only channels that actually support attachments (Telegram) get this —
  // omit `withDocuments` to simulate desktop/webhook/discord/email, which
  // never receive an attachment follow-up.
  if (behavior.withDocuments) {
    c.docsSent = [];
    c.sendDocument = async ({ filePath, caption }) => {
      c.docsSent.push({ filePath, caption });
      if (behavior.docFail) throw new Error(behavior.docFail);
      return { messageId: 'doc-1' };
    };
  }
  return c;
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

// ── Phase 11 M2 validation fix: never show a remote operator a raw path ────
// Found live: a phone operator has no use for "C:\Users\...\report.pdf" —
// they can't open a Windows path from Telegram. mission:blocked/
// release:created must say the report is attached/available, never print
// the path itself.

test('mission:blocked never prints the raw reportPath, and says it is available instead', async () => {
  const c = fakeChannel('fake');
  const { engine } = engineWith([c]);
  const reportPath = 'C:\\Users\\Admin\\Music\\AI-Orchestrator\\state\\diagnostics\\p-123.md';
  await engine.notify('mission:blocked', { project: 'p', reason: 'stuck', reportPath });
  assert.ok(!c.sent[0].message.includes(reportPath));
  assert.match(c.sent[0].message, /attached|workstation/i);
});

test('mission:blocked with no reportPath adds no report note at all', async () => {
  const c = fakeChannel('fake');
  const { engine } = engineWith([c]);
  await engine.notify('mission:blocked', { project: 'p', reason: 'stuck' });
  assert.ok(!/attached|workstation/i.test(c.sent[0].message));
});

test('release:created never prints the raw notesPath, and says it is available instead', async () => {
  const c = fakeChannel('fake');
  const { engine } = engineWith([c]);
  const notesPath = 'C:\\Users\\Admin\\Music\\AI-Orchestrator\\state\\releases\\p\\1.0.0\\notes.md';
  await engine.notify('release:created', { project: 'p', version: '1.0.0', notesPath });
  assert.ok(!c.sent[0].message.includes(notesPath));
  assert.match(c.sent[0].message, /attached|workstation/i);
});

test('a mission:blocked card also gets the report note appended, not the raw path', async () => {
  const c = fakeChannel('fake');
  const { engine } = engineWith([c]);
  const reportPath = 'C:\\Users\\Admin\\diagnostics\\p-1.md';
  await engine.notify('mission:blocked', {
    project: 'p', reason: 'stuck', reportPath,
    card: { project: 'p', status: 'blocked', reason: 'stuck' },
  });
  assert.ok(!c.sent[0].message.includes(reportPath));
  assert.match(c.sent[0].message, /attached|workstation/i);
});

// ── Phase 11 M2: approval-provider double-send prevention ─────────────────
// A confirmed real bug: with BOTH notifications.telegram.enabled and
// approvals.providers.telegram.enabled true (a common, even default-ish,
// setup), a single approval sent TWO nearly-identical Telegram messages —
// one from the approval provider's publish(), one from this channel.

test('a channel excludes an event listed in notify() via channel.excludeEvents', async () => {
  const excluded = fakeChannel('fake');
  excluded.excludeEvents = ['approval:required'];
  const included = fakeChannel('other');
  const { engine } = engineWith([excluded, included]);
  await engine.notify('approval:required', { project: 'p', request: { id: 'A1' } });
  assert.equal(excluded.sent.length, 0);
  assert.equal(included.sent.length, 1);
  await engine.notify('mission:complete', { project: 'p', summary: 'done' });
  assert.equal(excluded.sent.length, 1); // not excluded from THIS event
});

test('constructor auto-excludes approval events for a channel whose own provider is enabled', () => {
  const engine = new NotificationEngine({
    config: { telegram: { enabled: true, botToken: 't', chatId: '1' } },
    logger: silentLogger,
    approvalsConfig: { providers: { telegram: { enabled: true } } },
  });
  const telegram = engine.channels.find((c) => c.name === 'telegram');
  assert.ok(telegram);
  assert.deepEqual(new Set(telegram.excludeEvents), new Set([
    'approval:required', 'human-action:required',
  ]));
});

test('approval:resolved is NEVER auto-excluded — neither provider ever announces a resolution itself', () => {
  // Regression caught during Phase 11 M2 live validation: an earlier
  // version auto-excluded approval:resolved too, which silently killed the
  // ONLY notification an owner gets when a decision is made out-of-band
  // (CLI/API/desktop) while away from Telegram — the provider itself never
  // announces resolutions (it only has publish(), never a "decided" call).
  const telegramEngine = new NotificationEngine({
    config: { telegram: { enabled: true, botToken: 't', chatId: '1' } },
    logger: silentLogger,
    approvalsConfig: { providers: { telegram: { enabled: true } } },
  });
  assert.ok(!telegramEngine.channels.find((c) => c.name === 'telegram').excludeEvents.includes('approval:resolved'));

  const emailEngine = new NotificationEngine({
    config: { email: { enabled: true, smtp: { host: 'x' }, from: 'a@b.c', to: 'a@b.c' } },
    logger: silentLogger,
    approvalsConfig: { providers: { email: { enabled: true } } },
  });
  assert.ok(!emailEngine.channels.find((c) => c.name === 'email').excludeEvents.includes('approval:resolved'));
});

test('a resolution decided via the notification channel path still delivers, even with the provider enabled', async () => {
  const c = fakeChannel('telegram');
  c.excludeEvents = ['approval:required', 'human-action:required']; // what the real constructor would set
  const { engine } = engineWith([c], { withState: true });
  await engine.notify('approval:resolved', { project: 'p', request: { id: 'A1', status: 'approved' } });
  assert.equal(c.sent.length, 1);
});

test('no auto-exclusion when the matching approval provider is disabled', () => {
  const engine = new NotificationEngine({
    config: { telegram: { enabled: true, botToken: 't', chatId: '1' } },
    logger: silentLogger,
    approvalsConfig: { providers: { telegram: { enabled: false } } },
  });
  assert.deepEqual(engine.channels.find((c) => c.name === 'telegram').excludeEvents, []);
});

test('no auto-exclusion at all when approvalsConfig is omitted (notify test / notify resend)', () => {
  const engine = new NotificationEngine({
    config: { telegram: { enabled: true, botToken: 't', chatId: '1' } },
    logger: silentLogger,
    // approvalsConfig deliberately not passed.
  });
  assert.deepEqual(engine.channels.find((c) => c.name === 'telegram').excludeEvents, []);
});

test('auto-exclusion is per-channel-type: a desktop channel is never auto-excluded', () => {
  const engine = new NotificationEngine({
    config: { desktop: { enabled: true } },
    logger: silentLogger,
    approvalsConfig: { providers: { telegram: { enabled: true }, email: { enabled: true } } },
  });
  assert.deepEqual(engine.channels.find((c) => c.name === 'desktop').excludeEvents, []);
});

test('an explicit config excludeEvents merges with (does not replace) the auto-derived list', () => {
  const engine = new NotificationEngine({
    config: {
      telegram: { enabled: true, botToken: 't', chatId: '1', excludeEvents: ['mission:complete'] },
    },
    logger: silentLogger,
    approvalsConfig: { providers: { telegram: { enabled: true } } },
  });
  const excluded = new Set(engine.channels.find((c) => c.name === 'telegram').excludeEvents);
  assert.ok(excluded.has('mission:complete')); // explicit
  assert.ok(excluded.has('approval:required')); // auto-derived
  assert.equal(excluded.size, 3); // mission:complete + approval:required + human-action:required, no duplicates
});

// ── Phase 11 M2: real attachments for structured report paths ──────────────

function tmpReport(content = '# Diagnostic report\n...') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-report-'));
  const file = path.join(dir, 'report.md');
  fs.writeFileSync(file, content);
  return file;
}

test('EVENT_ATTACHMENT resolves the structured path per event, and nothing for others', () => {
  const reportPath = '/tmp/report.md';
  assert.equal(EVENT_ATTACHMENT['mission:blocked']({ reportPath }), reportPath);
  assert.equal(EVENT_ATTACHMENT['release:created']({ notesPath: reportPath }), reportPath);
  assert.equal(EVENT_ATTACHMENT['mission:blocked']({}), null);
  assert.equal(EVENT_ATTACHMENT['mission:complete'], undefined); // no mapping at all
});

test('mission:blocked with a real reportPath attaches the file on a channel that supports it', async () => {
  const c = fakeChannel('telegram', { withDocuments: true });
  const { engine } = engineWith([c]);
  const reportPath = tmpReport();
  await engine.notify('mission:blocked', { project: 'p', reason: 'stuck', reportPath });
  assert.equal(c.sent.length, 1); // text notification still sent
  assert.equal(c.docsSent.length, 1); // AND the real file attached
  assert.equal(c.docsSent[0].filePath, reportPath);
});

test('release:created attaches notesPath the same way', async () => {
  const c = fakeChannel('telegram', { withDocuments: true });
  const { engine } = engineWith([c]);
  const notesPath = tmpReport('# Release notes');
  await engine.notify('release:created', { project: 'p', version: '1.0.0', notesPath });
  assert.equal(c.docsSent.length, 1);
  assert.equal(c.docsSent[0].filePath, notesPath);
});

test('a channel without sendDocument (desktop/webhook/discord/email) never gets an attachment attempt', async () => {
  const c = fakeChannel('desktop'); // withDocuments not set
  const { engine } = engineWith([c]);
  await engine.notify('mission:blocked', { project: 'p', reason: 'stuck', reportPath: tmpReport() });
  assert.equal(c.sent.length, 1); // text still delivered, no crash from missing sendDocument
});

test('a reportPath that does not resolve to a real file is never attached', async () => {
  const c = fakeChannel('telegram', { withDocuments: true });
  const { engine } = engineWith([c]);
  await engine.notify('mission:blocked', { project: 'p', reason: 'stuck', reportPath: '/no/such/report.md' });
  assert.equal(c.docsSent.length, 0);
});

test('an event with no EVENT_ATTACHMENT mapping never attaches, even with a real path lying around in the payload', async () => {
  const c = fakeChannel('telegram', { withDocuments: true });
  const { engine } = engineWith([c]);
  await engine.notify('mission:complete', { project: 'p', summary: 'done', reportPath: tmpReport() });
  assert.equal(c.docsSent.length, 0);
});

test('a failed attachment delivery is swallowed — the text notification stays delivered', async () => {
  const c = fakeChannel('telegram', { withDocuments: true, docFail: 'network blip' });
  const { engine, notificationState } = engineWith([c], { withState: true });
  await engine.notify('mission:blocked', { project: 'p', reason: 'stuck', reportPath: tmpReport() });
  assert.equal(c.sent.length, 1);
  assert.equal(c.docsSent.length, 1); // attempted
  // mission:blocked has no stable dedupe key today, but if it did, "sent"
  // must reflect the successful TEXT delivery, not the failed attachment.
  assert.equal(dedupeKeyFor('mission:blocked', {}), null);
});

test('if the text send itself fails, the attachment is never attempted', async () => {
  const c = fakeChannel('telegram', { withDocuments: true, fail: 'text failed' });
  const { engine } = engineWith([c]);
  await engine.notify('mission:blocked', { project: 'p', reason: 'stuck', reportPath: tmpReport() });
  assert.equal(c.docsSent.length, 0);
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
