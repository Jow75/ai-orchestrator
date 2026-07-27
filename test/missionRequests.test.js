/**
 * Unit tests for operator/missionRequests.js — Phase 12 M2 Priority 3.
 *
 * The security requirement this store exists to satisfy is stated in
 * PHASE_12_PLAN.md §6: **no free text may implicitly start work.** So the
 * behaviours pinned here are the ones that keep a sentence from becoming a
 * commit without a decision in between — a created request is inert, a
 * decision is once-only, and a proposal the owner ignored expires rather than
 * lying in wait.
 *
 * The prompt renderer is tested too, because it is what routes an approved
 * mission into Phase 10's plan gate: without the plan marker in the prompt,
 * the SECOND approval (the one that carries real estimates) never happens.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import MissionRequestStore, {
  renderMissionPrompt, MAX_OBJECTIVE_CHARS,
} from '../src/operator/missionRequests.js';
import { silentLogger } from '../src/infra/logger.js';

function store(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-missions-'));
  return {
    dir,
    store: new MissionRequestStore({
      requestsFile: path.join(dir, 'missions.json'),
      promptsDir: path.join(dir, 'prompts'),
      logger: silentLogger,
      ...options,
    }),
  };
}

test('a created request is PROPOSED and starts nothing', () => {
  const { store: s } = store();
  const request = s.create({
    project: 'Remote Work', objective: 'Build a payroll dashboard.',
    by: 'moses', via: 'telegram',
  });

  assert.equal(request.id, 'M1');
  assert.equal(request.status, 'proposed');
  assert.equal(request.startedAt, null, 'nothing has run');
  assert.equal(request.taskId, null, 'nothing is queued');
  assert.equal(request.promptFile, null, 'not even a prompt exists yet');
});

test('ids increment across requests and survive a restart', () => {
  const { dir, store: s } = store();
  s.create({ project: 'a', objective: 'first objective here' });
  s.create({ project: 'a', objective: 'second objective here' });

  const reopened = new MissionRequestStore({
    requestsFile: path.join(dir, 'missions.json'),
    promptsDir: path.join(dir, 'prompts'),
    logger: silentLogger,
  });
  assert.equal(reopened.create({ project: 'a', objective: 'third objective here' }).id, 'M3');
});

test('an objective is capped so one paste cannot become an unbounded prompt', () => {
  const { store: s } = store();
  const request = s.create({ project: 'a', objective: 'x'.repeat(MAX_OBJECTIVE_CHARS + 500) });

  assert.equal(request.objective.length, MAX_OBJECTIVE_CHARS);
});

test('a decision is once-only', () => {
  const { store: s } = store();
  const request = s.create({ project: 'a', objective: 'do the thing properly' });

  assert.equal(s.decide(request.id, { decision: 'approved', by: 'moses' }).ok, true);
  const second = s.decide(request.id, { decision: 'rejected', by: 'moses' });

  assert.equal(second.ok, false);
  assert.match(second.reason, /already approved/);
});

test('an unknown id and an unknown decision are both refused', () => {
  const { store: s } = store();
  assert.equal(s.decide('M99', { decision: 'approved' }).ok, false);

  const request = s.create({ project: 'a', objective: 'do the thing properly' });
  assert.equal(s.decide(request.id, { decision: 'obliterate' }).ok, false);
});

test('a proposal the owner never answered expires instead of waiting forever', () => {
  const { store: s } = store({ ttlMs: 1_000 });
  const request = s.create({ project: 'a', objective: 'something raised long ago' });

  // Rewrite its creation time to be older than the TTL.
  s.update(request.id, { createdAt: new Date(Date.now() - 5_000).toISOString() });
  const expired = s.expireStale();

  assert.equal(expired.length, 1);
  assert.equal(s.get(request.id).status, 'expired');
  assert.equal(s.decide(request.id, { decision: 'approved' }).ok, false, 'and cannot be approved late');
});

test('open() lists only undecided requests, newest first, and filters by project', () => {
  const { store: s } = store();
  const first = s.create({ project: 'alpha', objective: 'the first objective' });
  s.create({ project: 'alpha', objective: 'the second objective' });
  s.create({ project: 'beta', objective: 'a different project entirely' });
  s.decide(first.id, { decision: 'rejected' });

  const open = s.open();
  assert.equal(open.length, 2);
  assert.equal(open[0].project, 'beta', 'newest first');
  assert.equal(s.open('alpha').length, 1);
});

test('an approved request writes a real prompt file with the plan gate in it', () => {
  const { store: s } = store();
  const request = s.create({ project: 'Remote Work', objective: 'Build a payroll dashboard.' });

  const file = s.writePrompt(request, {
    planMarker: 'IMPLEMENTATION PLAN READY',
    completionMarker: 'MISSION COMPLETE',
  });
  const text = fs.readFileSync(file, 'utf8');

  assert.ok(path.isAbsolute(file));
  assert.ok(fs.existsSync(file));
  assert.match(text, /Build a payroll dashboard\./, 'the objective, verbatim');
  assert.match(text, /IMPLEMENTATION PLAN READY/, 'routes into the Phase 10 plan gate');
  assert.match(text, /MISSION COMPLETE/, 'and can actually finish');
});

test('the prompt is written under state/, never inside the project being worked on', () => {
  const { dir, store: s } = store();
  const request = s.create({ project: 'a', objective: 'do the thing properly' });

  const file = s.writePrompt(request, { planMarker: 'PLAN', completionMarker: 'DONE' });

  assert.ok(file.startsWith(path.join(dir, 'prompts')),
    'a message typed on a phone must not drop an untracked file into a repo');
});

test('the rendered prompt asks for exactly the estimates the plan gate extracts', () => {
  const text = renderMissionPrompt(
    { id: 'M3', project: 'alpha', objective: 'Add CSV export' },
    { planMarker: 'PLAN READY', completionMarker: 'ALL DONE' }
  );

  // These labels are what approvals/implementationSummary.js reads back out.
  for (const label of ['Objective:', 'Tasks:', 'Files:', 'Risks:', 'Estimated duration:', 'Estimated files changed:']) {
    assert.ok(text.includes(label), `the agent is asked for "${label}"`);
  }
});

test('with no requests file every method is a safe no-op', () => {
  const s = new MissionRequestStore({ logger: silentLogger });

  assert.equal(s.create({ project: 'a', objective: 'x' }), null);
  assert.deepEqual(s.open(), []);
  assert.equal(s.get('M1'), null);
});
