/**
 * Tests for the Phase P4 Continuation Builder: turning orchestrator state
 * into a structured briefing instead of a bare "Continue." The headline
 * property under test is that a failed verification's SPECIFIC reason
 * shows up in the next prompt, not just a generic retry notice.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLegacyContinuation, buildTaskContinuation } from '../src/briefing/continuationBuilder.js';

const PROJECT = { name: 'demo', mission: { completionMarker: 'MISSION COMPLETE' } };

test('buildLegacyContinuation: includes the project name and the reason', () => {
  const prompt = buildLegacyContinuation({ project: PROJECT, reason: 'usage limit reset; resuming' });
  assert.match(prompt, /demo/);
  assert.match(prompt, /usage limit reset; resuming/);
  assert.match(prompt, /MISSION COMPLETE/);
});

test('buildLegacyContinuation: surfaces recent ledger activity when present', () => {
  const prompt = buildLegacyContinuation({
    project: PROJECT,
    reason: 'continuing mission',
    recentRuns: [
      { exitReason: 'progress', resultText: 'Created src/index.js' },
      { exitReason: 'no_progress', resultText: 'Still investigating the issue' },
    ],
  });
  assert.match(prompt, /Recent activity/);
  assert.match(prompt, /Created src\/index\.js/);
  assert.match(prompt, /Still investigating the issue/);
});

test('buildLegacyContinuation: omits the activity section when there is none', () => {
  const prompt = buildLegacyContinuation({ project: PROJECT, reason: 'continuing mission', recentRuns: [] });
  assert.doesNotMatch(prompt, /Recent activity/);
});

const QUEUE = {
  tasks: [
    { id: 'T1', objective: 'Scaffold', state: 'done' },
    { id: 'T2', objective: 'Implement feature', state: 'active', attempts: 2, verify: [{ type: 'file-exists', path: 'src/feature.js' }] },
    { id: 'T3', objective: 'Write tests', state: 'pending' },
  ],
};

test('buildTaskContinuation: names the current task and its objective', () => {
  const prompt = buildTaskContinuation({
    project: PROJECT, queue: QUEUE, task: QUEUE.tasks[1], reason: 'retrying task',
  });
  assert.match(prompt, /Current task: T2/);
  assert.match(prompt, /Implement feature/);
});

test('buildTaskContinuation: lists completed tasks as "do NOT redo"', () => {
  const prompt = buildTaskContinuation({
    project: PROJECT, queue: QUEUE, task: QUEUE.tasks[1], reason: 'retrying task',
  });
  assert.match(prompt, /do NOT redo/);
  assert.match(prompt, /T1: Scaffold/);
});

test('buildTaskContinuation: lists remaining tasks after the current one', () => {
  const prompt = buildTaskContinuation({
    project: PROJECT, queue: QUEUE, task: QUEUE.tasks[1], reason: 'retrying task',
  });
  assert.match(prompt, /Remaining tasks/);
  assert.match(prompt, /T3: Write tests/);
  assert.doesNotMatch(prompt, /T3.*T3/s); // not duplicated
});

test('buildTaskContinuation: THE HEADLINE FEATURE — names exactly which check failed and why', () => {
  const task = {
    ...QUEUE.tasks[1],
    lastVerifyResult: {
      passed: false,
      results: [
        { type: 'file-exists', passed: false, detail: 'Not found: src/feature.js' },
        { type: 'command', passed: true, detail: '"npm test" exited 0' },
      ],
    },
  };
  const prompt = buildTaskContinuation({
    project: PROJECT, queue: { tasks: [QUEUE.tasks[0], task, QUEUE.tasks[2]] }, task, reason: 'retrying task',
  });
  assert.match(prompt, /was NOT accepted/);
  assert.match(prompt, /file-exists.*failed: Not found: src\/feature\.js/);
  // The PASSING check must not be listed as a failure reason.
  assert.doesNotMatch(prompt, /command.*failed/);
});

test('buildTaskContinuation: omits the "not accepted" section when there is no failed verify yet', () => {
  const prompt = buildTaskContinuation({
    project: PROJECT, queue: QUEUE, task: QUEUE.tasks[1], reason: 'retrying task',
  });
  assert.doesNotMatch(prompt, /was NOT accepted/);
});

test('buildTaskContinuation: lists the verifiers that must pass', () => {
  const prompt = buildTaskContinuation({
    project: PROJECT, queue: QUEUE, task: QUEUE.tasks[1], reason: 'retrying task',
  });
  assert.match(prompt, /checks pass/);
  assert.match(prompt, /file exists: `src\/feature\.js`/);
});

test('buildTaskContinuation: a task with no verifiers falls back to the marker instruction', () => {
  const task = { id: 'T4', objective: 'Just talk', state: 'active', attempts: 1, verify: [] };
  const prompt = buildTaskContinuation({
    project: PROJECT, queue: { tasks: [task] }, task, reason: 'retrying task',
  });
  assert.match(prompt, /no automated checks/);
  assert.match(prompt, /MISSION COMPLETE/);
});

test('buildTaskContinuation: works when the task is first in the queue (no completed tasks)', () => {
  const solo = { id: 'T1', objective: 'first', state: 'active', attempts: 1, verify: [] };
  const prompt = buildTaskContinuation({
    project: PROJECT, queue: { tasks: [solo] }, task: solo, reason: 'retrying task',
  });
  assert.doesNotMatch(prompt, /do NOT redo/);
  assert.doesNotMatch(prompt, /Remaining tasks/);
});

// ── Phase P5: cross-session memory folded into the briefing ────────────────

test('buildLegacyContinuation: surfaces operator notes and unresolved failures when present', () => {
  const prompt = buildLegacyContinuation({
    project: PROJECT,
    reason: 'continuing mission',
    memoryNotes: [{ category: 'architecture', text: 'build via npm run build' }],
    activeFailures: [{ reason: 'agent lacks network access', hint: 'grant it', taskId: null }],
  });
  assert.match(prompt, /Project memory/);
  assert.match(prompt, /\[architecture\]\*\* build via npm run build/);
  assert.match(prompt, /Known problems/);
  assert.match(prompt, /agent lacks network access/);
});

test('buildLegacyContinuation: omits memory sections when none is supplied', () => {
  const prompt = buildLegacyContinuation({ project: PROJECT, reason: 'continuing mission' });
  assert.doesNotMatch(prompt, /Project memory/);
  assert.doesNotMatch(prompt, /Known problems/);
});

test('buildTaskContinuation: surfaces prior attempts on this task id from an earlier, superseded plan', () => {
  const prompt = buildTaskContinuation({
    project: PROJECT, queue: QUEUE, task: QUEUE.tasks[1], reason: 'retrying task',
    priorAttempts: [
      { taskId: 'T2', outcome: 'failed', attempts: 3, summary: 'ran out of retries on an old prompt' },
    ],
  });
  assert.match(prompt, /attempted before, under an earlier version of this plan/);
  assert.match(prompt, /Ended \*\*failed\*\* after 3 attempt\(s\): ran out of retries on an old prompt/);
});

test('buildTaskContinuation: omits the prior-attempts section when there is no archived history', () => {
  const prompt = buildTaskContinuation({
    project: PROJECT, queue: QUEUE, task: QUEUE.tasks[1], reason: 'retrying task',
  });
  assert.doesNotMatch(prompt, /attempted before/);
});

test('buildTaskContinuation: a task-scoped unresolved failure names the task, not "the mission"', () => {
  const prompt = buildTaskContinuation({
    project: PROJECT, queue: QUEUE, task: QUEUE.tasks[1], reason: 'retrying task',
    activeFailures: [{ reason: 'flaky test suite', hint: null, taskId: 'T2' }],
  });
  assert.match(prompt, /\(task "T2"\) flaky test suite/);
});
