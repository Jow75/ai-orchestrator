/**
 * Unit tests for operator/confirmations.js — Phase 12 M2 Priority 7.
 *
 * "Any destructive action requires confirmation. No implicit execution."
 *
 * The properties that make that true rather than decorative: a code is
 * single-use (so a resent message cannot stop a mission twice), it expires
 * (so "yes" twenty minutes later confirms nothing), and a bare "yes" with two
 * things pending is REFUSED rather than guessed at — guessing is precisely
 * the failure this module exists to prevent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import ConfirmationStore from '../src/operator/confirmations.js';

/** A clock the test drives, so expiry is tested without waiting for it. */
function clocked(ttlMs = 1_000) {
  let now = 1_000_000;
  const store = new ConfirmationStore({ ttlMs, now: () => now });
  return { store, advance: (ms) => { now += ms; }, at: () => now };
}

test('requiring an action performs nothing and hands back a code', () => {
  const { store } = clocked();
  let performed = false;

  const confirmation = store.require({
    channel: 'telegram',
    action: 'stop',
    project: 'alpha',
    summary: 'Stop the mission running on alpha.',
    perform: () => { performed = true; },
  });

  assert.match(confirmation.code, /^[A-Z0-9]{4}$/);
  assert.equal(performed, false, 'nothing happened on the first message');
  assert.equal(store.listFor('telegram').length, 1);
});

test('confirming performs the action exactly once', async () => {
  const { store } = clocked();
  let calls = 0;
  const { code } = store.require({
    channel: 'telegram', action: 'stop', summary: 'Stop alpha.', perform: () => { calls += 1; },
  });

  const first = store.take('telegram', code);
  assert.equal(first.ok, true);
  await first.confirmation.perform();

  const second = store.take('telegram', code);
  assert.equal(second.ok, false, 'a resent message cannot stop it twice');
  assert.equal(calls, 1);
});

test('a code is case-insensitive and tolerates surrounding whitespace', () => {
  const { store } = clocked();
  const { code } = store.require({
    channel: 'telegram', action: 'stop', summary: 'Stop alpha.', perform: () => {},
  });

  assert.equal(store.take('telegram', `  ${code.toLowerCase()} `).ok, true);
});

test('a code expires', () => {
  const { store, advance } = clocked(1_000);
  const { code } = store.require({
    channel: 'telegram', action: 'shutdown', summary: 'Stop the service.', perform: () => {},
  });

  advance(1_500);
  const result = store.take('telegram', code);

  assert.equal(result.ok, false);
  assert.match(result.reason, /expired/);
  assert.equal(store.listFor('telegram').length, 0);
});

test('a bare confirm works with exactly one pending action, and is REFUSED with two', () => {
  const { store } = clocked();
  store.require({ channel: 'telegram', action: 'stop', project: 'alpha', summary: 'Stop alpha.', perform: () => {} });

  const single = store.take('telegram');
  assert.equal(single.ok, true, 'with one pending, "yes" is unambiguous');

  store.require({ channel: 'telegram', action: 'stop', project: 'alpha', summary: 'Stop alpha.', perform: () => {} });
  store.require({ channel: 'telegram', action: 'stop', project: 'beta', summary: 'Stop beta.', perform: () => {} });

  const ambiguous = store.take('telegram');
  assert.equal(ambiguous.ok, false, 'with two, guessing which mission to stop is unacceptable');
  assert.equal(ambiguous.candidates.length, 2, 'and the reply can list both codes');
});

test('a bare confirm with nothing pending says so', () => {
  const { store } = clocked();
  const result = store.take('telegram');

  assert.equal(result.ok, false);
  assert.match(result.reason, /Nothing is waiting/);
});

test('a code issued on one channel is not redeemable on another', () => {
  const { store } = clocked();
  const { code } = store.require({
    channel: 'telegram', action: 'shutdown', summary: 'Stop the service.', perform: () => {},
  });

  const elsewhere = store.take('api', code);

  assert.equal(elsewhere.ok, false);
  assert.equal(store.listFor('telegram').length, 1, 'and the real one is still pending');
});

test('cancelling discards without performing', () => {
  const { store } = clocked();
  let performed = false;
  const { code } = store.require({
    channel: 'telegram', action: 'stop', summary: 'Stop alpha.', perform: () => { performed = true; },
  });

  const result = store.cancel('telegram', code);

  assert.equal(result.ok, true);
  assert.equal(performed, false);
  assert.equal(store.take('telegram', code).ok, false);
});

test('a bare cancel clears every pending confirmation on that channel only', () => {
  const { store } = clocked();
  store.require({ channel: 'telegram', action: 'stop', summary: 'a', perform: () => {} });
  store.require({ channel: 'telegram', action: 'stop', summary: 'b', perform: () => {} });
  store.require({ channel: 'api', action: 'stop', summary: 'c', perform: () => {} });

  const result = store.cancel('telegram');

  assert.equal(result.cancelled, 2);
  assert.equal(store.listFor('telegram').length, 0);
  assert.equal(store.listFor('api').length, 1);
});

test('codes are unique across concurrent pending actions', () => {
  const { store } = clocked(60_000);
  const codes = new Set();
  for (let i = 0; i < 50; i += 1) {
    codes.add(store.require({
      channel: 'telegram', action: 'stop', summary: `stop ${i}`, perform: () => {},
    }).code);
  }

  assert.equal(codes.size, 50);
});
