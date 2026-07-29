/**
 * Tests for notifications/channels/telegram.js (previously untested at the
 * unit level). Covers the Phase 11 M2 fixes: safe HTML formatting +
 * parse_mode (kills the README.md dead-link bug), message id capture, and
 * the new sendDocument attachment capability.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramChannel, MAX_DOCUMENT_BYTES } from '../src/notifications/channels/telegram.js';
import { silentLogger } from '../src/infra/logger.js';

/** A fake fetch that records calls and returns a scripted Telegram-shaped response. */
function fakeFetch({ ok = true, status = 200, result = {} } = {}) {
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url, options });
    return { ok, status, json: async () => ({ ok: true, result }) };
  };
  return { fetchFn, calls };
}

function channel(overrides = {}) {
  const { fetchFn, calls } = fakeFetch(overrides.response);
  const c = new TelegramChannel({
    config: { botToken: 'BOT', chatId: '42' }, logger: silentLogger, fetchFn,
  });
  return { channel: c, calls };
}

test('requires botToken and chatId before doing anything', async () => {
  const c = new TelegramChannel({ config: {}, logger: silentLogger, fetchFn: async () => ({ ok: true, json: async () => ({}) }) });
  await assert.rejects(() => c.send({ title: 't', message: 'm' }), /botToken.*chatId/);
});

test('send() posts HTML parse_mode with the filename-protected, escaped text', async () => {
  const { channel: c, calls } = channel();
  await c.send({ title: 'Mission complete', message: 'See README.md for details' });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes('/sendMessage'));
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.chat_id, '42');
  assert.equal(body.parse_mode, 'HTML');
  assert.equal(body.disable_web_page_preview, true);
  assert.equal(body.text, 'Mission complete\nSee <code>README.md</code> for details');
});

test('send() returns the message id from the API response', async () => {
  const { channel: c } = channel({ response: { result: { message_id: 12345 } } });
  const result = await c.send({ title: 't', message: 'm' });
  assert.equal(result.messageId, '12345');
});

test('send() throws a descriptive error on a non-ok HTTP response', async () => {
  const { channel: c } = channel({ response: { ok: false, status: 401 } });
  await assert.rejects(() => c.send({ title: 't', message: 'm' }), /responded 401/);
});

test('send() splits a message over Telegram\'s real limit into sequential, numbered posts (Phase 13 M1)', async () => {
  const { channel: c, calls } = channel();
  await c.send({ title: 'Mission complete', message: 'x'.repeat(5000) });
  assert.equal(calls.length, 2);
  const bodies = calls.map((call) => JSON.parse(call.options.body));
  assert.ok(bodies[0].text.endsWith('(1/2)'));
  assert.ok(bodies[1].text.endsWith('(2/2)'));
  for (const body of bodies) assert.ok(body.text.length <= 4096);
});

test('send() retries with plain text (no parse_mode) if Telegram rejects the HTML payload', async () => {
  let call = 0;
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push(options);
    call += 1;
    if (call === 1) return { ok: false, status: 400, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
  };
  const c = new TelegramChannel({ config: { botToken: 'BOT', chatId: '42' }, logger: silentLogger, fetchFn });
  const result = await c.send({ title: 'x', message: 'See README.md' });
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[0].body).parse_mode, 'HTML');
  assert.equal(JSON.parse(calls[1].body).parse_mode, undefined);
  assert.ok(!JSON.parse(calls[1].body).text.includes('<code>'));
  assert.ok(result); // did not throw — the message still went out
});

// ── sendDocument ────────────────────────────────────────────────────────

function tmpFile(content = 'hello world') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-tgdoc-'));
  const file = path.join(dir, 'report.md');
  fs.writeFileSync(file, content);
  return file;
}

test('sendDocument() posts multipart form data with the file and chat id', async () => {
  const { channel: c, calls } = channel();
  const file = tmpFile('# Report\ncontents here');
  await c.sendDocument({ filePath: file, caption: 'Mission report' });

  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes('/sendDocument'));
  const form = calls[0].options.body;
  assert.ok(form instanceof FormData);
  assert.equal(form.get('chat_id'), '42');
  assert.equal(form.get('parse_mode'), 'HTML');
  const doc = form.get('document');
  assert.ok(doc instanceof Blob);
  assert.equal(doc.name, 'report.md');
});

test('sendDocument() returns the message id from the API response', async () => {
  const { channel: c } = channel({ response: { result: { message_id: 777 } } });
  const result = await c.sendDocument({ filePath: tmpFile() });
  assert.equal(result.messageId, '777');
});

test('sendDocument() refuses a missing file with a clear error, no network call', async () => {
  const { channel: c, calls } = channel();
  await assert.rejects(
    () => c.sendDocument({ filePath: '/no/such/file.md' }),
    /file not found/
  );
  assert.equal(calls.length, 0);
});

test('sendDocument() refuses a file over the Telegram size limit, no network call', async () => {
  const { channel: c, calls } = channel();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-tgbig-'));
  const file = path.join(dir, 'huge.zip');
  fs.writeFileSync(file, Buffer.alloc(0)); // real file, then fake its size via a stub stat
  const originalStat = fs.statSync;
  fs.statSync = (p) => (p === file ? { size: MAX_DOCUMENT_BYTES + 1 } : originalStat(p));
  try {
    await assert.rejects(() => c.sendDocument({ filePath: file }), /exceeds Telegram's/);
  } finally {
    fs.statSync = originalStat;
  }
  assert.equal(calls.length, 0);
});

test('sendDocument() requires configuration too', async () => {
  const c = new TelegramChannel({ config: {}, logger: silentLogger, fetchFn: async () => ({ ok: true, json: async () => ({}) }) });
  await assert.rejects(() => c.sendDocument({ filePath: tmpFile() }), /botToken.*chatId/);
});
