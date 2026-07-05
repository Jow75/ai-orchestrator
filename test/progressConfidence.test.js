/**
 * Tests for progress confidence scoring.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessConfidence, Confidence } from '../src/progress/progressConfidence.js';

test('git commit is highest confidence', () => {
  // Callers (e.g. progressEngine.js) supply 'git-commit' via extraSignals
  // once they've confirmed a real commit — assessConfidence never infers
  // it from `detail` itself (see the module docstring for why).
  const c = assessConfidence({ progressed: true, method: 'git', extraSignals: ['git-commit'] });
  assert.equal(c.level, Confidence.HIGH);
  assert.ok(c.signals.includes('git-commit'));
  assert.ok(c.score >= 0.9);
});

test('git dirty-file change (no commit signal) is still high confidence', () => {
  const c = assessConfidence({ progressed: true, method: 'git' });
  assert.equal(c.level, Confidence.HIGH);
  assert.ok(c.signals.includes('workspace-changed'));
});

test('a method combining git + filesystem scan is still treated as git-tier', () => {
  // progressEngine.js reports 'git+scan' (git-aware AND catches
  // .gitignore'd work) — this must not silently fall to the lowest tier.
  const c = assessConfidence({ progressed: true, method: 'git+scan' });
  assert.equal(c.level, Confidence.HIGH);
  assert.ok(c.signals.includes('git'));
});

test('filescan change is medium confidence', () => {
  const c = assessConfidence({ progressed: true, method: 'filescan' });
  assert.equal(c.level, Confidence.MEDIUM);
});

test('a plain scan method (no git) is treated as filescan-tier', () => {
  const c = assessConfidence({ progressed: true, method: 'scan' });
  assert.equal(c.level, Confidence.MEDIUM);
  assert.ok(c.signals.includes('filescan'));
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
    progressed: true, method: 'git',
    extraSignals: ['git-commit', 'tests-passed', 'build-ok', 'verified'],
  });
  assert.ok(c.score >= 0 && c.score <= 1);
});
