/**
 * Tests for the onboarding prompt harness (Phase 11A). Every wizard is
 * driven through this, so it must be fully exercisable without a TTY: we
 * inject a scripted answer queue as `ask` and a capturing `output`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrompter } from '../src/onboarding/prompts.js';

/** A prompter wired to a fixed answer queue and a captured output buffer. */
function harness(answers) {
  const queue = [...answers];
  const out = [];
  const prompter = createPrompter({
    ask: async () => {
      if (!queue.length) throw new Error('prompt asked for more input than the test supplied');
      return queue.shift();
    },
    output: { write: (s) => out.push(s) },
  });
  return { prompter, out: () => out.join('') };
}

test('text: returns the typed value', async () => {
  const { prompter } = harness(['my-project']);
  assert.equal(await prompter.text('Name'), 'my-project');
});

test('text: empty input falls back to the default', async () => {
  const { prompter } = harness(['']);
  assert.equal(await prompter.text('Driver', { default: 'claude' }), 'claude');
});

test('text: re-asks until validation passes', async () => {
  const { prompter, out } = harness(['', 'bad', '587']);
  const value = await prompter.text('Port', {
    validate: (v) => (/^\d+$/.test(v) ? true : 'Enter digits only.'),
  });
  assert.equal(value, '587');
  assert.match(out(), /Enter digits only/); // the rejection was shown
});

test('text: a required question with no default re-asks on empty', async () => {
  const { prompter } = harness(['', '  ', 'finally']);
  assert.equal(await prompter.text('Required'), 'finally');
});

test('confirm: parses yes/no and honours the default on Enter', async () => {
  assert.equal(await harness(['y']).prompter.confirm('OK?'), true);
  assert.equal(await harness(['no']).prompter.confirm('OK?'), false);
  assert.equal(await harness(['']).prompter.confirm('OK?', { default: true }), true);
  assert.equal(await harness(['']).prompter.confirm('OK?', { default: false }), false);
});

test('confirm: re-asks on an unrecognised answer', async () => {
  const { prompter, out } = harness(['maybe', 'y']);
  assert.equal(await prompter.confirm('OK?'), true);
  assert.match(out(), /answer y or n/i);
});

test('choose: accepts a 1-based number', async () => {
  const { prompter } = harness(['2']);
  const value = await prompter.choose('Pick', ['a', 'b', 'c']);
  assert.equal(value, 'b');
});

test('choose: accepts the value directly and supports object choices', async () => {
  const { prompter } = harness(['acceptEdits']);
  const value = await prompter.choose('Mode', [
    { value: 'acceptEdits', label: 'Accept edits', hint: 'writes files' },
    { value: '', label: 'Read-only' },
  ]);
  assert.equal(value, 'acceptEdits');
});

test('choose: Enter selects the default', async () => {
  const { prompter } = harness(['']);
  const value = await prompter.choose('Pick', ['a', 'b'], { default: 'b' });
  assert.equal(value, 'b');
});

test('choose: re-asks on an out-of-range number', async () => {
  const { prompter, out } = harness(['9', '1']);
  const value = await prompter.choose('Pick', ['a', 'b']);
  assert.equal(value, 'a');
  assert.match(out(), /Enter a number 1-2/);
});

test('say: writes a line to the output stream', () => {
  const { prompter, out } = harness([]);
  prompter.say('hello');
  assert.equal(out(), 'hello\n');
});
