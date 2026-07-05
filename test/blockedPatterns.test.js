/**
 * Tests for blocked-state detection — the fast path that would have stopped
 * the overnight incident on run #1.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectBlockedState } from '../src/core/blockedPatterns.js';

test('detects the real Claude Code permission-denial phrasing', () => {
  // The exact shape seen 1,203 times in the incident transcript.
  const text =
    'I requested permissions to write to C:\\Users\\Admin\\project\\hello.txt, ' +
    "but you haven't granted it yet.";
  const result = detectBlockedState(text);
  assert.equal(result.blocked, true);
  assert.equal(result.category, 'permission-denied');
  assert.ok(result.hint.includes('permissionMode'));
  assert.ok(result.evidence.length > 0);
});

test('detects "I do not have access to"', () => {
  const result = detectBlockedState('Sorry, I do not have access to that directory.');
  assert.equal(result.blocked, true);
  assert.equal(result.category, 'no-access');
});

test('detects "cannot proceed without"', () => {
  const result = detectBlockedState('I cannot proceed without the database credentials.');
  assert.equal(result.blocked, true);
  assert.equal(result.category, 'cannot-proceed');
});

test('detects awaiting interactive input', () => {
  const result = detectBlockedState('I am waiting for your confirmation before continuing.');
  assert.equal(result.blocked, true);
  assert.equal(result.category, 'awaiting-input');
});

test('does NOT flag benign mentions of the word permission', () => {
  const text =
    'I updated the file permissions module and added a test for the access-control layer. ' +
    'MISSION COMPLETE';
  assert.equal(detectBlockedState(text).blocked, false);
});

test('does NOT flag normal successful work', () => {
  const text = 'Created src/index.js, ran the tests (all passing), and committed the change.';
  assert.equal(detectBlockedState(text).blocked, false);
});

test('handles empty / null input safely', () => {
  assert.equal(detectBlockedState('').blocked, false);
  assert.equal(detectBlockedState(undefined).blocked, false);
});
