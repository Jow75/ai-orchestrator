/**
 * Unit tests for cronExpression.js — the dependency-free 5-field cron
 * parser and next-occurrence walker (Phase 10G).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCron, cronMatches, nextCronOccurrence } from '../src/scheduler/cronExpression.js';

test('parses stars, values, lists, ranges, steps, and names', () => {
  const parsed = parseCron('*/15 9-17 1,15 jan-mar mon-fri');
  assert.deepEqual([...parsed.minute], [0, 15, 30, 45]);
  assert.deepEqual([...parsed.hour], [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual([...parsed.dayOfMonth], [1, 15]);
  assert.deepEqual([...parsed.month], [1, 2, 3]);
  assert.deepEqual([...parsed.dayOfWeek], [1, 2, 3, 4, 5]);
});

test('sunday can be written as 0, 7, or "sun"', () => {
  for (const spec of ['0 0 * * 0', '0 0 * * 7', '0 0 * * sun']) {
    const parsed = parseCron(spec);
    assert.ok(parsed.dayOfWeek.has(0), spec);
  }
});

test('rejects malformed expressions with the offending field named', () => {
  assert.throws(() => parseCron('* * * *'), /expected 5 fields/);
  assert.throws(() => parseCron('61 * * * *'), /minute/);
  assert.throws(() => parseCron('* 25 * * *'), /hour/);
  assert.throws(() => parseCron('* * * * frog'), /dayOfWeek/);
  assert.throws(() => parseCron('*/0 * * * *'), /step/);
});

test('cronMatches honors the POSIX dom/dow either-match rule', () => {
  // Both restricted: the 13th (any weekday) OR any Friday matches.
  const parsed = parseCron('0 0 13 * fri');
  const friday12th = new Date(2026, 5, 12, 0, 0); // 2026-06-12 is a Friday
  const saturday13th = new Date(2026, 5, 13, 0, 0);
  const sunday14th = new Date(2026, 5, 14, 0, 0);
  assert.equal(cronMatches(parsed, friday12th), true);
  assert.equal(cronMatches(parsed, saturday13th), true);
  assert.equal(cronMatches(parsed, sunday14th), false);
});

test('nextCronOccurrence finds the next slot, skipping efficiently', () => {
  const after = new Date(2026, 6, 12, 10, 20); // Sun 2026-07-12 10:20
  // Daily at 07:30 → tomorrow 07:30.
  assert.deepEqual(
    nextCronOccurrence('30 7 * * *', after),
    new Date(2026, 6, 13, 7, 30)
  );
  // Weekdays at 09:00 → Monday 09:00.
  assert.deepEqual(
    nextCronOccurrence('0 9 * * mon-fri', after),
    new Date(2026, 6, 13, 9, 0)
  );
  // Later the same hour.
  assert.deepEqual(
    nextCronOccurrence('45 10 * * *', after),
    new Date(2026, 6, 12, 10, 45)
  );
  // First of the next month.
  assert.deepEqual(
    nextCronOccurrence('0 0 1 * *', after),
    new Date(2026, 7, 1, 0, 0)
  );
});

test('nextCronOccurrence returns null for an impossible spec', () => {
  assert.equal(nextCronOccurrence('0 0 30 feb *', new Date(2026, 0, 1)), null);
});
