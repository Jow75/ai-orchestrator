/**
 * Integration tests for operator/commandRouter.js — Phase 12 M2.
 *
 * The router is where a message becomes an action, so these run against a REAL
 * throwaway installation with real stores: real project configs, a real task
 * queue, a real approval store, a real event log. Only the worker supervisor
 * is a stand-in, because the alternative is spawning actual AI missions.
 *
 * The claims under test are the ones the phase is accountable for:
 *
 *   Priority 1  /projects reports real state
 *   Priority 2  /project selects, and is remembered
 *   Priority 3  free text NEVER starts work — it proposes, and approval starts
 *   Priority 5  each project is isolated: separate queues, separate approvals
 *   Priority 7  nothing destructive happens on one message
 *   §6 security  an unknown command is refused, not reinterpreted
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ConfigManager from '../src/config/configManager.js';
import CommandRouter from '../src/operator/commandRouter.js';
import ProjectRegistry from '../src/operator/projectRegistry.js';
import OperatorContext from '../src/operator/operatorContext.js';
import MissionRequestStore from '../src/operator/missionRequests.js';
import ConfirmationStore from '../src/operator/confirmations.js';
import EventStore from '../src/events/eventStore.js';
import WorkerRegistry from '../src/daemon/workerRegistry.js';
import TaskQueue from '../src/mission/taskQueue.js';
import MissionLifecycle from '../src/mission/missionLifecycle.js';
import ApprovalStore from '../src/approvals/approvalStore.js';
import ApprovalManager from '../src/approvals/approvalManager.js';
import SessionManager from '../src/state/sessionManager.js';
import { ORCHESTRATOR_DEFAULTS } from '../src/config/defaults.js';
import { ensureRuntimeDirs } from '../src/infra/paths.js';
import { silentLogger } from '../src/infra/logger.js';

/** A supervisor stand-in that records what it was asked to do. */
function fakeSupervisor(workerRegistry) {
  return {
    started: [],
    stopped: [],
    nextResult: null,
    holderOf: (project) => workerRegistry.holderOf(project),
    list: () => workerRegistry.listAlive().map((r) => ({ project: r.project, pid: r.pid })),
    start(project, options = {}) {
      this.started.push({ project, ...options });
      if (this.nextResult) return this.nextResult;
      workerRegistry.register(project, { pid: process.pid, mode: 'worker' });
      return { ok: true, project, pid: process.pid };
    },
    stop(project, options = {}) {
      this.stopped.push({ project, ...options });
      workerRegistry.unregister(project);
      return { ok: true, via: 'stop-file' };
    },
  };
}

/** A throwaway installation with every collaborator the router needs. */
function harness({ projects = ['alpha', 'beta'], operator = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-router-'));
  const configManager = new ConfigManager({ rootDir: root });
  configManager.load();
  const paths = configManager.getPaths();
  ensureRuntimeDirs(paths);
  fs.mkdirSync(paths.projectsDir, { recursive: true });

  for (const name of projects) {
    const workingDirectory = path.join(root, 'work', name);
    fs.mkdirSync(workingDirectory, { recursive: true });
    fs.writeFileSync(path.join(workingDirectory, 'prompt.md'), '# work\n');
    fs.writeFileSync(
      path.join(paths.projectsDir, `${name}.json`),
      JSON.stringify({
        workingDirectory, promptFile: 'prompt.md', driver: 'mock',
        description: `The ${name} project.`,
      })
    );
  }

  const lifecycle = new MissionLifecycle({ lifecycleDir: paths.lifecycleDir, logger: silentLogger });
  const taskQueue = new TaskQueue({ tasksDir: paths.tasksDir, logger: silentLogger, lifecycle });
  const approvalStore = new ApprovalStore({ approvalsDir: paths.approvalsDir, logger: silentLogger });
  const approvalManager = new ApprovalManager({
    config: ORCHESTRATOR_DEFAULTS.approvals, store: approvalStore, logger: silentLogger,
  });
  const workerRegistry = new WorkerRegistry({ workersDir: paths.workersDir, logger: silentLogger });
  const sessionManager = new SessionManager({ sessionsDir: paths.sessionsDir, logger: silentLogger });
  const events = new EventStore({ eventsDir: paths.eventsDir, logger: silentLogger });
  const supervisor = fakeSupervisor(workerRegistry);
  const shutdowns = [];

  const registry = new ProjectRegistry({
    configManager, workerRegistry, taskQueue, lifecycle, approvalStore, sessionManager,
    heartbeatFile: paths.heartbeatFile, logger: silentLogger,
  });

  const router = new CommandRouter({
    registry,
    context: new OperatorContext({ contextFile: paths.operatorContextFile, logger: silentLogger }),
    requests: new MissionRequestStore({
      requestsFile: paths.missionRequestsFile,
      promptsDir: paths.missionPromptsDir,
      logger: silentLogger,
    }),
    confirmations: new ConfirmationStore(),
    events,
    approvalStore,
    approvalManager,
    supervisor,
    taskQueue,
    sessionManager,
    configManager,
    config: { ...ORCHESTRATOR_DEFAULTS, operator: { ...ORCHESTRATOR_DEFAULTS.operator, ...operator } },
    requestShutdown: () => shutdowns.push(Date.now()),
    logger: silentLogger,
  });

  const say = (text) => router.handle({ text, channel: 'telegram', chatId: '42', from: 'moses' });
  return {
    root, paths, router, say, supervisor, taskQueue, approvalStore, approvalManager,
    workerRegistry, events, shutdowns, registry, sessionManager, lifecycle,
  };
}

// ─────────────────────────────────────────────────── Priority 1 & 2 ────────

test('/projects lists every project with its real status', async () => {
  const { say, workerRegistry } = harness();
  workerRegistry.register('beta', { pid: process.pid });

  const { reply } = await say('/projects');

  assert.match(reply, /alpha/);
  assert.match(reply, /beta/);
  assert.match(reply, /Running/);
  assert.match(reply, /No project selected/);
});

test('/project selects, is remembered, and is reported back', async () => {
  const { say, events } = harness();

  const selected = await say('/project beta');
  assert.match(selected.reply, /beta selected/);

  const who = await say('/whoami');
  assert.match(who.reply, /Active project: beta/);

  const later = await say('/status');
  assert.match(later.reply, /beta/, 'a later command with no argument applies to the selection');

  assert.equal(events.read({ types: ['project.selected'] }).length, 1);
});

test('an ambiguous project name is never guessed at', async () => {
  const { say } = harness({ projects: ['remote-work', 'remote-backup'] });

  const { reply } = await say('/project remote');

  assert.match(reply, /matches 2 projects/);
  assert.match(reply, /Say which one/);
});

test('a command with no selection and no argument explains how to fix it', async () => {
  const { say } = harness();
  const { reply } = await say('/status');

  assert.match(reply, /No project selected/);
  assert.match(reply, /\/projects/);
});

// ───────────────────────────────────────────────────────── Priority 3 ──────

test('free text creates a proposal and starts NOTHING', async () => {
  const { say, supervisor, taskQueue, events } = harness();
  await say('/project alpha');

  const { reply } = await say('Build a payroll dashboard with CSV export.');

  assert.match(reply, /Mission M1/);
  assert.match(reply, /Build a payroll dashboard with CSV export\./);
  assert.match(reply, /APPROVE M1/);
  assert.deepEqual(supervisor.started, [], 'no worker was started');
  assert.equal(taskQueue.load('alpha'), null, 'nothing was queued');
  assert.equal(events.read({ types: ['mission.created'] }).length, 1);
  assert.equal(events.read({ types: ['mission.started'] }).length, 0);
});

test('the proposal states what is known and promises the plan gate — it invents no estimates', async () => {
  const { say } = harness();
  await say('/project alpha');

  const { reply } = await say('Build a payroll dashboard with CSV export.');

  assert.match(reply, /planning run starts/);
  assert.match(reply, /tasks, files, duration, risks/, 'the real estimates come from the plan');
  assert.doesNotMatch(reply, /\d+%/, 'no confidence percentage is invented before anything has run');
});

test('approving a mission request is what starts the work', async () => {
  const { say, supervisor, taskQueue, events, paths } = harness();
  await say('/project alpha');
  await say('Build a payroll dashboard with CSV export.');

  const { reply } = await say('APPROVE M1');

  assert.match(reply, /starting M1/);
  assert.deepEqual(supervisor.started.map((s) => s.project), ['alpha']);

  const queue = taskQueue.load('alpha');
  assert.equal(queue.tasks.length, 1);
  assert.equal(queue.tasks[0].id, 'M1');
  assert.equal(queue.tasks[0].state, 'pending');

  const promptFile = queue.tasks[0].resolvedPromptFile;
  assert.ok(promptFile.startsWith(paths.missionPromptsDir), 'the prompt lives under state/, not in the repo');
  assert.match(fs.readFileSync(promptFile, 'utf8'), /IMPLEMENTATION PLAN READY/);

  assert.equal(events.read({ types: ['mission.approved'] }).length, 1);
  assert.equal(events.read({ types: ['mission.started'] }).length, 1);
});

test('rejecting a mission request starts nothing and says so', async () => {
  const { say, supervisor, taskQueue } = harness();
  await say('/project alpha');
  await say('Build a payroll dashboard with CSV export.');

  const { reply } = await say('REJECT M1 not this sprint');

  assert.match(reply, /rejected/);
  assert.match(reply, /Nothing was started/);
  assert.deepEqual(supervisor.started, []);
  assert.equal(taskQueue.load('alpha'), null);
});

test('a mission request cannot be approved twice', async () => {
  const { say, supervisor } = harness();
  await say('/project alpha');
  await say('Build a payroll dashboard with CSV export.');
  await say('APPROVE M1');

  const { reply } = await say('APPROVE M1');

  assert.match(reply, /already/);
  assert.equal(supervisor.started.length, 1, 'one approval, one mission');
});

test('free text with no project selected asks for one instead of guessing', async () => {
  const { say } = harness();
  const { reply } = await say('Build a payroll dashboard with CSV export.');

  assert.match(reply, /No project is selected/);
});

test('a too-short message is not treated as an objective', async () => {
  const { say } = harness();
  await say('/project alpha');

  const { reply } = await say('hm ok');

  assert.match(reply, /too short/);
});

test('a mission cannot be started onto a project that is already running', async () => {
  const { say, workerRegistry, supervisor } = harness();
  await say('/project alpha');
  await say('Build a payroll dashboard with CSV export.');
  workerRegistry.register('alpha', { pid: process.pid });

  const { reply } = await say('APPROVE M1');

  assert.match(reply, /approved, but cannot start yet/);
  assert.match(reply, /already has a mission running/);
  assert.deepEqual(supervisor.started, [], 'appending to a live queue would be silently overwritten');
});

test('a mission is refused onto a stuck queue rather than silently discarded', async () => {
  const { say, taskQueue, supervisor } = harness();
  const queue = taskQueue.ensure('alpha');
  queue.tasks.push({ id: 'T1', state: 'blocked', attempts: 3, checkpoint: null });
  taskQueue.save(queue);

  await say('/project alpha');
  await say('Build a payroll dashboard with CSV export.');
  const { reply } = await say('APPROVE M1');

  assert.match(reply, /stuck on task "T1"/);
  assert.match(reply, /tasks approve|tasks skip/, 'and says exactly how to clear it');
  assert.deepEqual(supervisor.started, []);
});

test("a project's configured plan is preserved, not replaced, by a remote mission", async () => {
  const { say, taskQueue, paths } = harness({ projects: [] });
  // A mission-mode project with a configured plan that has never run.
  const workingDirectory = path.join(paths.root, 'work', 'planned');
  fs.mkdirSync(workingDirectory, { recursive: true });
  fs.writeFileSync(path.join(workingDirectory, 't1.md'), '# task one\n');
  fs.writeFileSync(
    path.join(paths.projectsDir, 'planned.json'),
    JSON.stringify({
      workingDirectory, driver: 'mock',
      tasks: [{ id: 'T1', objective: 'the configured first task', prompt: 't1.md' }],
    })
  );

  await say('/project planned');
  await say('Build a payroll dashboard with CSV export.');
  await say('APPROVE M1');

  const queue = taskQueue.load('planned');
  assert.deepEqual(queue.tasks.map((t) => t.id), ['T1', 'M1'],
    'the configured task still runs first; the remote mission is appended');
});

// ───────────────────────────────────────────────────────── Priority 5 ──────

test('two projects are supervised independently, with separate queues', async () => {
  const { say, supervisor, taskQueue } = harness();

  await say('/project alpha');
  await say('Build a payroll dashboard for alpha.');
  await say('APPROVE M1');

  await say('/project beta');
  await say('Rewrite the beta importer in TypeScript.');
  await say('APPROVE M2');

  assert.deepEqual(supervisor.started.map((s) => s.project), ['alpha', 'beta'],
    'both run at once — the capability Phase 12 M1 unlocked');
  assert.deepEqual(taskQueue.load('alpha').tasks.map((t) => t.id), ['M1']);
  assert.deepEqual(taskQueue.load('beta').tasks.map((t) => t.id), ['M2'],
    'no cross-contamination between projects');
});

test('approvals stay attached to their own project', async () => {
  const { say, approvalStore } = harness();
  approvalStore.create('alpha', { category: 'x', approvalClass: 'owner-gate', title: 'Alpha decision' });
  approvalStore.create('beta', { category: 'x', approvalClass: 'owner-gate', title: 'Beta decision' });

  const { reply } = await say('/approvals');

  assert.match(reply, /Alpha decision/);
  assert.match(reply, /Beta decision/);
  assert.match(reply, /alpha/);
  assert.match(reply, /beta/);
});

// ───────────────────────────────────────────────── approvals over the wire ─

test('APPROVE A7 resolves a real approval and records it', async () => {
  const { say, approvalStore, events } = harness();
  const request = approvalStore.create('alpha', {
    category: 'implementation-plan', approvalClass: 'review', title: 'Plan review',
  });

  const { reply } = await say(`APPROVE ${request.id}`);

  assert.match(reply, new RegExp(`${request.id} approved`));
  assert.equal(approvalStore.get('alpha', request.id).status, 'approved');
  assert.equal(events.read({ types: ['approval.accepted'] }).length, 1);
});

test('REJECT carries the note through to the audit trail', async () => {
  const { say, approvalStore } = harness();
  const request = approvalStore.create('alpha', {
    category: 'implementation-plan', approvalClass: 'review', title: 'Plan review',
  });

  await say(`REJECT ${request.id} the schema is wrong`);

  const stored = approvalStore.get('alpha', request.id);
  assert.equal(stored.status, 'rejected');
  assert.equal(stored.decisionNote, 'the schema is wrong');
  assert.equal(stored.via, 'telegram');
});

test('a decision on an id that does not exist is refused clearly', async () => {
  const { say } = harness();
  const { reply } = await say('APPROVE A999');

  assert.match(reply, /No approval request "A999"/);
});

test('MODIFY on a mission request explains that there is no plan yet', async () => {
  const { say } = harness();
  await say('/project alpha');
  await say('Build a payroll dashboard with CSV export.');

  const { reply } = await say('MODIFY M1 make it simpler');

  assert.match(reply, /mission request/);
  assert.match(reply, /APPROVE M1/);
});

// ───────────────────────────────────────────────────────── Priority 7 ──────

test('/stop asks for confirmation and stops nothing on the first message', async () => {
  const { say, supervisor, workerRegistry } = harness();
  workerRegistry.register('alpha', { pid: process.pid });

  const { reply } = await say('/stop alpha');

  assert.match(reply, /Confirm this action/);
  assert.match(reply, /\/confirm [A-Z0-9]{4}/);
  assert.deepEqual(supervisor.stopped, [], 'nothing was stopped');
});

test('confirming the code is what actually stops the mission', async () => {
  const { say, supervisor, workerRegistry, events } = harness();
  workerRegistry.register('alpha', { pid: process.pid });
  const asked = await say('/stop alpha');
  const code = asked.reply.match(/\/confirm ([A-Z0-9]{4})/)[1];

  const { reply } = await say(`/confirm ${code}`);

  assert.match(reply, /stop requested/i);
  assert.deepEqual(supervisor.stopped.map((s) => s.project), ['alpha']);
  assert.equal(events.read({ types: ['command.confirmed'] }).length, 1);
  assert.equal(events.read({ types: ['worker.stopped'] }).length, 1);
});

test('a stale or wrong confirmation code performs nothing', async () => {
  const { say, supervisor, workerRegistry } = harness();
  workerRegistry.register('alpha', { pid: process.pid });
  await say('/stop alpha');

  const { reply } = await say('/confirm ZZZZ');

  assert.match(reply, /not valid/);
  assert.deepEqual(supervisor.stopped, []);
});

test('/cancel discards a pending confirmation', async () => {
  const { say, supervisor, workerRegistry } = harness();
  workerRegistry.register('alpha', { pid: process.pid });
  const asked = await say('/stop alpha');
  const code = asked.reply.match(/\/confirm ([A-Z0-9]{4})/)[1];

  await say('/cancel');
  const { reply } = await say(`/confirm ${code}`);

  assert.match(reply, /not valid/);
  assert.deepEqual(supervisor.stopped, []);
});

test('/stop on a project with nothing running does not ask for a pointless confirmation', async () => {
  const { say } = harness();
  const { reply } = await say('/stop alpha');

  assert.match(reply, /no mission running/);
  assert.doesNotMatch(reply, /Confirm this action/);
});

test('/shutdown is confirmed before the service stops', async () => {
  const { say, shutdowns } = harness();

  const asked = await say('/shutdown');
  assert.match(asked.reply, /Confirm this action/);
  assert.equal(shutdowns.length, 0);

  const code = asked.reply.match(/\/confirm ([A-Z0-9]{4})/)[1];
  const done = await say(`/confirm ${code}`);

  assert.match(done.reply, /Stopping the Core Service/);
  assert.equal(shutdowns.length, 1);
});

test('/reset is confirmed, and refuses when there is nothing to abandon', async () => {
  const { say, sessionManager } = harness();

  const nothing = await say('/reset alpha');
  assert.match(nothing.reply, /no interrupted session/);

  sessionManager.createSession('alpha', 'mock');
  const asked = await say('/reset alpha');
  assert.match(asked.reply, /Confirm this action/);
  assert.match(asked.reply, /Files on disk are NOT touched/);

  const code = asked.reply.match(/\/confirm ([A-Z0-9]{4})/)[1];
  await say(`/confirm ${code}`);
  assert.equal(sessionManager.getResumableSession('alpha'), null);
});

test('/reset refuses while a mission is running, and says what to do first', async () => {
  const { say, sessionManager, workerRegistry } = harness();
  sessionManager.createSession('alpha', 'mock');
  workerRegistry.register('alpha', { pid: process.pid });

  const { reply } = await say('/reset alpha');

  assert.match(reply, /running right now/);
  assert.match(reply, /\/stop alpha first/);
});

// ──────────────────────────────────────────────────────────── security ─────

test('an unknown slash command is refused, never reinterpreted as work', async () => {
  const { say, supervisor, events } = harness();
  await say('/project alpha');

  const { reply } = await say('/delete-everything');

  assert.match(reply, /do not know the command/);
  assert.deepEqual(supervisor.started, []);
  assert.equal(events.read({ types: ['command.rejected'] }).length, 1);
});

test('a decision verb with a nonsense id resolves nothing', async () => {
  const { say, approvalStore } = harness();
  approvalStore.create('alpha', { category: 'x', approvalClass: 'owner-gate', title: 'Decide' });

  const { reply } = await say('APPROVE everything');

  assert.match(reply, /not a request id/);
  assert.equal(approvalStore.pendingAll().length, 1, 'the real request is untouched');
});

test('with the operator interface disabled, only decisions are honoured', async () => {
  const { say, approvalStore, supervisor } = harness({ operator: { enabled: false } });
  const request = approvalStore.create('alpha', {
    category: 'implementation-plan', approvalClass: 'review', title: 'Plan review',
  });

  assert.equal((await say('/projects')).reply, null, 'the widened grammar is off');
  assert.equal((await say('Build me a dashboard right now')).reply, null);
  assert.deepEqual(supervisor.started, []);

  await say(`APPROVE ${request.id}`);
  assert.equal(approvalStore.get('alpha', request.id).status, 'approved',
    'approvals predate the operator interface and are never gated by it');
});

test('with free text disabled, prose gets help instead of a proposal', async () => {
  const { say } = harness({ operator: { acceptFreeText: false } });
  await say('/project alpha');

  const { reply } = await say('Build a payroll dashboard with CSV export.');

  assert.match(reply, /remote console/, 'the help text');
  assert.doesNotMatch(reply, /Mission M1/);
});

// ────────────────────────────────────────────────────────── everything else ─

test('/help is generated from the grammar and marks what needs confirmation', async () => {
  const { say } = harness();
  const { reply } = await say('/help');

  assert.match(reply, /\/projects/);
  assert.match(reply, /\/stop \[project\] ⚠️/);
  assert.match(reply, /Typing never starts work/);
});

test('/tasks reports the real queue', async () => {
  const { say, taskQueue } = harness();
  const queue = taskQueue.ensure('alpha');
  queue.tasks.push({ id: 'T1', objective: 'first thing', state: 'done', attempts: 1, checkpoint: null });
  queue.tasks.push({ id: 'T2', objective: 'second thing', state: 'pending', attempts: 0, checkpoint: null });
  queue.currentIndex = 1;
  taskQueue.save(queue);

  const { reply } = await say('/tasks alpha');

  assert.match(reply, /alpha — tasks \(1\/2\)/);
  assert.match(reply, /T2 \[pending\]/);
  assert.match(reply, /second thing/);
});

test('/events shows what actually happened, scoped to the active project', async () => {
  const { say, events } = harness();
  events.append({ type: 'worker.started', project: 'alpha' });
  events.append({ type: 'worker.started', project: 'beta' });
  await say('/project alpha');

  const { reply } = await say('/events');

  assert.match(reply, /alpha — Recent activity/);
  assert.doesNotMatch(reply, /beta/, 'another project\'s churn is not what "what happened" means here');
});

test('/start runs the project directly, without a mission request', async () => {
  const { say, supervisor } = harness();
  await say('/project alpha');

  const { reply } = await say('/start');

  assert.match(reply, /mission started/);
  assert.deepEqual(supervisor.started.map((s) => s.project), ['alpha']);
});

test('a supervisor refusal is reported honestly, not swallowed', async () => {
  const { say, supervisor } = harness();
  supervisor.nextResult = { ok: false, reason: 'Already supervising 3 missions.' };
  await say('/project alpha');

  const { reply } = await say('/start');

  assert.match(reply, /Already supervising 3 missions/);
});

test('an approved mission whose start fails says the work is still queued', async () => {
  const { say, supervisor, taskQueue } = harness();
  await say('/project alpha');
  await say('Build a payroll dashboard with CSV export.');
  supervisor.nextResult = { ok: false, reason: 'Already supervising 3 missions.' };

  const { reply } = await say('APPROVE M1');

  assert.match(reply, /queued for alpha/);
  assert.match(reply, /will run on the next start/);
  assert.deepEqual(taskQueue.load('alpha').tasks.map((t) => t.id), ['M1'],
    'the task really is queued — the message is not a consolation');
});

test('an internal failure answers honestly instead of taking the channel down', async () => {
  const { say, router } = harness();
  router.registry.list = () => { throw new Error('registry exploded'); };

  const { reply } = await say('/projects');

  assert.match(reply, /Something went wrong/);
  assert.match(reply, /registry exploded/);
  assert.match(reply, /still running/);
});

test('an empty message produces no reply at all', async () => {
  const { say } = harness();
  assert.equal((await say('   ')).reply, null);
});
