/**
 * Phase 10 integration tests — the real supervision loop with the Approval
 * Manager, mission lifecycle, resource locks, and the cross-agent message
 * bus wired in (all against the mock driver):
 *
 *  - an implementation plan pauses for review; the owner's APPROVE
 *    continues the same mission automatically (10A)
 *  - a human-action blocked state pauses gracefully and continues on DONE
 *    instead of terminally blocking (10A)
 *  - an owner-gated task never launches without approval; a rejection
 *    blocks the task + mission; an automatic category sails through (10A/10B)
 *  - task:verification-failed is emitted for the notification engine (10F)
 *  - the standardized lifecycle is recorded end to end (10D)
 *  - task resources wait on a conflicting cross-mission lock, then acquire
 *    and release (10H)
 *  - a task handoff to a different agent leaves a message the next agent's
 *    prompt carries (10H)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Orchestrator } from '../src/core/orchestrator.js';
import { DriverRegistry } from '../src/drivers/driverRegistry.js';
import { SessionManager } from '../src/state/sessionManager.js';
import { StatusManager } from '../src/state/statusManager.js';
import { ApprovalManager } from '../src/approvals/approvalManager.js';
import { ApprovalStore } from '../src/approvals/approvalStore.js';
import { MissionLifecycle } from '../src/mission/missionLifecycle.js';
import { ResourceLockManager } from '../src/coordination/resourceLocks.js';
import { AgentMessageBus } from '../src/coordination/agentMessages.js';
import { DEFAULT_TASK_MAX_RUNS } from '../src/mission/missionPlan.js';
import { ORCHESTRATOR_DEFAULTS } from '../src/config/defaults.js';
import { silentLogger } from '../src/infra/logger.js';

const BASE_CONFIG = {
  supervision: { statusUpdateIntervalMs: 1_000, heartbeatIntervalMs: 1_000, childProcessScanIntervalMs: 0 },
  recovery: { maxConsecutiveCrashes: 2, crashBackoffBaseMs: 10, crashBackoffMaxMs: 40, networkRetryDelayMs: 10 },
  rateLimit: { minWaitMs: 5, defaultWaitMs: 50, maxWaitMs: 500, resumeGraceMs: 0 },
  progress: { enabled: true, maxConsecutiveNoProgress: 3, interRunDelayMs: 5, blockedDetection: true },
  briefing: { enabled: true, recentRunCount: 3 },
  approvals: { ...ORCHESTRATOR_DEFAULTS.approvals, decisionPollMs: 20 },
  coordination: { lockPollMs: 20, staleLockMs: 3_600_000 },
};

function harness({
  tasks, mockRuns, agents = null, approvalsOverrides = {}, projectExtra = {},
  root: providedRoot, providers = [],
} = {}) {
  // A caller may pass back the `root` this function returns to build a
  // SECOND, independent Orchestrator/ApprovalManager pointed at the exact
  // same on-disk state — the truest simulation of "a different process
  // resumed this mission" (see the resume-dedup test below).
  const root = providedRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), 'aio-p10-'));
  const workspace = path.join(root, 'workspace');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'agents'), { recursive: true });

  const normalizedTasks = tasks.map((t) => {
    const promptFile = path.join(workspace, `${t.id}.prompt.md`);
    fs.writeFileSync(promptFile, `# ${t.id}`);
    return {
      continuePrompt: null, verify: [], maxRuns: DEFAULT_TASK_MAX_RUNS,
      role: null, agent: null, capabilities: [],
      dependsOn: [], resources: [], approval: null,
      ...t, resolvedPromptFile: promptFile,
    };
  });

  let agentsFile;
  if (agents) {
    agentsFile = path.join(root, 'agents.json');
    fs.writeFileSync(agentsFile, JSON.stringify({ agents }));
  }

  const config = {
    ...BASE_CONFIG,
    approvals: { ...BASE_CONFIG.approvals, ...approvalsOverrides },
  };
  const project = {
    name: 'p10proj', driver: 'mock', workingDirectory: workspace,
    mission: { completionMarker: 'MISSION COMPLETE', continuePrompt: 'continue', maxRuns: 0 },
    tasks: normalizedTasks, mock: { runs: mockRuns },
    ...projectExtra,
  };

  const paths = {
    ledgerDir: path.join(stateDir, 'ledger'),
    timelineDir: path.join(stateDir, 'timeline'),
    progressDir: path.join(stateDir, 'progress'),
    tasksDir: path.join(stateDir, 'tasks'),
    diagnosticsDir: path.join(stateDir, 'diagnostics'),
    memoryDir: path.join(stateDir, 'memory'),
    agentsDir: path.join(stateDir, 'agents'),
    agentHealthFile: path.join(stateDir, 'agents', 'health.json'),
    ...(agentsFile ? { agentsFile } : {}),
  };

  const approvalStore = new ApprovalStore({
    approvalsDir: path.join(stateDir, 'approvals'), logger: silentLogger,
  });
  const approvalManager = new ApprovalManager({
    config: config.approvals, store: approvalStore, providers, logger: silentLogger,
  });
  const lifecycle = new MissionLifecycle({
    lifecycleDir: path.join(stateDir, 'lifecycle'), logger: silentLogger,
  });
  lifecycle.attachApprovals(approvalManager); // same wiring App performs
  const resourceLocks = new ResourceLockManager({
    coordinationDir: path.join(stateDir, 'coordination'), logger: silentLogger,
  });
  const messageBus = new AgentMessageBus({
    coordinationDir: path.join(stateDir, 'coordination'), logger: silentLogger,
  });

  const driverRegistry = new DriverRegistry({ logger: silentLogger });
  const orchestrator = new Orchestrator({
    configManager: { getAll: () => config, getProject: () => project },
    driverRegistry,
    sessionManager: new SessionManager({ sessionsDir: path.join(stateDir, 'sessions'), logger: silentLogger }),
    statusManager: new StatusManager({ statusFile: path.join(stateDir, 'status.json'), logger: silentLogger }),
    paths,
    logger: silentLogger,
    approvalManager,
    lifecycle,
    resourceLocks,
    messageBus,
  });

  return {
    orchestrator, approvalManager, approvalStore, lifecycle, resourceLocks,
    messageBus, driverRegistry, paths, workspace, root,
  };
}

test('an implementation plan pauses for review; APPROVE continues the mission (10A)', async () => {
  const { orchestrator, approvalManager, approvalStore, driverRegistry } = harness({
    tasks: [{ id: 'T1', verify: [{ type: 'file-exists', path: 'built.txt' }] }],
    mockRuns: [
      {
        output: 'IMPLEMENTATION PLAN READY\nRebuild the parser.\n\n## Tasks\n- rewrite tokenizer\n\n## Risks\n- regressions\n',
        result: 'plan presented', exitCode: 0, delayMs: 15,
      },
      { output: 'implemented', writeFile: { path: 'built.txt', content: 'x' }, exitCode: 0, delayMs: 15 },
    ],
  });

  const required = [];
  approvalManager.on('approval:required', ({ request }) => {
    required.push(request);
    // The "owner" approves from their phone shortly after.
    setTimeout(() => approvalStore.resolve('p10proj', request.id, {
      decision: 'approved', by: 'owner', via: 'test',
    }), 30);
  });

  const result = await orchestrator.runProject('p10proj');
  assert.equal(result.complete, true);

  // Exactly one review was requested, classified implementation-review,
  // and its summary captured the plan's sections.
  assert.equal(required.length, 1);
  assert.equal(required[0].approvalClass, 'implementation-review');
  assert.equal(required[0].category, 'implementation-plan');
  assert.match(required[0].summary, /rewrite tokenizer/);
  assert.match(required[0].summary, /regressions/);

  // The relaunch prompt told the agent its plan was approved.
  const prompts = driverRegistry.getDriver('mock').receivedPrompts;
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /plan approved by owner/i);
});

test('a REJECTED plan blocks the mission with the owner’s note (10A)', async () => {
  const { orchestrator, approvalManager, approvalStore } = harness({
    tasks: [{ id: 'T1', verify: [{ type: 'file-exists', path: 'built.txt' }] }],
    mockRuns: [
      { output: 'IMPLEMENTATION PLAN READY\nDelete everything and start over.', exitCode: 0, delayMs: 15 },
    ],
  });
  approvalManager.on('approval:required', ({ request }) => {
    setTimeout(() => approvalStore.resolve('p10proj', request.id, {
      decision: 'rejected', note: 'far too invasive', via: 'test',
    }), 30);
  });

  const result = await orchestrator.runProject('p10proj');
  assert.equal(result.complete, false);
  assert.equal(result.blocked, true);
  assert.match(result.reason, /rejected: far too invasive/);
});

test('a human-action situation pauses gracefully and continues on DONE (10A)', async () => {
  const { orchestrator, approvalManager, approvalStore, lifecycle } = harness({
    tasks: [{ id: 'T1', verify: [{ type: 'file-exists', path: 'authed.txt' }] }],
    mockRuns: [
      // The agent cannot continue: an external login is required. No
      // workspace progress either — pre-Phase-10 this was a terminal block.
      { output: 'I stopped because you need to log in to the vendor portal first.', exitCode: 0, delayMs: 15 },
      { output: 'logged in, continuing', writeFile: { path: 'authed.txt', content: 'x' }, exitCode: 0, delayMs: 15 },
    ],
  });

  const humanActions = [];
  approvalManager.on('human-action:required', ({ request }) => {
    humanActions.push(request);
    setTimeout(() => approvalStore.resolve('p10proj', request.id, {
      decision: 'done', by: 'owner', via: 'test',
    }), 30);
  });

  const result = await orchestrator.runProject('p10proj');
  assert.equal(result.complete, true, result.reason);

  assert.equal(humanActions.length, 1);
  assert.equal(humanActions[0].approvalClass, 'human-action');
  assert.equal(humanActions[0].category, 'external-login');
  assert.match(humanActions[0].summary, /What happened:/);
  assert.match(humanActions[0].summary, /Action required:/);

  // The pause is visible in the lifecycle history.
  const states = lifecycle.get('p10proj').history.map((h) => h.to);
  assert.ok(states.includes('approval-pending'));
  assert.equal(lifecycle.get('p10proj').state, 'completed');
});

test('verified work never pauses: a passing run that MENTIONS a blocker completes (10.5 livelock fix)', async () => {
  const { orchestrator, approvalManager, lifecycle } = harness({
    tasks: [{ id: 'T1', verify: [{ type: 'file-exists', path: 'done.txt' }] }],
    mockRuns: [
      // The output matches the captcha blocked-pattern, but the work is
      // real and the verifier passes — completion must outrank the pattern
      // (pre-fix this paused for the owner on EVERY relaunch, forever).
      {
        output: 'the captcha was solved earlier; work is finished',
        writeFile: { path: 'done.txt', content: 'x' },
        exitCode: 0,
        delayMs: 15,
      },
    ],
  });

  const humanActions = [];
  approvalManager.on('human-action:required', ({ request }) => humanActions.push(request));

  const result = await orchestrator.runProject('p10proj');
  assert.equal(result.complete, true, result.reason);
  assert.equal(humanActions.length, 0); // never paged the owner
  assert.equal(lifecycle.get('p10proj').state, 'completed');
});

test('an owner-gated task never launches without approval; rejection blocks it (10A/10B)', async () => {
  const { orchestrator, approvalManager, approvalStore, driverRegistry, paths } = harness({
    tasks: [{
      id: 'DEPLOY', approval: 'production-deployment',
      verify: [{ type: 'file-exists', path: 'deployed.txt' }],
    }],
    mockRuns: [{ output: 'should never run', exitCode: 0, delayMs: 15 }],
  });
  approvalManager.on('approval:required', ({ request }) => {
    setTimeout(() => approvalStore.resolve('p10proj', request.id, {
      decision: 'rejected', note: 'not tonight', via: 'test',
    }), 30);
  });

  const result = await orchestrator.runProject('p10proj');
  assert.equal(result.complete, false);
  assert.equal(result.blocked, true);

  // The engine was NEVER launched for the gated task.
  assert.equal(driverRegistry.getDriver('mock').receivedPrompts.length, 0);

  // The task is BLOCKED so the P7 operator overrides (approve/skip) apply.
  const queue = JSON.parse(fs.readFileSync(path.join(paths.tasksDir, 'p10proj.json'), 'utf8'));
  assert.equal(queue.tasks[0].state, 'blocked');
  assert.match(queue.tasks[0].checkpoint.summary, /rejected: not tonight/);
});

/** A minimal fake approval provider (publish-only) shared across two harness() instances. */
function fakeProvider() {
  return { name: 'fake', canReceive: false, published: [], async publish(p) { this.published.push(p); } };
}

test('a stop/resume across TWO Orchestrator instances never re-publishes the approval (Phase 11 M2)', async () => {
  // The real-world bug this guards: an operator stop (or a crash) while a
  // mission is paused awaiting approval, followed by a resume, used to
  // create a FRESH approval request and re-announce it through every
  // provider — paging the owner again for a decision they hadn't even had
  // a chance to make yet. This simulates the out-of-band case properly: a
  // SECOND, independent Orchestrator + ApprovalManager, sharing only the
  // on-disk state — exactly like a real process restart — not the same
  // in-memory instance.
  const tasks = [{
    id: 'DEPLOY', approval: 'production-deployment',
    verify: [{ type: 'file-exists', path: 'deployed.txt' }],
  }];
  const provider = fakeProvider();
  const required = [];

  const first = harness({
    tasks, mockRuns: [{ output: 'should never run before approval', exitCode: 0, delayMs: 15 }],
    providers: [provider],
  });
  first.approvalManager.on('approval:required', (e) => required.push(e));

  const firstRun = first.orchestrator.runProject('p10proj');
  // Stop the instant the approval is published — before anyone decides.
  await new Promise((resolve) => {
    first.approvalManager.once('approval:required', () => { first.orchestrator.stop('test: simulated crash'); resolve(); });
  });
  const stoppedResult = await firstRun;
  assert.equal(stoppedResult.complete, false);
  assert.match(stoppedResult.reason, /stopped by operator/);
  assert.equal(provider.published.length, 1); // published exactly once so far
  assert.equal(required.length, 1);

  // "Resume": a BRAND NEW Orchestrator/ApprovalManager, same root on disk —
  // the same shape as a real process restart picking the mission back up.
  const second = harness({
    tasks,
    mockRuns: [{ output: 'deploying', writeFile: { path: 'deployed.txt', content: 'x' }, exitCode: 0, delayMs: 15 }],
    providers: [provider],
    root: first.root,
  });
  second.approvalManager.on('approval:required', (e) => required.push(e));

  const secondRun = second.orchestrator.runProject('p10proj');
  // Now the owner actually decides.
  setTimeout(() => {
    const [pending] = second.approvalStore.pending('p10proj');
    second.approvalStore.resolve('p10proj', pending.id, { decision: 'approved', by: 'owner', via: 'test' });
  }, 30);
  const finalResult = await secondRun;

  assert.equal(finalResult.complete, true);
  assert.equal(required.length, 1); // STILL only ever announced once
  assert.equal(provider.published.length, 1); // STILL only ever published once
  assert.equal(second.approvalStore.list('p10proj').length, 1); // one request record, not two
  assert.ok(fs.existsSync(path.join(second.workspace, 'deployed.txt')));
});

test('automatic categories run without pausing; the audit trail records them (10A/10B)', async () => {
  const { orchestrator, approvalStore } = harness({
    tasks: [{
      id: 'T1', approval: 'tests', verify: [{ type: 'file-exists', path: 'a.txt' }],
    }],
    mockRuns: [{ output: 'ok', writeFile: { path: 'a.txt', content: '1' }, exitCode: 0, delayMs: 15 }],
  });
  const result = await orchestrator.runProject('p10proj');
  assert.equal(result.complete, true);
  const audit = approvalStore.list('p10proj');
  assert.equal(audit.length, 1);
  assert.equal(audit[0].status, 'auto-approved');
  assert.equal(audit[0].category, 'tests');
});

test('task:verification-failed fires with the failing checks; lifecycle records fixing (10D/10F)', async () => {
  const { orchestrator, lifecycle } = harness({
    tasks: [{ id: 'T1', verify: [{ type: 'file-exists', path: 'target.txt' }] }],
    mockRuns: [
      // Progress (a different file) but verification fails...
      { output: 'working', writeFile: { path: 'other.txt', content: '1' }, exitCode: 0, delayMs: 15 },
      // ...then the real target appears.
      { output: 'fixed', writeFile: { path: 'target.txt', content: '2' }, exitCode: 0, delayMs: 15 },
    ],
  });
  const failures = [];
  orchestrator.on('task:verification-failed', (e) => failures.push(e));

  const result = await orchestrator.runProject('p10proj');
  assert.equal(result.complete, true);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].taskId, 'T1');
  assert.equal(failures[0].attempt, 1);
  assert.match(failures[0].failedChecks, /file-exists/);

  const states = lifecycle.get('p10proj').history.map((h) => h.to);
  assert.ok(states.includes('fixing'));
});

test('the standardized lifecycle is recorded end to end (10D)', async () => {
  const { orchestrator, lifecycle } = harness({
    tasks: [{ id: 'T1', verify: [{ type: 'file-exists', path: 'a.txt' }] }],
    mockRuns: [{ output: 'ok', writeFile: { path: 'a.txt', content: '1' }, exitCode: 0, delayMs: 15 }],
  });
  await orchestrator.runProject('p10proj');

  const record = lifecycle.get('p10proj');
  assert.equal(record.state, 'completed');
  const states = record.history.map((h) => h.to);
  for (const expected of ['received', 'analyzed', 'planned', 'agents-assigned', 'executing', 'verifying', 'completed']) {
    assert.ok(states.includes(expected), `lifecycle missing "${expected}" (got ${states.join(' → ')})`);
  }
});

test('task resources wait for a conflicting cross-mission lock, then acquire and release (10H)', async () => {
  const { orchestrator, resourceLocks } = harness({
    tasks: [{
      id: 'T1', resources: ['shared-db'], verify: [{ type: 'file-exists', path: 'a.txt' }],
    }],
    mockRuns: [{ output: 'ok', writeFile: { path: 'a.txt', content: '1' }, exitCode: 0, delayMs: 15 }],
  });
  // Another (live) mission holds the resource right now.
  resourceLocks.acquireAll(['shared-db'], { project: 'other-mission', taskId: 'X', pid: process.pid });

  const started = Date.now();
  setTimeout(() => resourceLocks.releaseAll({ project: 'other-mission' }), 60);

  const result = await orchestrator.runProject('p10proj');
  assert.equal(result.complete, true);
  // It genuinely waited for the release rather than barging in.
  assert.ok(Date.now() - started >= 55, 'expected the mission to wait for the lock');
  // And left nothing locked behind.
  assert.deepEqual(resourceLocks.held(), []);
});

test('a task handoff to a different agent leaves a message the next prompt carries (10H)', async () => {
  const { orchestrator, messageBus, driverRegistry } = harness({
    agents: [
      { id: 'coder', role: 'coding', driver: 'mock' },
      { id: 'tester', role: 'testing', driver: 'mock' },
    ],
    tasks: [
      { id: 'T1', role: 'coding', verify: [{ type: 'file-exists', path: 'a.txt' }] },
      { id: 'T2', role: 'testing', verify: [{ type: 'file-exists', path: 'b.txt' }] },
    ],
    mockRuns: [
      { output: 'built', result: 'Built the feature end to end.', writeFile: { path: 'a.txt', content: '1' }, exitCode: 0, delayMs: 15 },
      { output: 'tested', writeFile: { path: 'b.txt', content: '2' }, exitCode: 0, delayMs: 15 },
    ],
  });

  const result = await orchestrator.runProject('p10proj');
  assert.equal(result.complete, true);

  // The handoff message exists and was consumed by the tester.
  const messages = messageBus.list('p10proj');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].from, 'coder');
  assert.equal(messages[0].to, 'tester');
  assert.equal(messages[0].topic, 'handoff');
  assert.ok(messages[0].readBy.includes('tester'));

  // And T2's FRESH prompt carried it.
  const prompts = driverRegistry.getDriver('mock').receivedPrompts;
  assert.match(prompts[1], /Messages from other agents/);
  assert.match(prompts[1], /Built the feature end to end\./);
});

test('LEGACY GUARANTEE: with approvals disabled, a human-action pattern still blocks terminally', async () => {
  const { orchestrator } = harness({
    approvalsOverrides: { enabled: false },
    tasks: [{ id: 'T1', verify: [{ type: 'file-exists', path: 'a.txt' }] }],
    mockRuns: [
      { output: 'you need to log in to the vendor portal first.', exitCode: 0, delayMs: 15 },
    ],
  });
  const result = await orchestrator.runProject('p10proj');
  // No approval manager path → the pre-P10 behavior: blocked, not paused.
  assert.equal(result.complete, false);
  assert.equal(result.blocked, true);
});
