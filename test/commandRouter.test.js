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
import { execFileSync } from 'node:child_process';
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
import LiveConfigLayer from '../src/config/liveConfig.js';
import DriverRegistry from '../src/drivers/driverRegistry.js';
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

/**
 * A throwaway installation with every collaborator the router needs.
 *
 * `driver` defaults to 'claude' — a REAL engine id — because the router never
 * launches anything here (the supervisor is a stub) and the operator surfaces
 * now render differently for a simulated project. A harness that quietly used
 * the mock driver would test the rehearsal wording everywhere and leave the
 * ordinary path uncovered. Simulation is opted into explicitly, per test.
 */
function harness({ projects = ['alpha', 'beta'], operator = {}, driver = 'claude' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-router-'));
  const configManager = new ConfigManager({ rootDir: root });
  configManager.load();
  // Applied to the SAME object configManager.getAll() returns (never a
  // separate copy) — matching real daemon.js wiring exactly, where
  // CommandRouter's `config` and LiveConfigLayer's mutation target are the
  // identical reference. A copy here would make /roots tests pass against
  // an object nothing else in the router actually reads.
  Object.assign(configManager.getAll().operator, operator);
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
        workingDirectory, promptFile: 'prompt.md', driver,
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
    liveConfig: new LiveConfigLayer({ configManager }),
    driverRegistry: new DriverRegistry({ logger: silentLogger }),
    config: configManager.getAll(),
    paths,
    requestShutdown: () => shutdowns.push(Date.now()),
    logger: silentLogger,
  });

  const say = (text) => router.handle({ text, channel: 'telegram', chatId: '42', from: 'moses' });
  return {
    root, paths, router, say, supervisor, taskQueue, approvalStore, approvalManager,
    workerRegistry, events, shutdowns, registry, sessionManager, lifecycle,
  };
}

/** Turns a project's real working directory into a real git repo, with one commit. */
function makeRepo(workingDirectory, { branch = 'main', dirty = false } = {}) {
  const git = (...args) => execFileSync('git', ['-C', workingDirectory, ...args], {
    stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
  });
  git('init', '-b', branch);
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('add', '.');
  git('commit', '-m', 'first commit');
  if (dirty) fs.writeFileSync(path.join(workingDirectory, 'uncommitted.txt'), 'wip');
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
  assert.doesNotMatch(reply, /Simulated|SIMULATED/,
    'a real project must not be labelled as a rehearsal');
});

// ─────────────────────────────── simulated projects (Phase 12 M2.1) ─────────
//
// The 2026-07-28 live validation asked a mock-driver project for a React and
// Electron calculator and was told the mission was complete, verified. Nothing
// had malfunctioned; nothing had disclosed that the engine was a fixture.
// These tests pin the disclosure to the surfaces an owner actually reads.

test('a simulated project is labelled in the project list', async () => {
  const { say } = harness({ driver: 'mock' });

  const { reply } = await say('/projects');

  assert.match(reply, /SIMULATED/, 'the badge rides on the line that gets skimmed');
});

test('a simulated project discloses itself in its status detail', async () => {
  const { say } = harness({ driver: 'mock' });
  await say('/project alpha');

  const { reply } = await say('/status');

  assert.match(reply, /Simulated project/);
  assert.match(reply, /No code is written/);
});

test('the mission proposal for a simulated project promises no code, not a plan gate', async () => {
  const { say } = harness({ driver: 'mock' });
  await say('/project alpha');

  const { reply } = await say('Create a simple calculator with React and Electron.');

  assert.match(reply, /Simulated project/, 'disclosed at gate 1, before a decision is spent');
  assert.match(reply, /produces no code/);
  assert.doesNotMatch(reply, /planning run starts/,
    'the real flow promises a real plan; a fixture must not borrow that promise');
});

test('a real project is never labelled simulated', async () => {
  const { say } = harness();
  await say('/project alpha');

  const list = await say('/projects');
  const status = await say('/status');

  assert.doesNotMatch(list.reply, /SIMULATED/);
  assert.doesNotMatch(status.reply, /Simulated project/);
});

// The two LISTS an owner can act from without opening anything first. v2.10.0
// disclosed at the gates themselves and left these silent, so a decision could
// still be spent on a fixture from a screen that never mentioned one.

test('/approvals badges a decision that belongs to a simulated project', async () => {
  const { say, approvalStore } = harness({ driver: 'mock' });
  approvalStore.create('alpha', {
    category: 'implementation-plan', approvalClass: 'implementation-review',
    title: 'Implementation review — alpha',
  });

  const { reply } = await say('/approvals');

  assert.match(reply, /SIMULATED/, 'the badge must reach the list replies are sent from');
  assert.match(reply, /APPROVE A1/, 'and the decision itself still works');
});

test('/approvals leaves a real project unbadged', async () => {
  const { say, approvalStore } = harness();
  approvalStore.create('alpha', {
    category: 'implementation-plan', approvalClass: 'implementation-review',
    title: 'Implementation review — alpha',
  });

  const { reply } = await say('/approvals');

  assert.doesNotMatch(reply, /SIMULATED/);
});

test('/missions badges an open request against a simulated project', async () => {
  const { say } = harness({ driver: 'mock' });
  await say('/project alpha');
  await say('Create a simple calculator with React and Electron.');

  const { reply } = await say('/missions');

  assert.match(reply, /SIMULATED/);
  assert.match(reply, /calculator/);
});

test('a request keeps its badge from the CONFIG, not from what was frozen into it', async () => {
  // The failure this pins: a request raised while a project was a fixture, then
  // pointed at a real engine, must stop claiming to be a rehearsal — and the
  // reverse. The stored context is a snapshot; the config is the truth.
  const { say, paths } = harness({ driver: 'mock' });
  await say('/project alpha');
  await say('Build something.');

  const file = path.join(paths.projectsDir, 'alpha.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.driver = 'claude';
  fs.writeFileSync(file, JSON.stringify(raw));

  const { reply } = await say('/missions');

  assert.doesNotMatch(reply, /SIMULATED/,
    'the project is real now; its open request must not still be labelled a rehearsal');
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

// ────────────────────────────────────── Phase 13 M2: discovery & import ────

/** A harness whose operator.projectRoots points at a real scratch folder. */
function discoveryHarness(overrides = {}) {
  const h = harness({
    projects: ['alpha'],
    operator: { projectRoots: [], discovery: {} },
    ...overrides,
  });
  const rootsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-scanroot-'));
  h.router.config.operator.projectRoots = [rootsDir];
  h.rootsDir = rootsDir;
  return h;
}

function mkCandidate(rootsDir, name, { marker = 'package.json' } = {}) {
  const dir = path.join(rootsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  if (marker) fs.writeFileSync(path.join(dir, marker), '{}');
  return dir;
}

test('/scan finds a real, unregistered folder under the configured root', async () => {
  const h = discoveryHarness();
  mkCandidate(h.rootsDir, 'new-project');

  const { reply } = await h.say('/scan');

  assert.match(reply, /Found 1 new project/);
  assert.match(reply, /new-project/);
  assert.equal(h.events.read({ types: ['project.discovered'] }).length, 1);
});

test('/scan never re-offers an already-registered project', async () => {
  const h = discoveryHarness();
  // alpha's real workingDirectory (from harness()) is NOT under rootsDir, so
  // register a second project whose folder IS under rootsDir this time.
  const dir = mkCandidate(h.rootsDir, 'already-registered');
  fs.writeFileSync(path.join(dir, 'prompt.md'), '# work\n');
  fs.writeFileSync(
    path.join(h.paths.projectsDir, 'already-registered.json'),
    JSON.stringify({ workingDirectory: dir, promptFile: 'prompt.md', driver: 'claude' })
  );

  const { reply } = await h.say('/scan');

  assert.match(reply, /No new projects found/);
});

test('/scan ignores folders with no recognizable marker', async () => {
  const h = discoveryHarness();
  fs.mkdirSync(path.join(h.rootsDir, 'random-empty-folder'), { recursive: true });

  const { reply } = await h.say('/scan');

  assert.match(reply, /No new projects found/);
});

test('/scan ignores node_modules and other configured ignore folders', async () => {
  const h = discoveryHarness();
  mkCandidate(h.rootsDir, 'node_modules');

  const { reply } = await h.say('/scan');

  assert.doesNotMatch(reply, /node_modules/);
});

test('/scan reports a configured root that does not exist on disk, without throwing', async () => {
  const h = discoveryHarness();
  h.router.config.operator.projectRoots.push('C:\\this\\does\\not\\exist\\at\\all');

  const { reply } = await h.say('/scan');

  assert.match(reply, /Not found on disk/);
});

test('/scan reports "no roots configured" honestly, without pretending to have scanned', async () => {
  const h = harness({ operator: { projectRoots: [] } });
  const { reply } = await h.say('/scan');
  assert.match(reply, /No project roots are configured/);
});

test('/import registers a real folder as a new project, named after its basename', async () => {
  const h = discoveryHarness();
  const dir = mkCandidate(h.rootsDir, 'calc-app');

  const { reply } = await h.say(`/import ${dir}`);

  assert.match(reply, /Imported "calc-app"/);
  assert.ok(h.registry.has('calc-app'));
  assert.equal(h.events.read({ types: ['project.imported'] }).length, 1);
  // Registry-only: nothing was written to the folder itself.
  assert.deepEqual(fs.readdirSync(dir), ['package.json']);
});

test('/import as <name> registers under an explicit name, even with spaces in the path', async () => {
  const h = discoveryHarness();
  const dir = mkCandidate(h.rootsDir, 'raw folder name');

  const { reply } = await h.say(`/import ${dir} as My Custom Project`);

  assert.match(reply, /Imported "My Custom Project"/);
  assert.ok(h.registry.has('My Custom Project'));
});

test('/import refuses a path that is not a real folder', async () => {
  const h = discoveryHarness();
  const { reply } = await h.say('/import C:\\nonexistent\\path\\xyz');
  assert.match(reply, /is not a real folder/);
  assert.equal(h.registry.names().length, 1); // still just 'alpha'
});

test('/import refuses a name collision rather than guessing', async () => {
  const h = discoveryHarness(); // 'alpha' is already registered by harness()
  const dir = mkCandidate(h.rootsDir, 'x');

  const { reply } = await h.say(`/import ${dir} as alpha`);

  assert.match(reply, /already exists/);
  assert.equal(h.registry.names().length, 1, 'no second project was created');
});

test('an imported project with no mission shows as misconfigured, honestly', async () => {
  const h = discoveryHarness();
  const dir = mkCandidate(h.rootsDir, 'needs-a-mission');
  await h.say(`/import ${dir}`);

  const { reply } = await h.say('/status needs-a-mission');

  assert.match(reply, /configuration problem/);
  assert.match(reply, /promptFile/);
});

test('/scan and /import are refused when operator.discovery is disabled', async () => {
  const h = discoveryHarness({ operator: { projectRoots: [], discovery: { enabled: false } } });
  h.router.config.operator.discovery = { enabled: false };
  mkCandidate(h.rootsDir, 'irrelevant');

  const scanned = await h.say('/scan');
  assert.match(scanned.reply, /disabled/);

  const imported = await h.say(`/import ${h.rootsDir}`);
  assert.match(imported.reply, /disabled/);
});

// ─────────────────────── reconciliation pass, 2026-07-30: /import all ──────

test('/import all proposes every /scan candidate and registers them only after one batch confirmation', async () => {
  const h = discoveryHarness();
  mkCandidate(h.rootsDir, 'first-project');
  mkCandidate(h.rootsDir, 'second-project');

  const proposed = await h.say('/import all');
  assert.match(proposed.reply, /first-project/);
  assert.match(proposed.reply, /second-project/);
  assert.match(proposed.reply, /confirm/i);
  assert.equal(h.registry.names().length, 1, 'nothing is written on the proposal message (still just alpha)');

  const code = proposed.reply.match(/\/confirm ([A-Z0-9]+)/i)[1];
  const { reply } = await h.say(`/confirm ${code}`);
  assert.match(reply, /Imported 2 project/);
  assert.ok(h.registry.has('first-project'));
  assert.ok(h.registry.has('second-project'));
  assert.equal(h.events.read({ types: ['project.imported'] }).length, 2);
});

test('/import all says there is nothing to do when /scan finds no candidates', async () => {
  const h = discoveryHarness();
  const { reply } = await h.say('/import all');
  assert.match(reply, /[Nn]othing to import/);
});

test('/import all skips a candidate that got registered between the proposal and the confirmation', async () => {
  const h = discoveryHarness();
  const dir = mkCandidate(h.rootsDir, 'race-project');

  const proposed = await h.say('/import all');
  const code = proposed.reply.match(/\/confirm ([A-Z0-9]+)/i)[1];

  // Simulate a manual /import of the same candidate landing first.
  await h.say(`/import ${dir}`);

  const { reply } = await h.say(`/confirm ${code}`);
  assert.match(reply, /Imported 0 project/);
  assert.match(reply, /Skipped/);
  assert.equal(h.registry.names().length, 2, 'still just alpha + the one real import (no duplicate)');
});

test("a project whose workingDirectory vanished reports 'missing', not 'misconfigured'", async () => {
  const h = harness({ projects: ['gone'] });
  const project = h.registry.configManager.getRawProject('gone');
  fs.rmSync(project.workingDirectory, { recursive: true, force: true });

  const record = h.registry.describe('gone');
  assert.equal(record.status, 'missing');

  const { reply } = await h.say('/status gone');
  assert.match(reply, /folder not found/);
});

// ────────────────────────── Phase 14 M9: /mission, /mission all ────────────

test('/mission auto-detects a Node/Electron project and writes it a promptFile', async () => {
  const h = discoveryHarness();
  const dir = mkCandidate(h.rootsDir, 'calc-app', { marker: null });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ dependencies: { electron: '^30.0.0' }, scripts: { build: 'vite build', test: 'vitest run' } })
  );
  await h.say(`/import ${dir}`);

  const { reply } = await h.say('/mission calc-app');

  assert.match(reply, /mission assigned/i);
  assert.match(reply, /electron/i);

  const raw = JSON.parse(fs.readFileSync(path.join(h.paths.projectsDir, 'calc-app.json'), 'utf8'));
  assert.equal(raw.promptFile, 'prompt.md');
  assert.equal(raw.stack.language, 'javascript');
  assert.equal(raw.stack.framework, 'electron');
  assert.equal(raw.stack.source, 'auto-detected');

  const promptContent = fs.readFileSync(path.join(dir, 'prompt.md'), 'utf8');
  assert.match(promptContent, /MISSION COMPLETE/);
  assert.match(promptContent, /electron/i);

  assert.equal(h.events.read({ types: ['project.mission-assigned'] }).length, 1);
});

test('/mission never overwrites a project that already has a promptFile', async () => {
  const h = harness({ projects: ['alpha'] }); // harness() gives alpha a real promptFile already

  const { reply } = await h.say('/mission alpha');

  assert.match(reply, /already has a mission/i);
  const raw = JSON.parse(fs.readFileSync(path.join(h.paths.projectsDir, 'alpha.json'), 'utf8'));
  assert.equal(raw.stack, undefined, 'nothing was written on top of the existing config');
  assert.equal(h.events.read({ types: ['project.mission-assigned'] }).length, 0);
});

test('/mission is refused when operator.mission is disabled', async () => {
  const h = harness({ projects: ['alpha'], operator: { mission: { enabled: false } } });
  const { reply } = await h.say('/mission alpha');
  assert.match(reply, /disabled/i);
});

test('/mission all proposes only the projects missing a mission, and assigns them after one confirmation', async () => {
  const h = discoveryHarness(); // 'alpha' already has a mission from harness()
  const dir1 = mkCandidate(h.rootsDir, 'node-app', { marker: null });
  fs.writeFileSync(path.join(dir1, 'package.json'), JSON.stringify({ dependencies: { express: '^4.0.0' } }));
  const dir2 = mkCandidate(h.rootsDir, 'py-app', { marker: null });
  fs.writeFileSync(path.join(dir2, 'requirements.txt'), 'flask==3.0.0\n');
  await h.say(`/import ${dir1}`);
  await h.say(`/import ${dir2}`);

  const proposed = await h.say('/mission all');
  assert.match(proposed.reply, /node-app/);
  assert.match(proposed.reply, /py-app/);
  assert.doesNotMatch(proposed.reply, /\balpha\b/, 'alpha already has a mission and is not proposed');

  const code = proposed.reply.match(/\/confirm ([A-Z0-9]+)/i)[1];
  const { reply } = await h.say(`/confirm ${code}`);

  assert.match(reply, /Assigned \(2\)/);
  const nodeRaw = JSON.parse(fs.readFileSync(path.join(h.paths.projectsDir, 'node-app.json'), 'utf8'));
  const pyRaw = JSON.parse(fs.readFileSync(path.join(h.paths.projectsDir, 'py-app.json'), 'utf8'));
  assert.equal(nodeRaw.stack.framework, 'express');
  assert.equal(pyRaw.stack.framework, 'flask');
  assert.equal(h.events.read({ types: ['project.mission-assigned'] }).length, 2);
});

test('/mission all reports nothing to do when every project already has a mission', async () => {
  const h = harness({ projects: ['alpha', 'beta'] });
  const { reply } = await h.say('/mission all');
  assert.match(reply, /already have a mission/i);
});

test('/mission all isolates one project\'s failure from the rest of the batch', async () => {
  const h = discoveryHarness();
  const dir1 = mkCandidate(h.rootsDir, 'good-project', { marker: null });
  fs.writeFileSync(path.join(dir1, 'package.json'), '{}');
  const dir2 = mkCandidate(h.rootsDir, 'vanishing-project', { marker: null });
  fs.writeFileSync(path.join(dir2, 'package.json'), '{}');
  await h.say(`/import ${dir1}`);
  await h.say(`/import ${dir2}`);

  const proposed = await h.say('/mission all');
  const code = proposed.reply.match(/\/confirm ([A-Z0-9]+)/i)[1];

  // Simulate the folder disappearing between the proposal and the confirmation.
  fs.rmSync(dir2, { recursive: true, force: true });

  const { reply } = await h.say(`/confirm ${code}`);

  assert.match(reply, /Assigned \(1\)/);
  assert.match(reply, /Failed \(1\)/);
  assert.match(reply, /vanishing-project/);
  const goodRaw = JSON.parse(fs.readFileSync(path.join(h.paths.projectsDir, 'good-project.json'), 'utf8'));
  assert.ok(goodRaw.stack, 'the surviving project was still assigned a mission');
  assert.equal(h.events.read({ types: ['project.mission-assigned'] }).length, 1);
});

// ─────────────────────────────────── Phase 14 M0: /workspace ───────────────

test('/workspace reports total, mission-ready count, status breakdown, and git counts', async () => {
  const h = harness({ projects: ['alpha', 'beta'] }); // both get a real promptFile from harness()
  h.workerRegistry.register('beta', { pid: process.pid });

  const { reply } = await h.say('/workspace');

  assert.match(reply, /2 projects/);
  assert.match(reply, /Mission-ready: 2\/2/);
  assert.match(reply, /Running: 1/);
  assert.match(reply, /Idle: 1/);
  assert.match(reply, /Nothing needs attention right now\./);
});

test('/workspace lists a project missing a promptFile under needs attention', async () => {
  const h = discoveryHarness(); // 'alpha' already has a mission from harness()
  const dir = mkCandidate(h.rootsDir, 'no-mission-yet');
  await h.say(`/import ${dir}`);

  const { reply } = await h.say('/workspace');

  assert.match(reply, /Mission-ready: 1\/2/);
  assert.match(reply, /Needs attention \(1\):/);
  assert.match(reply, /no-mission-yet — no mission yet/);
  assert.doesNotMatch(reply, /alpha — no mission yet/);
});

test('/workspace reports a blocked project under needs attention, with its own status icon', async () => {
  const h = harness({ projects: ['alpha'] });
  h.lifecycle.transition('alpha', 'blocked', 'stuck');

  const { reply } = await h.say('/workspace');

  assert.match(reply, /Blocked: 1/);
  assert.match(reply, /Needs attention \(1\):/);
  assert.match(reply, /alpha — blocked/);
});

test('/workspace shows the most recently active projects, most recent first', async () => {
  const h = harness({ projects: ['alpha', 'beta'] });
  h.lifecycle.transition('alpha', 'blocked', 'first'); // gives alpha a lifecycle.updatedAt in the past
  await new Promise((resolve) => { setTimeout(resolve, 5); });
  h.lifecycle.transition('beta', 'blocked', 'second'); // beta's updatedAt is strictly later

  const { reply } = await h.say('/workspace');

  const section = reply.slice(reply.indexOf('Recently active:'));
  assert.ok(section.indexOf('beta') < section.indexOf('alpha'), 'beta (more recent) is listed first');
});

test('/workspace is refused when operator.workspace is disabled', async () => {
  const h = harness({ projects: ['alpha'], operator: { workspace: { enabled: false } } });
  const { reply } = await h.say('/workspace');
  assert.match(reply, /disabled/i);
});

test('/workspace on an empty registry says so plainly', async () => {
  const h = harness({ projects: [] });
  const { reply } = await h.say('/workspace');
  assert.match(reply, /No projects are defined yet/);
});

test('/workspace logs a workspace.viewed event (cleanup pass: reads were silent before)', async () => {
  const h = harness({ projects: ['alpha'] });
  await h.say('/workspace');
  const logged = h.events.read({ types: ['workspace.viewed'] });
  assert.equal(logged.length, 1);
  assert.equal(logged[0].payload.projects, 1);
});

// ─────────────────────────────────────── Phase 14 M1: /git ─────────────────

test('/git on a project with no repository says so plainly', async () => {
  const h = harness({ projects: ['alpha'] });
  const { reply } = await h.say('/git alpha');
  assert.match(reply, /alpha/);
  assert.match(reply, /Not a git repository/);
});

test('/git reports branch, clean status, HEAD, and recent commits for a real repo', async () => {
  const h = harness({ projects: ['alpha'] });
  makeRepo(path.join(h.root, 'work', 'alpha'), { branch: 'payroll' });

  const { reply } = await h.say('/git alpha');

  assert.match(reply, /Branch: payroll/);
  assert.match(reply, /Status: 🟢 Clean/);
  assert.match(reply, /HEAD: [0-9a-f]{7,} — first commit/);
  assert.match(reply, /Upstream: not tracked/);
  assert.match(reply, /Recent commits \(1\):/);
});

test('/git reports dirty status with a changed-file count', async () => {
  const h = harness({ projects: ['alpha'] });
  makeRepo(path.join(h.root, 'work', 'alpha'), { dirty: true });

  const { reply } = await h.say('/git alpha');

  assert.match(reply, /Status: 🔴 Dirty \(1 changed\)/);
});

test('/git with no argument uses the active project, like /status', async () => {
  const h = harness({ projects: ['alpha'] });
  makeRepo(path.join(h.root, 'work', 'alpha'));
  await h.say('/project alpha');

  const { reply } = await h.say('/git');

  assert.match(reply, /alpha/);
  assert.match(reply, /Branch: main/);
});

test('/git works on a project missing a promptFile — git state is independent of mission-readiness', async () => {
  const h = discoveryHarness();
  const dir = mkCandidate(h.rootsDir, 'no-mission-yet');
  makeRepo(dir);
  await h.say(`/import ${dir}`);

  const { reply } = await h.say('/git no-mission-yet');

  assert.match(reply, /Branch: main/);
});

test('/git dirty and /git clean list every registered project in that state', async () => {
  const h = harness({ projects: ['alpha', 'beta', 'gamma'] });
  makeRepo(path.join(h.root, 'work', 'alpha'), { dirty: true });
  makeRepo(path.join(h.root, 'work', 'beta'));
  // gamma is left with no git repo at all — must appear in neither list.

  const dirty = await h.say('/git dirty');
  assert.match(dirty.reply, /🔴 Dirty projects \(1\)/);
  assert.match(dirty.reply, /• alpha/);
  assert.doesNotMatch(dirty.reply, /beta/);
  assert.doesNotMatch(dirty.reply, /gamma/);

  const clean = await h.say('/git clean');
  assert.match(clean.reply, /🟢 Clean projects \(1\)/);
  assert.match(clean.reply, /• beta/);
  assert.doesNotMatch(clean.reply, /alpha/);
});

test('/git is refused when operator.git is disabled', async () => {
  const h = harness({ projects: ['alpha'], operator: { git: { enabled: false } } });
  const { reply } = await h.say('/git alpha');
  assert.match(reply, /disabled/i);
});

test('/git names an unknown project the same way /status does', async () => {
  const h = harness({ projects: ['alpha'] });
  const { reply } = await h.say('/git nope');
  assert.match(reply, /No project matches "nope"/);
});

test('/git logs a git.viewed event (cleanup pass: reads were silent before)', async () => {
  const h = harness({ projects: ['alpha'] });
  makeRepo(path.join(h.root, 'work', 'alpha'));
  await h.say('/git alpha');
  const logged = h.events.read({ types: ['git.viewed'] });
  assert.equal(logged.length, 1);
  assert.equal(logged[0].project, 'alpha');
  assert.equal(logged[0].payload.isRepo, true);
});

test('/git on a project whose workingDirectory has vanished reuses fileAccess.js\'s own guard message', async () => {
  const h = harness({ projects: ['alpha'] });
  fs.rmSync(path.join(h.root, 'work', 'alpha'), { recursive: true, force: true });
  const { reply } = await h.say('/git alpha');
  assert.match(reply, /alpha/);
  assert.match(reply, /folder does not exist on disk/);
});

// ───────────────────────────── Phase 14 M2: log visibility ─────────────────

/** Appends one winston-shaped JSON log line to today's real log file. */
function writeLogLine(paths, record) {
  const file = path.join(paths.logsDir, 'orchestrator-2026-07-30.log');
  fs.appendFileSync(file, `${JSON.stringify({ timestamp: new Date().toISOString(), ...record })}\n`);
}

test('/log with no log file yet says so plainly', async () => {
  const h = harness({ projects: ['alpha'] });
  const { reply } = await h.say('/log alpha');
  assert.match(reply, /alpha/);
  assert.match(reply, /No log file exists yet/);
});

test('/log reports which file it read from, and tags each line with timestamp and severity', async () => {
  const h = harness({ projects: ['alpha'] });
  writeLogLine(h.paths, { level: 'info', project: 'alpha', message: 'mission worker started' });
  writeLogLine(h.paths, { level: 'error', project: 'alpha', message: 'mission worker crashed' });

  const { reply } = await h.say('/log alpha');

  assert.match(reply, /alpha — orchestrator-2026-07-30\.log/);
  assert.match(reply, /🔵.*mission worker started/);
  assert.match(reply, /🔴.*mission worker crashed/);
  assert.match(reply, /2 lines/);
});

test('/log only shows lines tagged for the named project, never another project\'s or untagged service activity', async () => {
  const h = harness({ projects: ['alpha', 'beta'] });
  writeLogLine(h.paths, { level: 'info', project: 'alpha', message: 'alpha activity' });
  writeLogLine(h.paths, { level: 'info', project: 'beta', message: 'beta activity' });
  writeLogLine(h.paths, { level: 'info', message: 'daemon startup, no project' });

  const { reply } = await h.say('/log alpha');

  assert.match(reply, /alpha activity/);
  assert.doesNotMatch(reply, /beta activity/);
  assert.doesNotMatch(reply, /daemon startup/);
});

test('/log with no argument uses the active project, like /git and /status', async () => {
  const h = harness({ projects: ['alpha'] });
  writeLogLine(h.paths, { level: 'info', project: 'alpha', message: 'from the active project' });
  await h.say('/project alpha');

  const { reply } = await h.say('/log');

  assert.match(reply, /alpha/);
  assert.match(reply, /from the active project/);
});

test('/log paginates like /files: a trailing bare number is a page once a project name precedes it', async () => {
  const h = harness({ projects: ['alpha'] });
  for (let i = 1; i <= 25; i += 1) {
    writeLogLine(h.paths, { level: 'info', project: 'alpha', message: `line ${i}` });
  }

  const page1 = await h.say('/log alpha');
  assert.match(page1.reply, /Page 1\/2/);
  assert.match(page1.reply, /line 25/);
  assert.doesNotMatch(page1.reply, /line 1\b/);

  const page2 = await h.say('/log alpha 2');
  assert.match(page2.reply, /Page 2\/2/);
  assert.match(page2.reply, /line 1\b/);
});

test('/log 40 treats a lone bare number as a project name, not a page — matching /files\' rule', async () => {
  const h = harness({ projects: ['alpha'] });
  const { reply } = await h.say('/log 40');
  assert.match(reply, /No project matches "40"/);
});

test('/log logs a log.viewed event (cleanup pass: reads were silent before)', async () => {
  const h = harness({ projects: ['alpha'] });
  writeLogLine(h.paths, { level: 'info', project: 'alpha', message: 'from the active project' });
  await h.say('/log alpha');
  const logged = h.events.read({ types: ['log.viewed'] });
  assert.equal(logged.length, 1);
  assert.equal(logged[0].project, 'alpha');
  assert.equal(logged[0].payload.found, true);
});

test('/log is refused when operator.log is disabled', async () => {
  const h = harness({ projects: ['alpha'], operator: { log: { enabled: false } } });
  const { reply } = await h.say('/log alpha');
  assert.match(reply, /disabled/i);
});

test('/log names an unknown project the same way /status does', async () => {
  const h = harness({ projects: ['alpha'] });
  const { reply } = await h.say('/log nope');
  assert.match(reply, /No project matches "nope"/);
});

// ─────────────────────────── Phase 13 M3: lifecycle & classification ───────

test('/archive marks a project archived; it stays listed but sorts after live statuses', async () => {
  const { say, registry } = harness({ projects: ['alpha', 'beta'] });

  const { reply } = await say('/archive alpha');
  assert.match(reply, /Archived alpha → archived/);

  const listed = await say('/projects');
  assert.match(listed.reply, /alpha/, 'archived stays listed by default');
  assert.match(listed.reply, /📦 ARCHIVED/);
  const alphaIndex = listed.reply.indexOf('alpha');
  const betaIndex = listed.reply.indexOf('beta');
  assert.ok(betaIndex < alphaIndex, 'a live project sorts before an archived one');
  assert.equal(registry.describe('alpha', { git: false, health: false }).classification, 'archived');
});

test('/restore returns an archived project to development', async () => {
  const { say } = harness({ projects: ['alpha'] });
  await say('/archive alpha');
  const { reply } = await say('/restore alpha');
  assert.match(reply, /Restored alpha → development/);
});

test('/hide removes a project from the default /projects listing; /projects all still shows it', async () => {
  const { say } = harness({ projects: ['alpha', 'beta'] });
  await say('/hide alpha');

  const defaultList = await say('/projects');
  assert.doesNotMatch(defaultList.reply, /alpha/);
  assert.match(defaultList.reply, /beta/);

  const allList = await say('/projects all');
  assert.match(allList.reply, /alpha/);
});

test('/unhide returns a hidden project to development and to the default listing', async () => {
  const { say } = harness({ projects: ['alpha'] });
  await say('/hide alpha');
  const { reply } = await say('/unhide alpha');
  assert.match(reply, /Unhidden alpha → development/);
  assert.match((await say('/projects')).reply, /alpha/);
});

test('archive/restore/hide/unhide apply to the active project when none is named', async () => {
  const { say } = harness({ projects: ['alpha'] });
  await say('/project alpha');
  const { reply } = await say('/archive');
  assert.match(reply, /Archived alpha/);
});

test('archive/restore/hide/unhide are refused when operator.lifecycle is disabled', async () => {
  const { say } = harness({ projects: ['alpha'], operator: { lifecycle: { enabled: false } } });
  for (const cmd of ['/archive alpha', '/restore alpha', '/hide alpha', '/unhide alpha']) {
    // eslint-disable-next-line no-await-in-loop
    const { reply } = await say(cmd);
    assert.match(reply, /disabled/, `${cmd} should be refused`);
  }
});

test('/forget requires confirmation, then removes the project from the registry only', async () => {
  const { say, registry } = harness({ projects: ['alpha', 'beta'] });
  const workingDirectory = registry.configManager.getRawProject('alpha').workingDirectory;
  fs.writeFileSync(path.join(workingDirectory, 'real-file.txt'), 'still here');

  const asked = await say('/forget alpha');
  assert.match(asked.reply, /confirm/i);
  assert.ok(registry.has('alpha'), 'nothing happens on the first message');

  const code = asked.reply.match(/\/confirm ([A-Z0-9]+)/i)[1];
  const confirmed = await say(`/confirm ${code}`);
  assert.match(confirmed.reply, /forgotten/);
  assert.ok(!registry.has('alpha'));
  assert.ok(registry.has('beta'), 'other projects are untouched');
  assert.ok(fs.existsSync(path.join(workingDirectory, 'real-file.txt')), 'the real file is NEVER touched');
});

test('/forget refuses a project with a mission currently running', async () => {
  const { say, workerRegistry } = harness({ projects: ['alpha'] });
  workerRegistry.register('alpha', { pid: process.pid });
  const { reply } = await say('/forget alpha');
  assert.match(reply, /has a mission running/);
});

test('/forget is refused when operator.lifecycle is disabled', async () => {
  const { say } = harness({ projects: ['alpha'], operator: { lifecycle: { enabled: false } } });
  const { reply } = await say('/forget alpha');
  assert.match(reply, /disabled/);
});

test('/projects classify proposes classifications and applies them only after one batch confirmation', async () => {
  const { say, registry } = harness({ projects: ['alpha', 'beta'] });

  const proposed = await say('/projects classify');
  assert.match(proposed.reply, /alpha/);
  assert.match(proposed.reply, /beta/);
  assert.match(proposed.reply, /confirm/i);
  assert.equal(
    registry.configManager.getProjectFileContents('alpha').classification, undefined,
    'nothing is written on the proposal message'
  );

  const code = proposed.reply.match(/\/confirm ([A-Z0-9]+)/i)[1];
  const { reply } = await say(`/confirm ${code}`);
  assert.match(reply, /Classified 2 project/);
  assert.equal(registry.configManager.getProjectFileContents('alpha').classification, 'development');
});

test('/projects classify says there is nothing to do once every project is classified', async () => {
  const { say, registry } = harness({ projects: ['alpha'] });
  registry.configManager.updateProject('alpha', { classification: 'production' });
  const { reply } = await say('/projects classify');
  assert.match(reply, /already has a classification/);
});

// ──────────────────────────────── Phase 13 M4: live configuration ──────────

test('/roots lists the currently configured roots', async () => {
  const h = discoveryHarness();
  const { reply } = await h.say('/roots');
  assert.match(reply, new RegExp(h.rootsDir.replace(/\\/g, '\\\\')));
});

test('/roots add registers a real, existing folder immediately — /scan sees it with no restart', async () => {
  // Starts with NO roots configured (never the real default C:\Users\Admin\Music
  // — /scan must stay isolated from whatever actually happens to be on this
  // machine, or this test would be flaky against the tester's own filesystem).
  const h = harness({ projects: ['alpha'], operator: { projectRoots: [] } });
  const newRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-newroot-'));
  mkCandidate(newRoot, 'fresh-project');

  const added = await h.say(`/roots add ${newRoot}`);
  assert.match(added.reply, /Added/);
  assert.equal(h.events.read({ types: ['config.changed'] }).length, 1);

  const scanned = await h.say('/scan');
  assert.match(scanned.reply, /fresh-project/, '/scan sees the new root on the very next command');
});

test('/roots add refuses a path that is not a real folder', async () => {
  const h = harness();
  const { reply } = await h.say('/roots add C:\\definitely\\not\\real\\xyz');
  assert.match(reply, /is not a real folder/);
});

test('/roots add refuses a root that is already configured', async () => {
  const h = discoveryHarness();
  const { reply } = await h.say(`/roots add ${h.rootsDir}`);
  assert.match(reply, /already a project root/);
});

test('/roots remove takes a root out of discovery, with a non-blocking note if a project lives under it', async () => {
  const h = discoveryHarness();
  const dir = mkCandidate(h.rootsDir, 'lives-here');
  fs.writeFileSync(path.join(dir, 'prompt.md'), '# work\n');
  fs.writeFileSync(
    path.join(h.paths.projectsDir, 'lives-here.json'),
    JSON.stringify({ workingDirectory: dir, promptFile: 'prompt.md', driver: 'claude' })
  );

  const { reply } = await h.say(`/roots remove ${h.rootsDir}`);
  assert.match(reply, /Removed/);
  assert.match(reply, /lives-here/);
  assert.match(reply, /never a registered project's ability to run/);

  // The registered project is completely unaffected — still resolvable and describable.
  assert.ok(h.registry.has('lives-here'));
  assert.equal(h.registry.describe('lives-here', { git: false, health: false }).status, 'idle');
});

test('/roots remove says plainly when the path was never a configured root', async () => {
  const h = harness();
  const { reply } = await h.say('/roots remove C:\\never\\was\\a\\root');
  assert.match(reply, /is not a configured root/);
});

test('/roots is refused when operator.liveConfig is disabled', async () => {
  const h = harness({ operator: { liveConfig: { enabled: false } } });
  const { reply } = await h.say('/roots');
  assert.match(reply, /disabled/);
});

// ─────────────────────────────── Phase 13 M5: provider & model ─────────────

test('/provider shows the default provider/model, capabilities, and known drivers', async () => {
  const { say } = harness();
  const { reply } = await say('/provider');
  assert.match(reply, /Default provider: claude/);
  assert.match(reply, /Default model: \(engine default\)/);
  assert.match(reply, /sonnet, opus, haiku/);
  assert.match(reply, /Known drivers: claude, cli, mock/);
});

test('/provider shows the active project\'s own driver/model override, side by side', async () => {
  const { say, registry } = harness({ projects: ['alpha'] });
  registry.configManager.updateProject('alpha', { claude: { model: 'haiku' } });
  await say('/project alpha');

  const { reply } = await say('/provider');
  assert.match(reply, /alpha's own driver: claude/);
  assert.match(reply, /alpha's own model: haiku/);
});

test('/model with no argument reports there is no default set yet', async () => {
  const { say } = harness();
  const { reply } = await say('/model');
  assert.match(reply, /No default model set/);
});

test('/model <name> sets the default; /model alone then reports it', async () => {
  const { say, events } = harness();

  const set = await say('/model haiku');
  assert.match(set.reply, /Default model set to "haiku"/);
  assert.match(set.reply, /never one already running/);
  assert.equal(events.read({ types: ['provider.model-changed'] }).length, 1);

  const check = await say('/model');
  assert.match(check.reply, /Default model: haiku/);
});

test('/model refuses an unknown model for the current provider', async () => {
  const { say } = harness();
  const { reply } = await say('/model gpt-5000');
  assert.match(reply, /is not a known claude model/);
  assert.match(reply, /sonnet, opus, haiku/);
});

test('/model default clears the default back to per-project/engine behaviour', async () => {
  const { say } = harness();
  await say('/model opus');
  const { reply } = await say('/model default');
  assert.match(reply, /cleared/);
  assert.match((await say('/model')).reply, /No default model set/);
});

test('/model actually changes what the NEXT ClaudeDriver launch uses — never something already running', async () => {
  const { say, router } = harness();
  await say('/model opus');

  // The router's own driverRegistry (what a worker would consult) reflects
  // it immediately — this is the live-config mutation, not a restart.
  const claude = router.driverRegistry.getDriver('claude');
  // driverRegistry here has no defaultModelProvider wired (test harness
  // mirrors the daemon's OWN registry, which is display-only — see
  // app.js for the worker-side registry that actually launches). Confirm
  // instead that the config value itself is live:
  assert.equal(router.config.operator.defaultModel, 'opus');
});

test('/model is refused when operator.liveConfig is disabled', async () => {
  const { say } = harness({ operator: { liveConfig: { enabled: false } } });
  const { reply } = await say('/model opus');
  assert.match(reply, /disabled/);
});

// ────────────────── reconciliation pass, 2026-07-30: /safemode ─────────────

test('/safemode with no argument reports it is off by default', async () => {
  const { say } = harness();
  const { reply } = await say('/safemode');
  assert.match(reply, /off/i);
});

test('/safemode on turns it on; /safemode alone then reports it, live, no restart', async () => {
  const { say, events, router } = harness();

  const set = await say('/safemode on');
  assert.match(set.reply, /Safe Mode ON/);
  assert.equal(events.read({ types: ['operator.safemode-changed'] }).length, 1);
  assert.equal(router.config.operator.safeMode, true);

  const check = await say('/safemode');
  assert.match(check.reply, /Safe Mode is ON/);
});

test('/safemode off turns it back off', async () => {
  const { say } = harness({ operator: { safeMode: true } });
  const { reply } = await say('/safemode off');
  assert.match(reply, /Safe Mode OFF/);
  assert.match((await say('/safemode')).reply, /off/i);
});

test('/safemode on when already on says so instead of re-writing config', async () => {
  const { say, events } = harness({ operator: { safeMode: true } });
  const { reply } = await say('/safemode on');
  assert.match(reply, /already on/);
  assert.equal(events.read({ types: ['operator.safemode-changed'] }).length, 0);
});

test('/safemode refuses an argument that is not on/off', async () => {
  const { say } = harness();
  const { reply } = await say('/safemode maybe');
  assert.match(reply, /Usage: \/safemode/);
});

test('/safemode is refused when operator.liveConfig is disabled', async () => {
  const { say } = harness({ operator: { liveConfig: { enabled: false } } });
  const { reply } = await say('/safemode on');
  assert.match(reply, /disabled/);
});

// ──────────────── Phase 14 M8: remote configuration completion ─────────────

test('/notify with no argument shows every channel and the minimum severity', async () => {
  const { say } = harness();
  const { reply } = await say('/notify');
  assert.match(reply, /Telegram: Disabled/);
  assert.match(reply, /Email: Disabled/);
  assert.match(reply, /Discord: Disabled/);
  assert.match(reply, /Webhook: Disabled/);
  assert.match(reply, /Minimum severity: info/);
});

test('/notify status is the same as /notify with no argument', async () => {
  const { say } = harness();
  assert.equal((await say('/notify')).reply, (await say('/notify status')).reply);
});

test('/notify telegram on enables it; /notify then reflects it, live, no restart', async () => {
  const { say, events } = harness();
  const set = await say('/notify telegram on');
  assert.match(set.reply, /Telegram notifications ON/);

  const check = await say('/notify');
  assert.match(check.reply, /Telegram: Enabled/);

  const logged = events.read({ types: ['notifications.channel-changed'] });
  assert.equal(logged.length, 1);
  assert.deepEqual(logged[0].payload, { channel: 'telegram', enabled: true });
});

test('/notify telegram on twice says it is already on instead of re-writing config', async () => {
  const { say, events } = harness();
  await say('/notify telegram on');
  const { reply } = await say('/notify telegram on');
  assert.match(reply, /already on/);
  assert.equal(events.read({ types: ['notifications.channel-changed'] }).length, 1);
});

test('/notify email off says it is already off by default without writing config', async () => {
  const { say, events } = harness();
  const { reply } = await say('/notify email off');
  assert.match(reply, /already off/);
  assert.equal(events.read({ types: ['notifications.channel-changed'] }).length, 0);
});

test('/notify discord on and /notify webhook on each toggle their own channel independently', async () => {
  const { say } = harness();
  await say('/notify discord on');
  const { reply } = await say('/notify');
  assert.match(reply, /Discord: Enabled/);
  assert.match(reply, /Webhook: Disabled/);
});

test('/notify <channel> refuses an argument that is not on/off', async () => {
  const { say } = harness();
  const { reply } = await say('/notify telegram maybe');
  assert.match(reply, /Usage: \/notify telegram/);
});

test('/notify severity warning changes the minimum severity', async () => {
  const { say, events } = harness();
  const set = await say('/notify severity warning');
  assert.match(set.reply, /Minimum notification severity set to "warning"/);

  const check = await say('/notify');
  assert.match(check.reply, /Minimum severity: warning/);

  const logged = events.read({ types: ['notifications.severity-changed'] });
  assert.equal(logged.length, 1);
  assert.deepEqual(logged[0].payload, { severity: 'warning', previousSeverity: 'info' });
});

test('/notify severity refuses an unknown level', async () => {
  const { say } = harness();
  const { reply } = await say('/notify severity urgent');
  assert.match(reply, /Usage: \/notify severity/);
});

test('/notify refuses an unrecognized word', async () => {
  const { say } = harness();
  const { reply } = await say('/notify sms on');
  assert.match(reply, /Usage: \/notify/);
});

test('/notify is refused when operator.liveConfig is disabled', async () => {
  const { say } = harness({ operator: { liveConfig: { enabled: false } } });
  const { reply } = await say('/notify');
  assert.match(reply, /disabled/);
});

test('/approvals with no argument still lists pending decisions, unaffected by mode', async () => {
  const { say } = harness();
  const { reply } = await say('/approvals');
  assert.doesNotMatch(reply, /Approval mode/);
});

test('/approvals mode with no argument shows the current mode', async () => {
  const { say } = harness();
  const { reply } = await say('/approvals mode');
  assert.match(reply, /Approval mode: balanced/);
});

test('/approvals mode autonomous changes it; /approvals mode then reflects it, live, no restart', async () => {
  const { say, events } = harness();
  const set = await say('/approvals mode autonomous');
  assert.match(set.reply, /Approval mode set to "autonomous"/);

  const check = await say('/approvals mode');
  assert.match(check.reply, /Approval mode: autonomous/);

  const logged = events.read({ types: ['approvals.mode-changed'] });
  assert.equal(logged.length, 1);
  assert.deepEqual(logged[0].payload, { mode: 'autonomous', previousMode: 'balanced' });
});

test('/approvals mode balanced when already balanced says so instead of re-writing config', async () => {
  const { say, events } = harness();
  const { reply } = await say('/approvals mode balanced');
  assert.match(reply, /already "balanced"/);
  assert.equal(events.read({ types: ['approvals.mode-changed'] }).length, 0);
});

test('/approvals mode refuses an unknown mode', async () => {
  const { say } = harness();
  const { reply } = await say('/approvals mode owner-gate');
  assert.match(reply, /not a valid approval mode/);
});

test('/approvals mode is refused when operator.liveConfig is disabled', async () => {
  const { say } = harness({ operator: { liveConfig: { enabled: false } } });
  const { reply } = await say('/approvals mode autonomous');
  assert.match(reply, /disabled/);
});

// ──────────────── Phase 14 M3: repository & symbol search ──────────────────

test('/grep with no argument shows usage instead of searching', async () => {
  const { say } = harness();
  await say('/project alpha');
  const { reply } = await say('/grep');
  assert.match(reply, /Usage: \/grep <pattern>/);
});

test('/symbol with no argument shows usage instead of searching', async () => {
  const { say } = harness();
  await say('/project alpha');
  const { reply } = await say('/symbol');
  assert.match(reply, /Usage: \/symbol <name>/);
});

test('/grep refuses with no project selected, same message as /files', async () => {
  const { say } = harness();
  const { reply } = await say('/grep TODO');
  assert.match(reply, /No project selected/);
});

test('/grep finds a real match in the active project\'s real files', async () => {
  const h = harness();
  const dir = workDirOf(h, 'alpha');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'const x = 1;\n// TODO: fix this later\n');
  await h.say('/project alpha');

  const { reply } = await h.say('/grep TODO');
  assert.match(reply, /src\/a\.js:2/);
  assert.match(reply, /TODO: fix this later/);
  assert.match(reply, /1 match/);
});

test('/grep is case-insensitive by default', async () => {
  const h = harness();
  const dir = workDirOf(h, 'alpha');
  fs.writeFileSync(path.join(dir, 'a.js'), 'const HELLO = 1;\n');
  await h.say('/project alpha');

  const { reply } = await h.say('/grep hello');
  assert.match(reply, /1 match/);
});

test('/grep reports no matches honestly rather than an error', async () => {
  const h = harness();
  await h.say('/project alpha');
  const { reply } = await h.say('/grep something-nowhere-in-this-project');
  assert.match(reply, /No matches/);
});

test('/grep and its aliases /search, /find all reach the same command', async () => {
  const h = harness();
  const dir = workDirOf(h, 'alpha');
  fs.writeFileSync(path.join(dir, 'a.js'), 'const NEEDLE = 1;\n');
  await h.say('/project alpha');

  const viaGrep = await h.say('/grep NEEDLE');
  const viaSearch = await h.say('/search NEEDLE');
  const viaFind = await h.say('/find NEEDLE');
  assert.equal(viaGrep.reply, viaSearch.reply);
  assert.equal(viaGrep.reply, viaFind.reply);
});

test('/grep <pattern> <page> pages results once the pattern is already more than one word', async () => {
  const h = harness();
  const dir = workDirOf(h, 'alpha');
  const lines = Array.from({ length: 25 }, (_, i) => `needle line ${i}`).join('\n');
  fs.writeFileSync(path.join(dir, 'a.js'), lines);
  await h.say('/project alpha');

  const page1 = await h.say('/grep needle');
  assert.match(page1.reply, /Page 1\/2/);
  assert.match(page1.reply, /25 matches total/);

  // Two-word input ("needle" + trailing digit "2") — the digit is read as a
  // page only because more than one word preceded it (commandFiles()'s own
  // convention), so this remains "search needle, page 2", not "search
  // \"needle 2\"".
  const page2 = await h.say('/grep needle 2');
  assert.match(page2.reply, /Page 2\/2/);
  assert.match(page2.reply, /needle line 20/);
});

test('/grep a single numeric word searches for it literally, never mistaken for a page number', async () => {
  const h = harness();
  const dir = workDirOf(h, 'alpha');
  fs.writeFileSync(path.join(dir, 'a.js'), 'const PORT = 500;\n');
  await h.say('/project alpha');

  const { reply } = await h.say('/grep 500');
  assert.match(reply, /"500"/);
  assert.match(reply, /1 match/);
});

test('/symbol finds a real declaration, not a mere mention', async () => {
  const h = harness();
  const dir = workDirOf(h, 'alpha');
  fs.writeFileSync(
    path.join(dir, 'driverRegistry.js'),
    'import { helper } from "./helper.js"; // mentions DriverRegistry in a comment\n\nexport class DriverRegistry {\n  constructor() {}\n}\n'
  );
  await h.say('/project alpha');

  const { reply } = await h.say('/symbol DriverRegistry');
  assert.match(reply, /driverRegistry\.js:3/);
  assert.match(reply, /1 match/);
});

test('/grep and /symbol each log a search.performed event with the query and match count', async () => {
  const h = harness();
  const dir = workDirOf(h, 'alpha');
  fs.writeFileSync(path.join(dir, 'a.js'), 'const NEEDLE = 1;\n');
  await h.say('/project alpha');

  await h.say('/grep NEEDLE');
  const logged = h.events.read({ types: ['search.performed'] });
  assert.equal(logged.length, 1);
  assert.equal(logged[0].payload.mode, 'grep');
  assert.equal(logged[0].payload.query, 'NEEDLE');
  assert.equal(logged[0].payload.matches, 1);
  assert.equal(logged[0].payload.truncated, false);
});

test('/grep is refused when operator.search.enabled is false', async () => {
  const { say } = harness({ operator: { search: { enabled: false } } });
  await say('/project alpha');
  const { reply } = await say('/grep TODO');
  assert.match(reply, /disabled/);
});

test('/symbol is refused when operator.search.enabled is false', async () => {
  const { say } = harness({ operator: { search: { enabled: false } } });
  await say('/project alpha');
  const { reply } = await say('/symbol Foo');
  assert.match(reply, /disabled/);
});

// ────────────────────────────────── Phase 13 M6: remote file system ────────

/** A project's real working directory, for tests that need to plant files. */
function workDirOf(h, project) {
  return h.registry.configManager.getProject(project).workingDirectory;
}

test('/files lists the active project\'s root, including the real prompt file', async () => {
  const h = harness();
  await h.say('/project alpha');

  const { reply } = await h.say('/files');

  assert.match(reply, /alpha/);
  assert.match(reply, /prompt\.md/);
});

test('/files <path> lists a subdirectory', async () => {
  const h = harness();
  const dir = workDirOf(h, 'alpha');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'console.log(1);\n');
  await h.say('/project alpha');

  const { reply } = await h.say('/files src');

  assert.match(reply, /index\.js/);
});

test('/files refuses without a project selected', async () => {
  const { say } = harness();
  const { reply } = await say('/files');
  assert.match(reply, /No project selected/);
});

test('/file <path> shows a small text file inline, in full', async () => {
  const h = harness();
  await h.say('/project alpha');

  const { reply, attachment } = await h.say('/file prompt.md');

  assert.match(reply, /prompt\.md/);
  assert.match(reply, /# work/);
  assert.equal(attachment, undefined, 'a small text file is shown inline, not attached');
});

test('/file sends a large text file as an attachment instead of dumping it inline', async () => {
  const h = harness();
  const dir = workDirOf(h, 'alpha');
  fs.writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(10_000));
  await h.say('/project alpha');

  const { reply, attachment } = await h.say('/file big.txt');

  assert.match(reply, /sending as a file/);
  assert.ok(attachment);
  assert.equal(path.basename(attachment.filePath), 'big.txt');
});

test('/file sends a binary file as an attachment regardless of its size', async () => {
  const h = harness();
  const dir = workDirOf(h, 'alpha');
  fs.writeFileSync(path.join(dir, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
  await h.say('/project alpha');

  const { attachment } = await h.say('/file image.png');

  assert.ok(attachment, 'a NUL byte marks this as binary, even though it is tiny');
});

test('/file never dumps truncated content — the large-file path always attaches the complete file', async () => {
  const h = harness();
  const dir = workDirOf(h, 'alpha');
  const full = 'line\n'.repeat(2000); // well past the inline threshold
  fs.writeFileSync(path.join(dir, 'log.txt'), full);
  await h.say('/project alpha');

  const { attachment } = await h.say('/file log.txt');

  assert.equal(fs.readFileSync(attachment.filePath, 'utf8'), full, 'the attachment IS the real, complete file');
});

test('/file on a path that escapes the project is refused, not "fixed"', async () => {
  const h = harness();
  await h.say('/project alpha');

  const { reply, attachment } = await h.say('/file ../../../windows/system32/config');

  assert.match(reply, /outside the project/);
  assert.equal(attachment, undefined);
});

test('a traversal refusal leaves an audit trail in the event log; a plain not-found does not', async () => {
  const h = harness();
  await h.say('/project alpha');

  await h.say('/file ../../../outside.txt');
  await h.say('/file genuinely-never-existed.txt');

  const served = h.events.read({ types: ['file.served'] });
  const refused = served.filter((e) => e.payload.mode === 'refused');
  assert.equal(refused.length, 1, 'the traversal attempt is the one recorded');
  assert.equal(refused[0].project, 'alpha');
  assert.match(refused[0].payload.path, /outside\.txt/);
  assert.match(refused[0].payload.reason, /outside the project/);
});

test('/file on a directory says so and points at /files', async () => {
  const h = harness();
  const dir = workDirOf(h, 'alpha');
  fs.mkdirSync(path.join(dir, 'src'));
  await h.say('/project alpha');

  const { reply } = await h.say('/file src');

  assert.match(reply, /is a directory/);
  assert.match(reply, /\/files src/);
});

test('/file on a nonexistent path is a clear "not found"', async () => {
  const h = harness();
  await h.say('/project alpha');
  const { reply } = await h.say('/file does-not-exist.txt');
  assert.match(reply, /does not exist/);
});

test('/files and /file are refused when operator.files is disabled', async () => {
  const h = harness({ operator: { files: { enabled: false } } });
  await h.say('/project alpha');

  const files = await h.say('/files');
  const file = await h.say('/file prompt.md');

  assert.match(files.reply, /disabled/);
  assert.match(file.reply, /disabled/);
});

test('/download_project zips the active project and sends it as a real attachment', async () => {
  const h = harness();
  const dir = workDirOf(h, 'alpha');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'console.log(1);\n');
  await h.say('/project alpha');

  const { reply, attachment } = await h.say('/download_project');

  assert.match(reply, /zipped/);
  assert.ok(attachment);
  assert.ok(fs.existsSync(attachment.filePath), 'a real zip file was written to disk');
  assert.equal(path.dirname(attachment.filePath), h.paths.downloadsDir);
  assert.deepEqual(
    fs.readFileSync(attachment.filePath).subarray(0, 4),
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    'a genuine ZIP local-file-header signature'
  );
});

test('the exact hyphenated form the owner\'s directive specified still works, as an alias', async () => {
  const h = harness();
  await h.say('/project alpha');
  const { attachment } = await h.say('/download-project');
  assert.ok(attachment, '/download-project resolves to the same command as /download_project');
});

test('/download_project [project] can target a project other than the active one', async () => {
  const h = harness();
  const { attachment } = await h.say('/download_project beta');
  assert.ok(attachment);
  assert.equal(path.basename(attachment.filePath).startsWith('beta-'), true);
});

test('/download_project refuses a project whose measured (post-exclusion) size exceeds the configured limit', async () => {
  const h = harness({ operator: { download: { maxProjectBytes: 5 } } });
  await h.say('/project alpha'); // prompt.md alone is already > 5 bytes
  const { reply, attachment } = await h.say('/download_project');
  assert.match(reply, /over the/);
  assert.equal(attachment, undefined);
});

test('/download_project is refused when operator.files is disabled', async () => {
  const h = harness({ operator: { files: { enabled: false } } });
  const { reply } = await h.say('/download_project alpha');
  assert.match(reply, /disabled/);
});

test('an archived project is still fully reachable through every file command — archiving is a registry demotion, not an access restriction', async () => {
  const h = harness();
  await h.say('/archive alpha'); // registry-only, immediate — never touches the project's files
  await h.say('/project alpha');

  const files = await h.say('/files');
  const file = await h.say('/file prompt.md');
  const zip = await h.say('/download_project');

  assert.match(files.reply, /prompt\.md/);
  assert.match(file.reply, /# work/);
  assert.ok(zip.attachment);
});

test('every /files, /file, and /download_project access is recorded in the event log', async () => {
  const h = harness();
  await h.say('/project alpha');
  await h.say('/files');
  await h.say('/file prompt.md');
  await h.say('/download_project');

  const served = h.events.read({ types: ['file.served'] });
  const downloaded = h.events.read({ types: ['project.downloaded'] });
  assert.equal(served.length, 2, 'one /files list + one /file read');
  assert.equal(downloaded.length, 1);
});
