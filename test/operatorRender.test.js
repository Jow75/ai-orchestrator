/**
 * Tests for operator/render.js — Phase 12 M2.
 *
 * These renderers are the whole product from the owner's side: on a phone,
 * what the system CAN do matters less than whether the answer fits on a screen
 * and says something true. Two properties get the most attention:
 *
 *  - nothing unknown is dressed up (a project that never ran says "never", not
 *    a plausible-looking timestamp; a mission proposal shows no invented
 *    estimates);
 *  - /help is generated from the grammar, so it can never drift from what the
 *    parser actually accepts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  relativeTime, renderProjectList, renderProjectDetail, renderTasks, renderApprovals,
  renderMissionProposal, renderMissionRequests, renderEvents, renderConfirmation,
  renderPhaseUpdate, renderHelp, renderScanResults, truncate,
} from '../src/operator/render.js';
import { COMMANDS } from '../src/operator/commandGrammar.js';

const NOW = Date.parse('2026-07-27T12:00:00Z');

test('relative time says "never" rather than inventing a plausible timestamp', () => {
  assert.equal(relativeTime(null, NOW), 'never');
  assert.equal(relativeTime(undefined, NOW), 'never');
  assert.equal(relativeTime('not a date', NOW), 'unknown');
  assert.equal(relativeTime('2026-07-27T11:58:00Z', NOW), '2m 0s ago');
  assert.equal(relativeTime('2026-07-27T09:00:00Z', NOW), '3h 0m ago');
  assert.equal(relativeTime('2026-07-27T12:00:30Z', NOW), 'just now', 'a future stamp is not negative time');
});

test('the project list leads with status and says what is selected', () => {
  const text = renderProjectList([
    { name: 'alpha', status: 'waiting-approval', tasks: { done: 1, total: 3 }, git: { branch: 'main' } },
    { name: 'beta', status: 'idle' },
  ], { active: 'beta' });

  assert.match(text, /Projects \(2\)/);
  assert.match(text, /alpha/);
  assert.match(text, /Waiting for you/);
  assert.match(text, /1\/3 tasks/);
  assert.match(text, /▸ .*beta/, 'the active project is marked');
  assert.match(text, /Active: beta/);
});

test('an empty project list tells the owner exactly how to fix it', () => {
  const text = renderProjectList([], {});

  assert.match(text, /No projects are defined/);
  assert.match(text, /projects add --interactive/);
});

test('project detail reports real git facts and no invented ones', () => {
  const withRepo = renderProjectDetail({
    name: 'alpha', status: 'running', description: 'The alpha project.',
    lifecycle: 'executing', path: 'C:/work/alpha',
    tasks: { done: 1, total: 3, current: 'T2', currentState: 'active' },
    worker: { pid: 4242, startedAt: '2026-07-27T11:30:00Z' },
    git: { branch: 'payroll', commit: 'abc123def456', subject: 'add export', dirty: true },
    lastActivity: '2026-07-27T11:58:00Z',
    health: { level: 'healthy', score: 92 },
  }, { now: NOW });

  assert.match(withRepo, /Coding/);
  assert.match(withRepo, /Tasks: 1\/3 done \(current: T2, active\)/);
  assert.match(withRepo, /Branch: payroll \(uncommitted changes\)/);
  assert.match(withRepo, /Commit: abc123def456 — add export/);
  assert.match(withRepo, /Health: Healthy \(92\/100\)/);

  const withoutRepo = renderProjectDetail({ name: 'plain', status: 'idle', path: 'C:/work/plain' }, { now: NOW });
  assert.match(withoutRepo, /not a git repository/);
  assert.match(withoutRepo, /Last activity: never/);
});

test('a misconfigured project renders the actual problem', () => {
  const text = renderProjectDetail({
    name: 'broken', status: 'misconfigured', problem: '"workingDirectory" does not exist: C:/gone',
  });

  assert.match(text, /configuration problem/);
  assert.match(text, /C:\/gone/);
});

test('a missing project renders as a distinct, less alarming situation than misconfigured', () => {
  const text = renderProjectDetail({ name: 'gone', status: 'missing', path: 'C:/old/place' });

  assert.match(text, /folder not found/);
  assert.match(text, /C:\/old\/place/);
  assert.doesNotMatch(text, /configuration problem/);
});

// ── renderScanResults (Phase 13 M2) ─────────────────────────────────────────

test('renderScanResults reports "no roots configured" without pretending to have scanned', () => {
  const text = renderScanResults({ candidates: [], rootsScanned: [], rootsMissing: [] }, { roots: [] });
  assert.match(text, /No project roots are configured/);
});

test('renderScanResults reports zero-candidate and found-candidate cases distinctly', () => {
  const empty = renderScanResults(
    { candidates: [], rootsScanned: ['C:/Users/Admin/Music'], rootsMissing: [] },
    { roots: ['C:/Users/Admin/Music'] }
  );
  assert.match(empty, /No new projects found/);

  const found = renderScanResults(
    {
      candidates: [{ name: 'calc', path: 'C:/Users/Admin/Music/calc' }],
      rootsScanned: ['C:/Users/Admin/Music'], rootsMissing: [],
    },
    { roots: ['C:/Users/Admin/Music'] }
  );
  assert.match(found, /Found 1 new project/);
  assert.match(found, /calc — C:\/Users\/Admin\/Music\/calc/);
  assert.match(found, /\/import <path>/);
});

test('renderScanResults surfaces a configured root that does not exist on disk', () => {
  const text = renderScanResults(
    { candidates: [], rootsScanned: [], rootsMissing: ['D:/gone'] },
    { roots: ['D:/gone'] }
  );
  assert.match(text, /Not found on disk: D:\/gone/);
});

test('pending approvals are surfaced with the exact reply to send', () => {
  const text = renderProjectDetail({
    name: 'alpha', status: 'waiting-approval',
    pendingApprovals: [{ id: 'A7', title: 'Plan review', category: 'implementation-plan' }],
  }, { now: NOW });

  assert.match(text, /Waiting on you \(1\)/);
  assert.match(text, /A7 — Plan review/);
  assert.match(text, /Reply: APPROVE A7/);
});

test('the approvals list distinguishes a human action from a decision', () => {
  const text = renderApprovals([
    { id: 'A7', project: 'alpha', title: 'Plan review', approvalClass: 'review' },
    { id: 'A8', project: 'beta', title: 'Log in to the portal', approvalClass: 'human-action' },
  ]);

  assert.match(text, /Reply: APPROVE A7 · REJECT A7/);
  assert.match(text, /Reply: DONE A8/);
  assert.equal(renderApprovals([]), 'Nothing is waiting for your decision.');
});

test('the approvals list badges only the projects it was told are simulated', () => {
  const requests = [
    { id: 'A7', project: 'sandbox', title: 'Plan review', approvalClass: 'review' },
    { id: 'A8', project: 'alpha', title: 'Plan review', approvalClass: 'review' },
  ];

  const badged = renderApprovals(requests, { simulated: new Set(['sandbox']) });
  assert.match(badged, /A7 · sandbox {2}🧪 SIMULATED/);
  assert.match(badged, /A8 · alpha\n/, 'a real project stays clean');

  assert.doesNotMatch(renderApprovals(requests), /SIMULATED/,
    'no set supplied ⇒ no badges, so every pre-existing caller is unchanged');
});

test('the mission-request list badges from the live set, not the frozen context', () => {
  const stale = [{
    id: 'M1', project: 'alpha', status: 'pending', objective: 'Build a calculator.',
    context: { simulated: true },
  }];

  assert.doesNotMatch(renderMissionRequests(stale, { simulated: new Set() }), /SIMULATED/,
    'the project is real now, whatever the request recorded when it was raised');
  assert.match(renderMissionRequests(stale), /SIMULATED/,
    'with no set, the recorded context is still better than nothing');
  assert.match(
    renderMissionRequests([{ id: 'M2', project: 'sandbox', status: 'pending', objective: 'x' }],
      { simulated: new Set(['sandbox']) }),
    /M2 · sandbox {2}🧪 SIMULATED/
  );
});

test('the task list marks where the queue actually is', () => {
  const text = renderTasks('alpha', {
    currentIndex: 1,
    tasks: [
      { id: 'T1', state: 'done', objective: 'first thing', attempts: 1 },
      { id: 'T2', state: 'active', objective: 'second thing', attempts: 2 },
    ],
  });

  assert.match(text, /alpha — tasks \(1\/2\)/);
  assert.match(text, /▸ T2 \[active\]/);
  assert.match(text, /2 attempts/);
  assert.match(renderTasks('beta', null), /no task queue yet/);
});

test('the mission proposal shows measured history and NO invented estimate', () => {
  const text = renderMissionProposal({
    id: 'M3', project: 'Remote Work', objective: 'Build a payroll dashboard.',
    context: {
      path: 'C:/work/remote', branch: 'main', dirty: false, queuedTasks: 2,
      history: { missions: 12, averageRunMs: 2_400_000, verifierPassRate: 96 },
    },
  });

  assert.match(text, /Mission M3 — Remote Work/);
  assert.match(text, /Build a payroll dashboard\./);
  assert.match(text, /Branch: main/);
  assert.match(text, /Already queued: 2 task/);
  assert.match(text, /not a prediction/, 'history is labelled as history');
  assert.match(text, /Average run: 40m 0s/);
  assert.match(text, /Verifier pass rate: 96%/);
  assert.match(text, /APPROVE M3/);
  assert.match(text, /tasks, files, duration, risks/, 'the real estimates come from the plan gate');
});

test('a proposal with no history at all still renders, without inventing one', () => {
  const text = renderMissionProposal({
    id: 'M1', project: 'brand-new', objective: 'Set up the project.', context: {},
  });

  assert.match(text, /Mission M1 — brand-new/);
  assert.doesNotMatch(text, /Average run/);
  assert.doesNotMatch(text, /pass rate/);
});

test('a phase update reports counted work, never a percentage', () => {
  const withTasks = renderPhaseUpdate({
    project: 'alpha', state: 'verifying', tasksDone: 2, tasksTotal: 5, taskId: 'T3',
  });

  assert.match(withTasks, /alpha — Testing/);
  assert.match(withTasks, /Tasks: 2\/5 done · now: T3/);
  assert.doesNotMatch(withTasks, /%/);

  const legacy = renderPhaseUpdate({ project: 'alpha', state: 'executing', tasksTotal: 0 });
  assert.match(legacy, /alpha — Coding/, 'a single-prompt mission has no counts and says nothing about them');
  assert.doesNotMatch(legacy, /Tasks:/);
});

test('the confirmation restates the action and gives one way to perform it', () => {
  const text = renderConfirmation({
    code: 'K7XM', action: 'stop', project: 'alpha',
    summary: 'Stop the mission running on alpha (pid 42).',
  });

  assert.match(text, /Confirm this action/);
  assert.match(text, /Stop the mission running on alpha \(pid 42\)\./);
  assert.match(text, /\/confirm K7XM/);
  assert.match(text, /expires on its own/);
});

test('/help is generated from the grammar, so it cannot drift from the parser', () => {
  const text = renderHelp({ active: 'alpha' });

  for (const command of COMMANDS) {
    assert.ok(text.includes(command.usage), `${command.usage} is documented`);
  }
  assert.match(text, /Typing never starts work/);
  assert.match(text, /Active project: alpha/);
  assert.match(renderHelp({}), /No project selected/);
});

test('event and mission-request lists degrade to a plain sentence when empty', () => {
  assert.equal(renderEvents([]), 'No events recorded yet.');
  assert.equal(renderMissionRequests([]), 'No mission requests are waiting.');

  const events = renderEvents([{ at: '2026-07-27T11:00:00Z', type: 'worker.started', project: 'alpha' }]);
  assert.match(events, /worker\.started alpha/);
});

test('truncation is shared, so every list clips the same way', () => {
  assert.equal(truncate('short', 20), 'short');
  assert.equal(truncate('a'.repeat(30), 10).length, 10);
  assert.ok(truncate('a'.repeat(30), 10).endsWith('…'));
});
