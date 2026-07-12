/**
 * Unit tests for Phase 10E (projectIntelligence) and 10I (selfImprovement)
 * — recommendation generation over injected read-only state. Both modules
 * must only ever RECOMMEND; nothing here has side effects to assert
 * against, which is exactly the point.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectIntelligence } from '../src/intelligence/projectIntelligence.js';
import { SelfImprovement } from '../src/intelligence/selfImprovement.js';
import { silentLogger } from '../src/infra/logger.js';

/** Deep-merged fake collaborators with sensible empty defaults. */
function intelligence(overrides = {}) {
  return new ProjectIntelligence({
    configManager: { getProject: () => ({ name: 'proj' }) },
    sessionManager: { getActiveSession: () => null },
    taskQueue: { load: () => null },
    memoryStore: { load: () => null },
    ledger: { recent: () => [] },
    agentRegistry: null,
    agentHealth: null,
    approvalStore: { pending: () => [] },
    lifecycle: { get: () => null },
    logger: silentLogger,
    ...overrides,
  });
}

test('a healthy idle project recommends the next ready backlog item', () => {
  const analysis = intelligence({
    taskQueue: {
      load: () => ({
        currentIndex: 0,
        tasks: [
          { id: 'T1', objective: 'build the API', state: 'pending', dependsOn: [] },
          { id: 'T2', objective: 'docs', state: 'pending', dependsOn: ['T1'] },
        ],
      }),
    },
  }).analyze('proj');

  assert.equal(analysis.health.level, 'healthy');
  assert.equal(analysis.running, false);
  assert.deepEqual(analysis.nextWorkItem, { taskId: 'T1', objective: 'build the API' });
  const next = analysis.recommendations.find((r) => r.type === 'next-work');
  assert.match(next.title, /T1/);
  // The dependency-stalled task is explained, not actionable.
  const stalled = analysis.recommendations.find((r) => r.type === 'dependency');
  assert.match(stalled.title, /T2.*waiting on T1/);
});

test('a running mission says so and recommends waiting', () => {
  const analysis = intelligence({
    sessionManager: { getActiveSession: () => ({ id: 's1', state: 'running' }) },
  }).analyze('proj');
  assert.equal(analysis.running, true);
  assert.ok(analysis.recommendations.some((r) => r.type === 'wait'));
});

test('blocked task + unresolved failures + no-progress streak drop health and recommend action', () => {
  const analysis = intelligence({
    taskQueue: {
      load: () => ({
        currentIndex: 0,
        tasks: [{
          id: 'T1', state: 'blocked', dependsOn: [],
          checkpoint: { summary: 'permission denied' },
        }],
      }),
    },
    memoryStore: {
      load: () => ({
        failures: [
          { id: 1, resolved: false }, { id: 2, resolved: false }, { id: 3, resolved: true },
        ],
      }),
    },
    ledger: {
      recent: () => Array.from({ length: 8 }, () => ({ progressed: false, cause: 'completed' })),
    },
  }).analyze('proj');

  assert.notEqual(analysis.health.level, 'healthy');
  assert.ok(analysis.recommendations.some((r) => r.type === 'unblock' && /retry or skip/.test(r.title)));
  assert.ok(analysis.recommendations.some((r) => r.type === 'failures'));
  assert.ok(analysis.recommendations.some((r) => r.type === 'pause'), 'no-progress streak → pause');
});

test('aging pending approvals surface as high-priority recommendations', () => {
  const analysis = intelligence({
    approvalStore: {
      pending: () => [{
        id: 'A7', category: 'secrets',
        createdAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      }],
    },
  }).analyze('proj');
  const rec = analysis.recommendations.find((r) => r.type === 'approval');
  assert.equal(rec.priority, 'high');
  assert.match(rec.detail, /approvals approve A7/);
});

// ── self-improvement ──────────────────────────────────────────────────────

function improvement(overrides = {}) {
  return new SelfImprovement({
    listProjects: () => ['proj'],
    ledger: { recent: () => [] },
    memoryStore: { load: () => null },
    taskQueue: { load: () => null },
    agentHealth: null,
    approvalStore: null,
    logger: silentLogger,
    ...overrides,
  });
}

test('recurring failure categories become high-priority recommendations', () => {
  const analysis = improvement({
    memoryStore: {
      load: () => ({
        failures: [
          { category: 'permission-denied', reason: 'no write access', resolved: false },
          { category: 'permission-denied', reason: 'no write access again', resolved: false },
          { category: 'network', reason: 'one-off', resolved: true },
        ],
      }),
    },
  }).analyze();

  assert.equal(analysis.findings.recurringFailures.length, 1);
  const rec = analysis.recommendations.find((r) => r.type === 'recurring-failure');
  assert.match(rec.title, /permission-denied.*2×/);
});

test('agent stats yield successful-strategy and slow-agent findings', () => {
  const analysis = improvement({
    agentHealth: {
      load: () => ({
        star: { agentId: 'star', tasksDone: 5, tasksFailed: 0, tasksBlocked: 0, totalAttempts: 6, totalRuns: 6, totalRunMs: 60000 },
        slow: { agentId: 'slow', tasksDone: 2, tasksFailed: 1, tasksBlocked: 0, totalAttempts: 9, totalRuns: 9, totalRunMs: 90000 },
      }),
    },
  }).analyze();

  assert.ok(analysis.recommendations.some((r) => r.type === 'successful-strategy' && /star/.test(r.title)));
  assert.ok(analysis.recommendations.some((r) => r.type === 'slow-agent' && /slow/.test(r.title)));
});

test('verifier failure concentration becomes a bottleneck finding', () => {
  const analysis = improvement({
    taskQueue: {
      load: () => ({
        tasks: [
          { checkpoint: { verify: { results: [{ type: 'lint', passed: false, detail: '' }] } } },
          { checkpoint: { verify: { results: [{ type: 'lint', passed: false, detail: '' }] } } },
          { checkpoint: { verify: { results: [{ type: 'lint', passed: false, detail: '' }] } } },
          { checkpoint: { verify: { results: [{ type: 'file-exists', passed: true, detail: '' }] } } },
        ],
      }),
    },
  }).analyze();
  const rec = analysis.recommendations.find((r) => r.type === 'verification-bottleneck');
  assert.match(rec.title, /"lint" fails 3\/3/);
});

test('an always-approved category suggests automating it', () => {
  const analysis = improvement({
    approvalStore: {
      list: () => [
        { category: 'commit', status: 'approved' },
        { category: 'commit', status: 'approved' },
        { category: 'commit', status: 'approved' },
      ],
    },
  }).analyze();
  const rec = analysis.recommendations.find((r) => r.type === 'approval-pattern');
  assert.match(rec.title, /always approve "commit"/);
  assert.match(rec.detail, /automaticCategories|autonomous/);
});

test('with no history there are simply no recommendations (no fabrication)', () => {
  const analysis = improvement().analyze();
  assert.deepEqual(analysis.recommendations, []);
});
