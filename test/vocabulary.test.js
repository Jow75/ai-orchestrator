/**
 * Tests for the Phase 11 M4 shared terminology contract
 * (src/shared/vocabulary.js) — the single source every surface (CLI,
 * notificationEngine, missionCard, doctor) now reads icons/labels from,
 * fixing a confirmed drift (three different "success" icons across CLI/
 * notification-title/Mission-Card).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  outcomeIcon, outcomeLabel, decisionLabel, confidenceLabel, checkMark, severityLabel,
} from '../src/shared/vocabulary.js';

test('outcomeIcon/outcomeLabel cover every mission outcome the codebase produces', () => {
  assert.equal(outcomeIcon('complete'), '✅');
  assert.equal(outcomeIcon('blocked'), '⛔');
  assert.equal(outcomeIcon('cancelled'), '⚠️');
  assert.equal(outcomeIcon('failed'), '✖');
  assert.equal(outcomeIcon('incomplete'), '■');
  assert.equal(outcomeLabel('complete'), 'Complete');
  assert.equal(outcomeLabel('blocked'), 'Blocked');
});

test('outcomeIcon/outcomeLabel degrade gracefully for an unknown status', () => {
  assert.equal(outcomeIcon('mystery'), 'ℹ️');
  assert.equal(outcomeLabel('mystery'), 'mystery'); // never throws, never hides the raw value
});

test('decisionLabel covers every approval/human-action status', () => {
  assert.equal(decisionLabel('approved'), 'Approved');
  assert.equal(decisionLabel('rejected'), 'Rejected');
  assert.equal(decisionLabel('auto-approved'), 'Auto-approved');
  assert.equal(decisionLabel('done'), 'Done');
  assert.equal(decisionLabel('unknown-status'), 'unknown-status');
});

test('confidenceLabel matches the wording missionCard has always used', () => {
  assert.equal(confidenceLabel('verified'), 'Verified ✔');
  assert.equal(confidenceLabel('partial'), 'Partially verified ⚠️');
  assert.equal(confidenceLabel('unverified'), 'Unverified (no checks ran)');
});

test('checkMark matches doctor\'s pre-M4 marks exactly (behavior-preserving centralization)', () => {
  assert.equal(checkMark('ok'), '✔');
  assert.equal(checkMark('warn'), '⚠');
  assert.equal(checkMark('fail'), '✘');
  assert.equal(checkMark('nonsense'), '?');
});

test('severityLabel gives a one-line description for notify tune', () => {
  assert.match(severityLabel('critical'), /now/i);
  assert.equal(severityLabel('made-up'), 'made-up');
});
