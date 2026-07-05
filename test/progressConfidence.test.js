/**
 * Tests for progress confidence scoring.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessConfidence, Confidence } from '../src/progress/progressConfidence.js';

test('git commit is highest confidence', () => {
  const c = assessConfidence({ progressed: true, method: 'git', detail: { dirty: 0 } });
  assert.equal(c.level, Confidence.HIGH);
  assert.ok(c.signals.includes('git-commit'));
  assert.ok(c.score >= 0.9);
});

test('git dirty-file change is high confidence', () => {
  const c = assessConfidence({ progressed: true, method: 'git', detail: { dirty: 3 } });
  assert.equal(c.level, Confidence.HIGH);
  assert.ok(c.signals.includes('workspace-changed'));
});

test('filescan change is medium confidence', () => {
  const c = assessConfidence({ progressed: true, method: 'filescan' });
  assert.equal(c.level, Confidence.MEDIUM);
});

test('unmeasurable workspace is low confidence', () => {
  const c = assessConfidence({ progressed: false, method: 'none' });
  assert.equal(c.level, Confidence.LOW);
  assert.ok(c.signals.includes('unmeasurable'));
});

test('extra verification signals raise the score', () => {
  const withoutTests = assessConfidence({ progressed: true, method: 'filescan' });
  const withTests = assessConfidence({
    progressed: true, method: 'filescan', extraSignals: ['tests-passed', 'verified'],
  });
  assert.ok(withTests.score > withoutTests.score);
  assert.ok(withTests.signals.includes('tests-passed'));
});

test('score is always within [0,1]', () => {
  const c = assessConfidence({
    progressed: true, method: 'git', detail: { dirty: 0 },
    extraSignals: ['tests-passed', 'build-ok', 'verified'],
  });
  assert.ok(c.score >= 0 && c.score <= 1);
});
