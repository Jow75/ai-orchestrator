/**
 * Tests for telegramSplit.js (Phase 13 M1) — deterministic multi-part
 * delivery for text that exceeds Telegram's real 4096-char message limit,
 * and the plain-text retry when Telegram rejects an HTML payload outright.
 *
 * The root cause this replaces (see docs/PHASE_13_PLAN.md M1) was never
 * actually hitting the 4096 limit — it was a flat, boundary-blind
 * `truncate()` on the agent's own report text. These tests focus on the
 * part of the fix that IS a real, load-bearing safety net: splitting must
 * never produce a part that breaks HTML parsing, because that failure mode
 * (a rejected sendMessage call) is worse than the truncation it replaces.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_MESSAGE_CHARS, splitForTelegram, stripHtml, sendLongText } from '../src/notifications/telegramSplit.js';

// ── splitForTelegram ────────────────────────────────────────────────────

test('text at or under the limit is returned as a single, unnumbered part', () => {
  assert.deepEqual(splitForTelegram('short'), ['short']);
  const exact = 'x'.repeat(MAX_MESSAGE_CHARS);
  assert.deepEqual(splitForTelegram(exact), [exact]);
});

test('one character over the limit produces exactly two numbered parts', () => {
  const text = 'x'.repeat(MAX_MESSAGE_CHARS + 1);
  const parts = splitForTelegram(text);
  assert.equal(parts.length, 2);
  assert.ok(parts[0].endsWith('(1/2)'));
  assert.ok(parts[1].endsWith('(2/2)'));
  for (const part of parts) assert.ok(part.length <= MAX_MESSAGE_CHARS);
});

test('every part of a long split stays at or under maxChars', () => {
  const text = Array.from({ length: 2000 }, (_, i) => `line ${i} of a very long report`).join('\n');
  const parts = splitForTelegram(text, { maxChars: 500 });
  assert.ok(parts.length > 1);
  for (const part of parts) assert.ok(part.length <= 500, `part length ${part.length} exceeds 500`);
});

test('prefers a paragraph break over a line break, and a line break over a word break', () => {
  const para = 'a'.repeat(40) + '\n\n' + 'b'.repeat(40);
  const parts = splitForTelegram(para, { maxChars: 60 }); // effectiveMax 48 comfortably covers the break at index 42
  assert.equal(parts.length, 2);
  assert.ok(parts[0].startsWith('a'.repeat(40)));
  assert.ok(!parts[0].includes('b'));
});

test('never splits inside an HTML tag', () => {
  // A long <code>...</code> span straddling the naive cut point.
  const text = 'x'.repeat(4080) + '<code>filename-that-is-long.txt</code>' + 'y'.repeat(200);
  const parts = splitForTelegram(text);
  for (const part of parts) {
    // Every < has a matching > within the SAME part.
    const opens = (part.match(/</g) ?? []).length;
    const closes = (part.match(/>/g) ?? []).length;
    assert.equal(opens, closes, `unbalanced tag in part: ${part.slice(0, 80)}...`);
  }
  assert.equal(parts.join('').replace(/\n\(\d+\/\d+\)/g, ''), text);
});

test('never splits inside an HTML entity', () => {
  const text = 'z'.repeat(4090) + '&amp;' + 'w'.repeat(50);
  const parts = splitForTelegram(text);
  for (const part of parts) {
    assert.ok(!/&(?:amp|lt|gt)?$/.test(part), `part ends mid-entity: ...${part.slice(-20)}`);
  }
});

test('adversarial mixed tag/entity/paragraph text: every part is independently well-formed', () => {
  const chunks = [];
  for (let i = 0; i < 300; i += 1) {
    if (i % 7 === 0) chunks.push('<code>report.md</code>');
    else if (i % 5 === 0) chunks.push('A &amp; B');
    else if (i % 11 === 0) chunks.push('\n\n');
    else chunks.push(`word${i}`);
  }
  const text = chunks.join(' ');
  const parts = splitForTelegram(text, { maxChars: 300 });
  assert.ok(parts.length > 1);
  for (const part of parts) {
    const opens = (part.match(/</g) ?? []).length;
    const closes = (part.match(/>/g) ?? []).length;
    assert.equal(opens, closes, 'unbalanced tag');
    assert.ok(!/&(?:amp|lt|gt)?$/.test(part), 'mid-entity cut');
    assert.ok(part.length <= 300 + 20); // suffix reserve headroom
  }
  // Reassembling (minus the numbering suffixes) reproduces the original text.
  const reassembled = parts.map((p) => p.replace(/\n\(\d+\/\d+\)$/, '')).join('');
  assert.equal(reassembled, text);
});

test('exact boundary: 4095/4096/4097 chars', () => {
  assert.equal(splitForTelegram('a'.repeat(4095)).length, 1);
  assert.equal(splitForTelegram('a'.repeat(4096)).length, 1);
  assert.equal(splitForTelegram('a'.repeat(4097)).length, 2);
});

// ── stripHtml ────────────────────────────────────────────────────────────

test('stripHtml removes tags and unescapes the three entities formatTelegramText produces', () => {
  assert.equal(stripHtml('<code>a &amp; b</code> &lt;tag&gt;'), 'a & b <tag>');
});

// ── sendLongText ─────────────────────────────────────────────────────────

test('sendLongText sends a short message exactly once', async () => {
  const sent = [];
  const result = await sendLongText({
    text: 'hello',
    send: async (part) => { sent.push(part); return { messageId: '1' }; },
  });
  assert.deepEqual(sent, ['hello']);
  assert.equal(result.messageId, '1');
});

test('sendLongText sends a long message as sequential, ordered parts', async () => {
  const sent = [];
  const text = 'x'.repeat(MAX_MESSAGE_CHARS + 500);
  await sendLongText({
    text,
    send: async (part) => { sent.push(part); return { messageId: String(sent.length) }; },
  });
  assert.equal(sent.length, 2);
  assert.ok(sent[0].endsWith('(1/2)'));
  assert.ok(sent[1].endsWith('(2/2)'));
});

test('sendLongText returns the FIRST part\'s result (stable messageId contract)', async () => {
  const text = 'x'.repeat(MAX_MESSAGE_CHARS + 500);
  const result = await sendLongText({
    text,
    send: async () => ({ messageId: 'abc' }),
  });
  assert.equal(result.messageId, 'abc');
});

test('sendLongText retries a rejected part once, stripped of HTML, rather than losing it', async () => {
  const attempts = [];
  await sendLongText({
    text: '<code>bad</code> payload',
    send: async (part, opts = {}) => {
      attempts.push({ part, plain: opts.plain ?? false });
      if (!opts.plain) throw new Error('Telegram API responded 400');
      return { messageId: 'retry-ok' };
    },
  });
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].plain, false);
  assert.equal(attempts[1].plain, true);
  assert.equal(attempts[1].part, 'bad payload'); // tags stripped for the retry
});

test('sendLongText propagates the error if even the plain-text retry fails', async () => {
  await assert.rejects(
    () => sendLongText({
      text: 'x',
      send: async () => { throw new Error('still down'); },
    }),
    /still down/
  );
});
