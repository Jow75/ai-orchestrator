/**
 * Tests for the Telegram/email onboarding wizards (Phase 11C/11D). All
 * network is faked, so these run offline and fast. They assert the wizards
 * discover the chat id, translate SMTP errors, and write exactly the
 * config/local.json blocks the app's provider wiring expects.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigManager } from '../src/config/configManager.js';
import { createPrompter } from '../src/onboarding/prompts.js';
import { runTelegramSetup, runEmailSetup, runNotifyTune } from '../src/onboarding/notifyWizard.js';
import { COMMANDS } from '../src/operator/commandGrammar.js';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aio-notify-'));
}

/** Prompter over a scripted answer queue + captured output. */
function harness(root, answers) {
  const queue = [...answers];
  const out = [];
  const prompter = createPrompter({
    ask: async () => {
      if (!queue.length) throw new Error('wizard asked for more input than supplied');
      return queue.shift();
    },
    output: { write: (s) => out.push(s) },
  });
  return { prompter, out: () => out.join(''), configManager: new ConfigManager({ rootDir: root }) };
}

/**
 * A fake Telegram API: per-method queues of response bodies.
 *
 * `sent` records every call so a test can assert on WHAT was published, not
 * merely that the wizard survived — the M2.2 command menu is a payload whose
 * contents matter (chat scope, the real grammar).
 */
function fakeTelegram(map) {
  const queues = {};
  for (const k of Object.keys(map)) queues[k] = [...map[k]];
  const sent = [];
  const fetchFn = async (url, options) => {
    const method = ['getMe', 'getUpdates', 'sendMessage', 'setMyCommands']
      .find((m) => url.includes(`/${m}`)) ?? 'unknown';
    sent.push({ method, body: options?.body ? JSON.parse(options.body) : null });
    const queue = queues[method] ?? [];
    const body = queue.length > 1 ? queue.shift() : (queue[0] ?? { ok: true, result: {} });
    return { ok: body.ok !== false, status: body.status ?? 200, json: async () => body };
  };
  fetchFn.sent = sent;
  return fetchFn;
}

function localConfig(root) {
  const file = path.join(root, 'config', 'local.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

const immediate = async () => {};

test('telegram: validates token, discovers chat id, writes local.json', async () => {
  const root = tmpRoot();
  const { prompter, configManager } = harness(root, ['123:ABC', '']);
  const fetchFn = fakeTelegram({
    getMe: [{ ok: true, result: { username: 'jowgei_bot' } }],
    getUpdates: [{ ok: true, result: [{ message: { chat: { id: 1234567890 } } }] }],
    sendMessage: [{ ok: true, result: {} }],
  });
  const result = await runTelegramSetup({ configManager, prompter, fetchFn, sleepFn: immediate, pollAttempts: 3 });
  assert.equal(result.chatId, '1234567890');

  const cfg = localConfig(root);
  assert.deepEqual(cfg.notifications.telegram, { enabled: true, botToken: '123:ABC', chatId: '1234567890' });
  assert.equal(cfg.approvals.providers.telegram.enabled, true);
});

test('telegram: setup publishes the command menu, scoped to the discovered chat', async () => {
  // Phase 12 M2.2. Setup is the one moment the token is known to work and the
  // chat id is known to be right — the cheapest place to give the owner a menu
  // instead of a grammar to memorize.
  const root = tmpRoot();
  const { prompter, configManager } = harness(root, ['123:ABC', '']);
  const fetchFn = fakeTelegram({
    getMe: [{ ok: true, result: { username: 'jowgei_bot' } }],
    getUpdates: [{ ok: true, result: [{ message: { chat: { id: 1234567890 } } }] }],
    sendMessage: [{ ok: true, result: {} }],
    setMyCommands: [{ ok: true, result: true }],
  });

  const result = await runTelegramSetup({ configManager, prompter, fetchFn, sleepFn: immediate, pollAttempts: 3 });

  assert.equal(result.commandsRegistered, true);
  const call = fetchFn.sent.find((c) => c.method === 'setMyCommands');
  assert.ok(call, 'the menu must be published during setup, not left for the owner to discover');
  assert.deepEqual(call.body.scope, { type: 'chat', chat_id: 1234567890 },
    'scoped to the owner — the only chat the provider will honour');
  assert.deepEqual(
    call.body.commands.map((c) => c.command).sort(),
    COMMANDS.map((c) => c.name).sort(),
    'the published menu is the real grammar, not a copy of it'
  );
});

test('telegram: a refused command menu does not fail the setup', async () => {
  const root = tmpRoot();
  const { prompter, configManager, out } = harness(root, ['123:ABC', '']);
  const fetchFn = fakeTelegram({
    getMe: [{ ok: true, result: { username: 'bot' } }],
    getUpdates: [{ ok: true, result: [{ message: { chat: { id: 7 } } }] }],
    sendMessage: [{ ok: true, result: {} }],
    setMyCommands: [{ ok: false, description: 'BAD_REQUEST: too many commands' }],
  });

  const result = await runTelegramSetup({ configManager, prompter, fetchFn, sleepFn: immediate, pollAttempts: 3 });

  assert.equal(result.chatId, '7', 'the channel is configured either way — a menu is a convenience');
  assert.equal(result.commandsRegistered, false);
  assert.match(out(), /too many commands/);
  assert.match(out(), /notify commands/, 'and the owner is told how to retry it');
  assert.equal(localConfig(root).approvals.providers.telegram.enabled, true);
});

test('telegram: rejects a bad token then accepts a good one', async () => {
  const root = tmpRoot();
  const { prompter, out, configManager } = harness(root, ['bad', 'y', 'good', '']);
  const fetchFn = fakeTelegram({
    getMe: [{ ok: false, description: 'Unauthorized' }, { ok: true, result: { username: 'bot' } }],
    getUpdates: [{ ok: true, result: [{ message: { chat: { id: 42 } } }] }],
    sendMessage: [{ ok: true, result: {} }],
  });
  const result = await runTelegramSetup({ configManager, prompter, fetchFn, sleepFn: immediate, pollAttempts: 3 });
  assert.equal(result.chatId, '42');
  assert.equal(result.botToken, 'good');
  assert.match(out(), /Unauthorized/);
});

test('telegram: gives up cleanly when no message arrives (no config written)', async () => {
  const root = tmpRoot();
  const { prompter, out, configManager } = harness(root, ['tok', '']);
  const fetchFn = fakeTelegram({
    getMe: [{ ok: true, result: { username: 'bot' } }],
    getUpdates: [{ ok: true, result: [] }],
  });
  const result = await runTelegramSetup({ configManager, prompter, fetchFn, sleepFn: immediate, pollAttempts: 2 });
  assert.equal(result, null);
  assert.equal(localConfig(root), null); // nothing persisted
  assert.match(out(), /No message detected/);
});

test('telegram: detects an active webhook and explains the fix', async () => {
  const root = tmpRoot();
  const { prompter, out, configManager } = harness(root, ['tok', '']);
  const fetchFn = fakeTelegram({
    getMe: [{ ok: true, result: { username: 'bot' } }],
    getUpdates: [{ ok: false, description: "Conflict: can't use getUpdates while webhook is active" }],
  });
  const result = await runTelegramSetup({ configManager, prompter, fetchFn, sleepFn: immediate, pollAttempts: 2 });
  assert.equal(result, null);
  assert.match(out(), /deleteWebhook/);
});

test('email: gmail happy path writes local.json with STARTTLS on 587', async () => {
  const root = tmpRoot();
  const { prompter, configManager } = harness(root, [
    'gmail', 'me@gmail.com', 'apppassword16ch', '', '',
  ]);
  const sent = [];
  const result = await runEmailSetup({ configManager, prompter, sendMailFn: async (m) => { sent.push(m); } });
  assert.ok(result);
  assert.equal(sent.length, 1);
  const cfg = localConfig(root);
  assert.deepEqual(cfg.notifications.email.smtp, {
    host: 'smtp.gmail.com', port: 587, secure: false, starttls: true, user: 'me@gmail.com', pass: 'apppassword16ch',
  });
  assert.equal(cfg.notifications.email.from, 'me@gmail.com'); // defaulted to user
  assert.equal(cfg.notifications.email.to, 'me@gmail.com');
  assert.equal(cfg.approvals.providers.email.enabled, true);
});

test('email: an auth failure surfaces the App Password remedy, saves if confirmed', async () => {
  const root = tmpRoot();
  const { prompter, out, configManager } = harness(root, [
    'gmail', 'me@gmail.com', 'wrongpass', '', '', 'y',
  ]);
  const result = await runEmailSetup({
    configManager, prompter,
    sendMailFn: async () => { throw new Error('535 Username and Password not accepted'); },
  });
  assert.ok(result); // saved anyway
  assert.match(out(), /App Password/);
  assert.equal(localConfig(root).notifications.email.enabled, true);
});

test('email: an auth failure not confirmed writes nothing', async () => {
  const root = tmpRoot();
  const { prompter, configManager } = harness(root, [
    'gmail', 'me@gmail.com', 'wrongpass', '', '', 'n',
  ]);
  const result = await runEmailSetup({
    configManager, prompter,
    sendMailFn: async () => { throw new Error('535 auth failed'); },
  });
  assert.equal(result, null);
  assert.equal(localConfig(root), null);
});

test('email: other-provider path captures host/port/implicit-TLS', async () => {
  const root = tmpRoot();
  const { prompter, configManager } = harness(root, [
    'other', 'mail.example.com', '465', 'y', 'user@example.com', 'secret', 'from@example.com', 'to@example.com',
  ]);
  const result = await runEmailSetup({ configManager, prompter, sendMailFn: async () => {} });
  assert.ok(result);
  const smtp = localConfig(root).notifications.email.smtp;
  assert.equal(smtp.host, 'mail.example.com');
  assert.equal(smtp.port, 465);
  assert.equal(smtp.secure, true);
  assert.equal(smtp.starttls, false);
});

// ── notify tune (Phase 11 M4) ──────────────────────────────────────────────

test('notify tune: no channel enabled → says so, writes nothing', async () => {
  const root = tmpRoot();
  const { prompter, out, configManager } = harness(root, []);
  // Desktop notifications are enabled by default — disable it too so this
  // genuinely exercises the "nothing to tune" branch.
  configManager.writeLocalConfig({ notifications: { desktop: { enabled: false } } });
  configManager.load(); // global config is cached after the write above reads it once
  const result = await runNotifyTune({ configManager, prompter });
  assert.equal(result, null);
  assert.match(out(), /notify setup telegram\|email/);
});

test('notify tune: sets a channel\'s minSeverity, preserving its other fields', async () => {
  const root = tmpRoot();
  const { prompter, configManager } = harness(root, ['telegram', 'critical']);
  configManager.writeLocalConfig({
    notifications: { telegram: { enabled: true, botToken: 'tok', chatId: '1' } },
  });
  configManager.load();
  const result = await runNotifyTune({ configManager, prompter });
  assert.deepEqual(result, { channel: 'telegram', minSeverity: 'critical', file: result.file });

  const cfg = localConfig(root);
  assert.deepEqual(cfg.notifications.telegram, {
    enabled: true, botToken: 'tok', chatId: '1', minSeverity: 'critical',
  });
});

test('notify tune: only offers enabled channels', async () => {
  const root = tmpRoot();
  const { prompter, out, configManager } = harness(root, ['email', 'warning']);
  configManager.writeLocalConfig({
    notifications: {
      telegram: { enabled: false },
      email: { enabled: true, smtp: { host: 'smtp.example.com' }, from: 'a@b.com', to: 'a@b.com' },
    },
  });
  configManager.load();
  const result = await runNotifyTune({ configManager, prompter });
  assert.equal(result.channel, 'email');
  assert.match(out(), /Which channel\?/);
  assert.ok(!out().includes('telegram'));
});

test('notify tune: Enter accepts the channel\'s current severity as the default', async () => {
  const root = tmpRoot();
  // Empty string ('') at the severity prompt = press Enter, accept the default.
  const { prompter, configManager } = harness(root, ['telegram', '']);
  configManager.writeLocalConfig({
    notifications: { telegram: { enabled: true, botToken: 't', chatId: '1', minSeverity: 'warning' } },
  });
  configManager.load();
  const result = await runNotifyTune({ configManager, prompter });
  assert.equal(result.minSeverity, 'warning');
});
