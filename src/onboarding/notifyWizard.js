/**
 * onboarding/notifyWizard.js — Phase 11C/11D: remote-channel setup wizards.
 *
 * These automate the manual setup guides that Phase 10.5 walked by hand:
 *
 *   - Telegram: validate the BotFather token via getMe, DISCOVER the chat id
 *     by polling getUpdates (the fiddly step 10.5 did manually), send a live
 *     test, and write notifications.telegram + approvals.providers.telegram.
 *   - Email: collect SMTP settings (Gmail app-password path spelled out),
 *     send a REAL test email through the built-in smtpClient, and write
 *     notifications.email + approvals.providers.email.
 *
 * Both only ever write config/local.json (git-ignored) via
 * ConfigManager.writeLocalConfig — the same config an expert edits by hand.
 * Every network call is injectable so the flows are unit-tested offline.
 */

import { EmailChannel } from '../notifications/channels/email.js';
import { silentLogger } from '../infra/logger.js';
import { severityLabel } from '../shared/vocabulary.js';

/** Channels `notify tune` can set a per-channel `minSeverity` for. */
const TUNABLE_CHANNELS = ['desktop', 'webhook', 'discord', 'telegram', 'email'];
const SEVERITIES = ['info', 'warning', 'critical'];

/** Abort a hung Telegram call after this long. */
const TELEGRAM_TIMEOUT_MS = 15_000;

/** Call the Telegram Bot API, returning {ok, result} or {ok:false, error}. */
async function telegramCall(fetchFn, token, method, params, timeoutMs = TELEGRAM_TIMEOUT_MS) {
  const base = `https://api.telegram.org/bot${token}/${method}`;
  const isGet = method === 'getUpdates';
  const url = isGet && params ? `${base}?${new URLSearchParams(params)}` : base;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const options = isGet
      ? { method: 'GET', signal: controller.signal }
      : {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params ?? {}),
        signal: controller.signal,
      };
    const res = await fetchFn(url, options);
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) {
      return { ok: false, error: body.description ?? `HTTP ${res.status}` };
    }
    return { ok: true, result: body.result };
  } catch (error) {
    return { ok: false, error: error.name === 'AbortError' ? 'request timed out' : error.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Pick the most recent chat id out of a getUpdates result array. */
function chatIdFromUpdates(updates) {
  for (const update of [...(updates ?? [])].reverse()) {
    const message = update.message ?? update.edited_message;
    const id = message?.chat?.id;
    if (id !== undefined && id !== null) return String(id);
  }
  return null;
}

/**
 * Telegram onboarding wizard.
 *
 * @param {object} params
 * @param {import('../config/configManager.js').ConfigManager} params.configManager
 * @param {import('./prompts.js').Prompter} params.prompter
 * @param {typeof fetch} [params.fetchFn] - Injectable fetch (tests).
 * @param {number} [params.pollAttempts] - getUpdates tries before giving up.
 * @param {number} [params.pollDelayMs] - Wait between polls.
 * @param {(ms:number)=>Promise<void>} [params.sleepFn] - Injectable sleep.
 * @returns {Promise<{botToken:string, chatId:string, file:string}|null>}
 */
export async function runTelegramSetup({
  configManager, prompter, fetchFn = globalThis.fetch,
  pollAttempts = 20, pollDelayMs = 3_000, sleepFn,
}) {
  const p = prompter;
  const sleep = sleepFn ?? ((ms) => new Promise((r) => { setTimeout(r, ms); }));

  p.say('\n── Telegram setup ─────────────────────────────────────────');
  p.say('1. In Telegram, open a chat with @BotFather.');
  p.say('2. Send /newbot and follow the prompts to name your bot.');
  p.say('3. BotFather replies with a token like 123456789:AA...  — paste it below.');

  // Token + live validation (validate needs a network call, so loop here).
  let botToken;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    botToken = await p.secret('Bot token');
    // eslint-disable-next-line no-await-in-loop
    const me = await telegramCall(fetchFn, botToken, 'getMe');
    if (me.ok) {
      p.say(`  ✔ Verified bot @${me.result?.username ?? 'unknown'}`);
      break;
    }
    p.say(`  ✘ ${me.error} — check the token and try again.`);
    // eslint-disable-next-line no-await-in-loop
    if (!await p.confirm('Try a different token?', { default: true })) return null;
  }

  // Chat-id discovery by polling getUpdates (automates the 10.5 hand-step).
  p.say('\nNow open a chat with your new bot and send it any message (e.g. "hi").');
  await p.text('Press Enter once you have messaged the bot', { default: '', allowEmpty: true });

  let chatId = null;
  for (let attempt = 1; attempt <= pollAttempts && !chatId; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const updates = await telegramCall(fetchFn, botToken, 'getUpdates', { timeout: '0' });
    if (updates.ok) {
      chatId = chatIdFromUpdates(updates.result);
    } else if (/webhook/i.test(updates.error ?? '')) {
      p.say('  ✘ A webhook is set on this bot; getUpdates is unavailable.');
      p.say(`     Clear it once: curl "https://api.telegram.org/bot<token>/deleteWebhook"`);
      return null;
    }
    if (!chatId) {
      p.say(`  …waiting for your message (${attempt}/${pollAttempts})`);
      // eslint-disable-next-line no-await-in-loop
      if (attempt < pollAttempts) await sleep(pollDelayMs);
    }
  }
  if (!chatId) {
    p.say('  ✘ No message detected. Make sure you pressed Start / sent a message, then re-run.');
    return null;
  }
  p.say(`  ✔ Found your chat id: ${chatId}`);

  // Live test send.
  const test = await telegramCall(fetchFn, botToken, 'sendMessage', {
    chat_id: chatId,
    text: '✅ AI-Orchestrator is connected to Telegram.',
  });
  p.say(test.ok ? '  ✔ Test message sent — check Telegram.' : `  ✘ Test send failed: ${test.error}`);

  const file = configManager.writeLocalConfig({
    notifications: { telegram: { enabled: true, botToken, chatId } },
    approvals: { providers: { telegram: { enabled: true } } },
  });
  p.say(`\n✅ Telegram configured and saved to ${file}`);
  p.say('   Your phone will now receive approvals; reply APPROVE <id> to decide remotely.');
  return { botToken, chatId, file };
}

/** Turn common SMTP failures into plain-language remedies. */
function translateSmtpError(message) {
  if (/535|not accepted|authentication/i.test(message)) {
    return `${message}\n     → The username or password is wrong. For Gmail use a 16-character ` +
      'App Password (https://myaccount.google.com/apppasswords), not your login password.';
  }
  if (/STARTTLS/i.test(message)) {
    return `${message}\n     → Try port 465 with implicit TLS, or 587 with STARTTLS.`;
  }
  if (/ECONNREFUSED|ENOTFOUND|timed out|EAI_AGAIN/i.test(message)) {
    return `${message}\n     → Check the SMTP host/port and your network.`;
  }
  return message;
}

/**
 * Email onboarding wizard.
 *
 * @param {object} params
 * @param {import('../config/configManager.js').ConfigManager} params.configManager
 * @param {import('./prompts.js').Prompter} params.prompter
 * @param {Function} [params.sendMailFn] - Injectable SMTP transport (tests).
 * @returns {Promise<{smtp:object, from:string, to:string, file:string}|null>}
 */
export async function runEmailSetup({ configManager, prompter, sendMailFn }) {
  const p = prompter;
  p.say('\n── Email setup ────────────────────────────────────────────');

  const provider = await p.choose('Email provider', [
    { value: 'gmail', label: 'Gmail', hint: 'needs a Google App Password (not your login password)' },
    { value: 'other', label: 'Other SMTP', hint: 'any host/port' },
  ], { default: 'gmail' });

  let host;
  let port;
  let secure = false;
  let starttls = true;
  if (provider === 'gmail') {
    host = 'smtp.gmail.com';
    port = 587;
    p.say('\nGmail needs an App Password:');
    p.say('  1. Turn on 2-Step Verification on your Google account.');
    p.say('  2. Visit https://myaccount.google.com/apppasswords and create one.');
    p.say('  3. Paste the 16-character App Password below (NOT your normal password).');
  } else {
    host = await p.text('SMTP host', { validate: (v) => (v ? true : 'A host is required.') });
    port = Number.parseInt(await p.text('SMTP port', { default: '587' }), 10);
    secure = await p.confirm('Use implicit TLS (port 465)?', { default: port === 465 });
    starttls = !secure;
  }

  const user = await p.text('SMTP username (usually your email address)');
  const pass = await p.secret('SMTP password / app password');
  const from = await p.text('From address', { default: user });
  const to = await p.text('Send notifications to', { default: user });

  const smtp = { host, port, secure, starttls, user, pass };
  const channel = new EmailChannel({ config: { smtp, from, to }, logger: silentLogger, sendMailFn });

  p.say('\nSending a test email…');
  try {
    await channel.send({
      title: 'AI-Orchestrator — email connected',
      message: 'If you can read this, email notifications work.',
    });
    p.say('  ✔ Test email sent — check your inbox.');
  } catch (error) {
    p.say(`  ✘ Test failed: ${translateSmtpError(error.message)}`);
    if (!await p.confirm('Save these settings anyway?', { default: false })) return null;
  }

  const file = configManager.writeLocalConfig({
    notifications: { email: { enabled: true, smtp, from, to } },
    approvals: { providers: { email: { enabled: true } } },
  });
  p.say(`\n✅ Email configured and saved to ${file}`);
  return { smtp, from, to, file };
}

/**
 * `notify tune` — Phase 11 M4: set a channel's `minSeverity` without
 * hand-editing `config/local.json`. The knob already existed (E10, since
 * Phase 10F) but only via JSON; this is onboarding polish on an existing
 * capability, the same pattern as `projects add --interactive` — the wizard
 * writes exactly the config an expert would edit by hand, nothing new.
 *
 * @param {object} params
 * @param {import('../config/configManager.js').ConfigManager} params.configManager
 * @param {import('./prompts.js').Prompter} params.prompter
 * @returns {Promise<{channel: string, minSeverity: string, file: string}|null>}
 *   Null when there was nothing to tune (no channel enabled) or the operator
 *   cancelled.
 */
export async function runNotifyTune({ configManager, prompter }) {
  const p = prompter;
  const config = configManager.get('notifications', {});
  const enabled = TUNABLE_CHANNELS.filter((name) => config[name]?.enabled);

  if (!enabled.length) {
    p.say('\nNo notification channels are enabled yet — run "ai-orchestrator notify setup telegram|email" first.');
    return null;
  }

  p.say('\n── Tune notification severity ─────────────────────────────');
  p.say('Each channel only receives events at or above its own minimum severity');
  p.say('(falling back to the global default when a channel has none set).');

  const globalMin = config.minSeverity ?? 'info';
  const channel = await p.choose('Which channel?', enabled.map((name) => ({
    value: name,
    label: name,
    hint: `currently ${config[name]?.minSeverity ?? `global default (${globalMin})`}`,
  })));

  const minSeverity = await p.choose(`Minimum severity for "${channel}"`, SEVERITIES.map((s) => ({
    value: s, label: s, hint: severityLabel(s),
  })), { default: config[channel]?.minSeverity ?? globalMin });

  const file = configManager.writeLocalConfig({
    notifications: { [channel]: { minSeverity } },
  });
  p.say(`\n✅ "${channel}" will now only notify at "${minSeverity}" or above — saved to ${file}`);
  return { channel, minSeverity, file };
}

export default { runTelegramSetup, runEmailSetup, runNotifyTune };
