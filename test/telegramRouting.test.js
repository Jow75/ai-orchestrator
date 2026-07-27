/**
 * Tests for the Phase 12 M2 additions to the Telegram approval provider:
 * `fetchMessages()`, `sendText()`, and the fact that `fetchDecisions()` now
 * rides on top of them.
 *
 * The refactor is the risky part. `fetchDecisions()` is the path a STANDALONE
 * orchestrator (no daemon, no operator interface) still takes, and the Phase 12
 * Invariant says it must behave exactly as it did in v2.7.0. So its old
 * contract is re-tested here in full — chat restriction, offset advance,
 * offset persistence — against the new implementation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import TelegramApprovalProvider from '../src/approvals/providers/telegramProvider.js';
import { silentLogger } from '../src/infra/logger.js';

const CHAT_ID = '6522731464';

/** A fetch stand-in that serves canned getUpdates payloads and records posts. */
function fakeFetch(updateBatches) {
  const calls = [];
  const posts = [];
  const fetchFn = async (url, options) => {
    calls.push(url);
    if (String(url).includes('getUpdates')) {
      const result = updateBatches.shift() ?? [];
      return { ok: true, async json() { return { ok: true, result }; } };
    }
    posts.push({ url, body: JSON.parse(options.body) });
    return { ok: true, async json() { return { result: { message_id: 99 } }; } };
  };
  return { fetchFn, calls, posts };
}

function provider(updateBatches, { withOffsetFile = false } = {}) {
  const offsetFile = withOffsetFile
    ? path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aio-tg-')), 'telegram.offset')
    : undefined;
  const { fetchFn, calls, posts } = fakeFetch(updateBatches);
  return {
    offsetFile,
    calls,
    posts,
    provider: new TelegramApprovalProvider({
      config: { botToken: 'T', chatId: CHAT_ID },
      logger: silentLogger,
      offsetFile,
      fetchFn,
    }),
  };
}

/** One getUpdates message shaped the way Telegram actually sends it. */
function message(id, text, chatId = CHAT_ID) {
  return {
    update_id: id,
    message: {
      message_id: id * 10,
      date: 1_770_000_000,
      text,
      chat: { id: Number(chatId) },
      from: { username: 'moses' },
    },
  };
}

test('the provider declares that it can route, which is what the gateway keys on', () => {
  const { provider: p } = provider([]);
  assert.equal(p.canReceive, true);
  assert.equal(p.canRoute, true);
});

test('fetchMessages returns every owner message, unparsed', async () => {
  const { provider: p } = provider([[
    message(1, '/projects'),
    message(2, 'Build a payroll dashboard.'),
    message(3, 'APPROVE A7'),
  ]]);

  const messages = await p.fetchMessages();

  assert.deepEqual(messages.map((m) => m.text), ['/projects', 'Build a payroll dashboard.', 'APPROVE A7']);
  assert.equal(messages[0].from, 'moses');
  assert.equal(messages[0].chatId, CHAT_ID);
  assert.equal(messages[0].messageId, '10');
  assert.ok(Date.parse(messages[0].at) > 0);
});

test('a message from any other chat is dropped before any parsing happens', async () => {
  const { provider: p } = provider([[
    message(1, '/shutdown', '999999'),
    message(2, 'APPROVE A7', '999999'),
    message(3, '/projects'),
  ]]);

  const messages = await p.fetchMessages();

  assert.deepEqual(messages.map((m) => m.text), ['/projects'],
    'a stranger messaging the bot can reach no command surface, present or future');
});

test('non-text updates are skipped without disturbing the offset', async () => {
  const { provider: p } = provider([[
    { update_id: 1, message: { message_id: 10, chat: { id: Number(CHAT_ID) }, photo: [{}] } },
    message(2, '/help'),
  ]]);

  const messages = await p.fetchMessages();

  assert.equal(messages.length, 1);
  assert.equal(await p.loadOffset(), 2, 'the skipped update is still acknowledged');
});

test('the offset advances so a message is never served twice', async () => {
  const { provider: p, calls } = provider([[message(5, '/help')], []]);

  await p.fetchMessages();
  await p.fetchMessages();

  assert.match(calls[0], /offset=1/, 'first read starts from the beginning');
  assert.match(calls[1], /offset=6/, 'second read acknowledges everything up to 5');
});

test('the offset is persisted, so a restart does not replay old replies', async () => {
  const { provider: p, offsetFile } = provider([[message(7, 'APPROVE A7')]], { withOffsetFile: true });
  await p.fetchMessages();

  assert.equal(JSON.parse(fs.readFileSync(offsetFile, 'utf8')).offset, 7);
});

test('fetchDecisions still returns exactly the decision replies (the standalone path)', async () => {
  const { provider: p } = provider([[
    message(1, '/projects'),
    message(2, 'APPROVE A7'),
    message(3, 'Build a payroll dashboard.'),
    message(4, 'REJECT A8 too risky'),
  ]]);

  const decisions = await p.fetchDecisions();

  assert.deepEqual(decisions, [
    { requestId: 'A7', decision: 'approved', by: 'moses' },
    { requestId: 'A8', decision: 'rejected', note: 'too risky', by: 'moses' },
  ]);
});

test('fetchDecisions still honours the chat restriction', async () => {
  const { provider: p } = provider([[message(1, 'APPROVE A7', '999999')]]);

  assert.deepEqual(await p.fetchDecisions(), []);
});

test('sendText posts to the owner chat with HTML formatting', async () => {
  const { provider: p, posts } = provider([]);

  await p.sendText('alpha — see README.md for details');

  assert.equal(posts.length, 1);
  assert.match(posts[0].url, /sendMessage/);
  assert.equal(posts[0].body.chat_id, CHAT_ID);
  assert.equal(posts[0].body.parse_mode, 'HTML');
  assert.match(posts[0].body.text, /<code>README\.md<\/code>/,
    'a filename must never render as a dead link (the Phase 11 M2 fix)');
});

test('an API error surfaces rather than being swallowed', async () => {
  const p = new TelegramApprovalProvider({
    config: { botToken: 'T', chatId: CHAT_ID },
    logger: silentLogger,
    fetchFn: async () => ({ ok: false, status: 429 }),
  });

  await assert.rejects(() => p.sendText('anything'), /429/);
  await assert.rejects(() => p.fetchMessages(), /429/);
});

test('missing configuration is refused before any network call', async () => {
  const p = new TelegramApprovalProvider({ config: {}, logger: silentLogger, fetchFn: async () => {
    throw new Error('should never be called');
  } });

  await assert.rejects(() => p.fetchMessages(), /botToken/);
  await assert.rejects(() => p.sendText('x'), /botToken/);
});
