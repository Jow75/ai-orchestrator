/**
 * Unit tests for approvalPolicy.js — category classification and the
 * operating-mode decision table (Phase 10A/10B). Pure logic.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyCategory, decide, effectiveApprovalConfig, isKnownMode, PLAN_CATEGORY,
} from '../src/approvals/approvalPolicy.js';
import { ORCHESTRATOR_DEFAULTS } from '../src/config/defaults.js';

const CONFIG = ORCHESTRATOR_DEFAULTS.approvals;

test('classifies the default category lists into their classes', () => {
  assert.equal(classifyCategory('tests', CONFIG), 'automatic');
  assert.equal(classifyCategory('documentation', CONFIG), 'automatic');
  assert.equal(classifyCategory('production-deployment', CONFIG), 'owner-gate');
  assert.equal(classifyCategory('secrets', CONFIG), 'owner-gate');
  assert.equal(classifyCategory('captcha', CONFIG), 'human-action');
  assert.equal(classifyCategory('authentication', CONFIG), 'human-action');
  assert.equal(classifyCategory(PLAN_CATEGORY, CONFIG), 'implementation-review');
});

test('an unknown category FAILS CLOSED to owner-gate', () => {
  assert.equal(classifyCategory('launch-the-rockets', CONFIG), 'owner-gate');
  assert.equal(classifyCategory('', CONFIG), 'owner-gate');
});

test('category lists are configurable (a moved category changes class)', () => {
  const custom = { ...CONFIG, automaticCategories: ['deploy-staging'] };
  assert.equal(classifyCategory('deploy-staging', custom), 'automatic');
  // And a category promoted to owner-gate wins over automatic.
  const gated = {
    ...CONFIG,
    automaticCategories: ['tests'],
    ownerGateCategories: [...CONFIG.ownerGateCategories, 'tests'],
  };
  assert.equal(classifyCategory('tests', gated), 'owner-gate');
});

test('decision table: balanced (the default)', () => {
  assert.equal(decide({ approvalClass: 'automatic', mode: 'balanced' }).requiresApproval, false);
  assert.equal(decide({ approvalClass: 'implementation-review', mode: 'balanced' }).requiresApproval, true);
  assert.equal(decide({ approvalClass: 'owner-gate', mode: 'balanced' }).requiresApproval, true);
  assert.equal(decide({ approvalClass: 'human-action', mode: 'balanced' }).requiresApproval, true);
});

test('decision table: conservative requires approval for everything', () => {
  for (const approvalClass of ['automatic', 'implementation-review', 'owner-gate', 'human-action']) {
    assert.equal(decide({ approvalClass, mode: 'conservative' }).requiresApproval, true);
  }
});

test('decision table: autonomous pauses ONLY owner gates and human actions', () => {
  assert.equal(decide({ approvalClass: 'automatic', mode: 'autonomous' }).requiresApproval, false);
  assert.equal(decide({ approvalClass: 'implementation-review', mode: 'autonomous' }).requiresApproval, false);
  assert.equal(decide({ approvalClass: 'owner-gate', mode: 'autonomous' }).requiresApproval, true);
  assert.equal(decide({ approvalClass: 'human-action', mode: 'autonomous' }).requiresApproval, true);
});

test('an unknown mode falls back to balanced', () => {
  assert.equal(decide({ approvalClass: 'automatic', mode: 'wild-west' }).requiresApproval, false);
  assert.equal(decide({ approvalClass: 'implementation-review', mode: 'wild-west' }).requiresApproval, true);
  assert.equal(isKnownMode('wild-west'), false);
});

test('effectiveApprovalConfig: a project overrides mode per key, not wholesale', () => {
  const effective = effectiveApprovalConfig(CONFIG, { approvals: { mode: 'autonomous' } });
  assert.equal(effective.mode, 'autonomous');
  // Untouched keys still come from the global config.
  assert.deepEqual(effective.ownerGateCategories, CONFIG.ownerGateCategories);
  // No project → global as-is.
  assert.equal(effectiveApprovalConfig(CONFIG).mode, 'balanced');
});
