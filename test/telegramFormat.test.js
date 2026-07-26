/**
 * Tests for telegramFormat.js (Phase 11 M2) — the fix for the confirmed
 * live-walkthrough bug: Telegram sent every message with no `parse_mode`,
 * so its auto-linkification ran unrestricted and turned bare mentions of
 * "README.md" (`.md` is coincidentally also a ccTLD) into dead links.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, formatTelegramText } from '../src/notifications/telegramFormat.js';

test('escapeHtml escapes &, <, > only', () => {
  assert.equal(escapeHtml('a < b & c > d'), 'a &lt; b &amp; c &gt; d');
  assert.equal(escapeHtml('plain text'), 'plain text');
});

test('wraps a bare filename mention in <code> instead of letting it linkify', () => {
  const out = formatTelegramText('See README.md for details');
  assert.equal(out, 'See <code>README.md</code> for details');
});

test('wraps multiple distinct filenames on one line', () => {
  const out = formatTelegramText('Wrote report.md, notes.txt and data.json');
  assert.equal(out, 'Wrote <code>report.md</code>, <code>notes.txt</code> and <code>data.json</code>');
});

test('a real http(s) URL is left as a single, unbroken, clickable link', () => {
  const out = formatTelegramText('Report: https://example.com/report.pdf is ready');
  assert.equal(out, 'Report: https://example.com/report.pdf is ready');
  assert.ok(!out.includes('<code>')); // never split the URL with a nested tag
});

test('a URL with query params (including an literal &) survives escaping intact', () => {
  const out = formatTelegramText('See https://x.com/report.pdf?x=1&y=2 now');
  assert.equal(out, 'See https://x.com/report.pdf?x=1&amp;y=2 now');
});

test('HTML-special characters in freeform text are escaped, not misread as tags', () => {
  const out = formatTelegramText('a <script>alert(1)</script> & stuff');
  assert.equal(out, 'a &lt;script&gt;alert(1)&lt;/script&gt; &amp; stuff');
});

test('plain prose with numbers is left untouched (no false-positive filename matches)', () => {
  const out = formatTelegramText('5 tasks done, 2 failed, 100% coverage');
  assert.equal(out, '5 tasks done, 2 failed, 100% coverage');
});

test('an unrecognised extension is left as plain text (heuristic, not exhaustive)', () => {
  const out = formatTelegramText('see config.yaml for settings');
  assert.equal(out, 'see config.yaml for settings');
});

test('a Windows path mention still gets its filename portion protected', () => {
  // Known heuristic limitation: the drive-letter prefix ("C:\") falls
  // outside the wrapped span since ":" isn't a filename character — but
  // the meaningful, linkify-prone tail is still protected, which is the
  // actual goal (Telegram never tries to linkify a bare "C:\" anyway).
  const out = formatTelegramText(String.raw`Log written to C:\Users\Admin\notes.txt`);
  assert.match(out, /<code>[^<]*notes\.txt<\/code>/);
});

test('an empty or plain-prose message round-trips unchanged (aside from escaping)', () => {
  assert.equal(formatTelegramText(''), '');
  assert.equal(formatTelegramText('no filenames here, just plain prose.'), 'no filenames here, just plain prose.');
});
