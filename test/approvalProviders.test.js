/**
 * Unit tests for the Phase 10C approval providers: the shared reply
 * grammar, the two-way Telegram provider (publish + getUpdates polling,
 * offset persistence, stranger filtering), the implementation summary
 * builder, and the publish-only email provider.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDecisionText } from '../src/approvals/providers/approvalProvider.js';
import { TelegramApprovalProvider } from '../src/approvals/providers/telegramProvider.js';
import { EmailApprovalProvider } from '../src/approvals/providers/emailProvider.js';
import {
  buildImplementationSummary, renderImplementationSummary,
} from '../src/approvals/implementationSummary.js';
import { silentLogger } from '../src/infra/logger.js';

// ── reply grammar ─────────────────────────────────────────────────────────

test('parseDecisionText understands the shared reply grammar', () => {
  assert.deepEqual(parseDecisionText('APPROVE A7'), { requestId: 'A7', decision: 'approved' });
  assert.deepEqual(parseDecisionText('reject A7 too risky'),
    { requestId: 'A7', decision: 'rejected', note: 'too risky' });
  assert.deepEqual(parseDecisionText('MODIFY A12 skip the migration step'),
    { requestId: 'A12', decision: 'modified', note: 'skip the migration step' });
  assert.deepEqual(parseDecisionText('/done A3'), { requestId: 'A3', decision: 'done' });
  assert.equal(parseDecisionText('hello bot'), null);
  assert.equal(parseDecisionText(''), null);
});

// ── telegram provider ─────────────────────────────────────────────────────

function telegramHarness({ updates = [] } = {}) {
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/sendMessage')) {
      return { ok: true, json: async () => ({ ok: true }) };
    }
    return { ok: true, json: async () => ({ ok: true, result: updates }) };
  };
  const offsetFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aio-tg-')), 'telegram.offset');
  const provider = new TelegramApprovalProvider({
    config: { botToken: 'BOT', chatId: '42' },
    logger: silentLogger,
    offsetFile,
    fetchFn,
  });
  return { provider, calls, offsetFile };
}

test('telegram publish() sends title + message to the configured chat', async () => {
  const { provider, calls } = telegramHarness();
  await provider.publish({ title: 'Approval required', message: 'APPROVE A1' });
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.chat_id, '42');
  assert.match(body.text, /Approval required\n\nAPPROVE A1/);
});

test('telegram fetchDecisions parses replies, ignores strangers, advances the offset', async () => {
  const { provider, calls, offsetFile } = telegramHarness({
    updates: [
      { update_id: 100, message: { chat: { id: 42 }, from: { username: 'owner' }, text: 'APPROVE A1' } },
      { update_id: 101, message: { chat: { id: 666 }, from: { username: 'stranger' }, text: 'APPROVE A2' } },
      { update_id: 102, message: { chat: { id: 42 }, text: 'what is the weather' } },
      { update_id: 103, message: { chat: { id: 42 }, text: 'DONE A3' } },
    ],
  });
  const decisions = await provider.fetchDecisions();
  assert.deepEqual(decisions.map((d) => [d.requestId, d.decision]), [['A1', 'approved'], ['A3', 'done']]);
  // Offset persisted past the last update; the next poll asks from there.
  assert.equal(JSON.parse(fs.readFileSync(offsetFile, 'utf8')).offset, 103);
  await provider.fetchDecisions();
  assert.match(calls.at(-1).url, /offset=104/);
});

test('telegram provider demands configuration before doing anything', async () => {
  const provider = new TelegramApprovalProvider({ config: {}, logger: silentLogger });
  await assert.rejects(() => provider.publish({ title: 't', message: 'm' }), /botToken/);
});

// ── email provider ────────────────────────────────────────────────────────

test('email provider is publish-only and includes response instructions', async () => {
  const sent = [];
  const provider = new EmailApprovalProvider({
    config: { smtp: { host: 'smtp.test' }, from: 'bot@test', to: 'owner@test' },
    logger: silentLogger,
    sendMailFn: async (mail) => sent.push(mail),
  });
  assert.equal(provider.canReceive, false);
  await provider.publish({
    request: { id: 'A9' }, title: 'Approval required — proj', message: 'Deploy?',
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'owner@test');
  assert.match(sent[0].text, /approvals approve A9/);
  assert.match(sent[0].text, /Email replies are not monitored/);
});

// ── implementation summary ────────────────────────────────────────────────

test('buildImplementationSummary extracts sections and explicit metadata', () => {
  const planText = [
    'IMPLEMENTATION PLAN READY',
    'Refactor the auth module to support SSO.',
    '',
    'Estimated duration: 2 hours',
    'Estimated files changed: 7',
    '',
    '## Tasks',
    '- extract token validation',
    '- add SAML adapter',
    '',
    '## Risks',
    '- session invalidation for logged-in users',
    '',
    '## Affected systems',
    '- login service',
    '- API gateway',
  ].join('\n');

  const summary = buildImplementationSummary({ project: 'proj', planText });
  assert.equal(summary.objective, 'Refactor the auth module to support SSO.');
  assert.equal(summary.estimatedDuration, '2 hours');
  assert.equal(summary.estimatedFilesChanged, '7');
  assert.deepEqual(summary.tasks, ['extract token validation', 'add SAML adapter']);
  assert.deepEqual(summary.risks, ['session invalidation for logged-in users']);
  assert.deepEqual(summary.affectedSystems, ['login service', 'API gateway']);

  const rendered = renderImplementationSummary(summary);
  assert.match(rendered, /Objective: Refactor the auth module/);
  assert.match(rendered, /Risks:\n {2}• session invalidation/);
});

test('a plan written in markdown parses the same as a plain one', () => {
  // Found live on 2026-07-28 (mission M8, the first REAL run of the calculator
  // objective). Engines write plans in markdown, so every heading and label
  // arrives emphasised. None of them matched, with two visible consequences:
  // the objective was shown to the owner as "** Deliver a real…" with the
  // closing bold still attached, and every bullet in the plan — tasks, files
  // and risks alike — piled into whichever section had matched last, so the
  // approval offered eight "tasks", no risks and no files.
  const planText = [
    '## Implementation Plan',
    '',
    '**Objective:** Deliver a runnable calculator built with React and Electron.',
    '**Estimated duration:** ~20 minutes',
    '**Estimated files changed:** 11',
    '',
    '**Tasks (in order):**',
    '1. Scaffold `package.json` and `.gitignore`.',
    '2. Write the pure engine `src/calculator.js`.',
    '',
    '**Files:**',
    '- `package.json`',
    '- `src/calculator.js`',
    '',
    '**Risks:**',
    '- `npm install` needs network access',
    '',
    'IMPLEMENTATION PLAN READY',
  ].join('\n');

  const summary = buildImplementationSummary({ project: 'proj', planText });

  assert.equal(summary.objective,
    'Deliver a runnable calculator built with React and Electron.',
    'the closing ** must not travel into the objective the owner reads');
  assert.equal(summary.estimatedDuration, '~20 minutes');
  assert.equal(summary.estimatedFilesChanged, '11');
  assert.deepEqual(summary.tasks, [
    'Scaffold `package.json` and `.gitignore`.',
    'Write the pure engine `src/calculator.js`.',
  ], 'the Files and Risks bullets must not be counted as tasks');
  assert.deepEqual(summary.files, ['`package.json`', '`src/calculator.js`']);
  assert.deepEqual(summary.risks, ['`npm install` needs network access']);
});

test('emphasis stripping never turns a bullet into a heading', () => {
  // `* item` and `**bold**` both start with an asterisk. Collapsing the first
  // would make every asterisk-bulleted line a candidate section heading.
  const planText = [
    '## Tasks',
    '* build the thing',
    '* Risks: none worth listing',   // a bullet that MENTIONS a section word
    '* test the thing',
  ].join('\n');

  const summary = buildImplementationSummary({ project: 'proj', planText });

  assert.deepEqual(summary.tasks,
    ['build the thing', 'Risks: none worth listing', 'test the thing']);
  assert.deepEqual(summary.risks, [], 'a bullet is a bullet, whatever it says');
});

test('a value that legitimately starts with an asterisk survives', () => {
  const summary = buildImplementationSummary({
    project: 'proj',
    planText: 'Objective: *.js files are rewritten in place\nIMPLEMENTATION PLAN READY',
  });
  assert.equal(summary.objective, '*.js files are rewritten in place');
});

test('summary falls back to the queue plan and ledger-average duration', () => {
  const queue = {
    currentIndex: 1,
    tasks: [
      { id: 'T1', objective: 'done already', state: 'done' },
      { id: 'T2', objective: 'build the API', state: 'pending' },
      { id: 'T3', objective: 'write the docs', state: 'pending' },
    ],
  };
  const summary = buildImplementationSummary({
    project: 'proj', planText: 'IMPLEMENTATION PLAN READY', queue, averageRunMs: 5 * 60_000,
  });
  assert.deepEqual(summary.tasks, ['build the API', 'write the docs']);
  assert.match(summary.estimatedDuration, /~10 min/);
  assert.equal(summary.estimatedFilesChanged, 'unknown');
});
