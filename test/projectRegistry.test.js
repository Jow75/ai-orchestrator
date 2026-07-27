/**
 * Unit tests for operator/projectRegistry.js — Phase 12 M2 Priority 1.
 *
 * "Every project must have: name, description, path, status, current worker,
 * last activity, branch, latest commit, health. The daemon is the source of
 * truth."
 *
 * Built on a REAL throwaway installation with real stores, because the value
 * of this module is entirely in whether it reads the right files: a mocked
 * version would prove only that the mock was wired up. The git assertions run
 * against a real (tiny) repository for the same reason — branch and commit are
 * exactly the fields where an invented value would be most convincing and most
 * wrong.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ConfigManager from '../src/config/configManager.js';
import ProjectRegistry, { PROJECT_STATUSES } from '../src/operator/projectRegistry.js';
import WorkerRegistry from '../src/daemon/workerRegistry.js';
import TaskQueue from '../src/mission/taskQueue.js';
import MissionLifecycle from '../src/mission/missionLifecycle.js';
import ApprovalStore from '../src/approvals/approvalStore.js';
import SessionManager from '../src/state/sessionManager.js';
import { ensureRuntimeDirs } from '../src/infra/paths.js';
import { writeJsonAtomic } from '../src/state/statePersistence.js';
import { silentLogger } from '../src/infra/logger.js';

const DEAD_PID = 0x7ffffff0;

/** A throwaway installation root with resolved paths and empty state. */
function installation() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-registry-'));
  const configManager = new ConfigManager({ rootDir: root });
  configManager.load();
  const paths = configManager.getPaths();
  ensureRuntimeDirs(paths);
  fs.mkdirSync(paths.projectsDir, { recursive: true });
  return { root, configManager, paths };
}

/** Define a project, with a real working directory and prompt file. */
function defineProject(paths, name, extra = {}) {
  const workingDirectory = path.join(paths.root, 'work', name);
  fs.mkdirSync(workingDirectory, { recursive: true });
  fs.writeFileSync(path.join(workingDirectory, 'prompt.md'), '# do the work\n');
  fs.writeFileSync(
    path.join(paths.projectsDir, `${name}.json`),
    JSON.stringify({ workingDirectory, promptFile: 'prompt.md', driver: 'mock', ...extra })
  );
  return workingDirectory;
}

function buildRegistry(configManager, paths) {
  const lifecycle = new MissionLifecycle({ lifecycleDir: paths.lifecycleDir, logger: silentLogger });
  return {
    lifecycle,
    taskQueue: new TaskQueue({ tasksDir: paths.tasksDir, logger: silentLogger, lifecycle }),
    approvalStore: new ApprovalStore({ approvalsDir: paths.approvalsDir, logger: silentLogger }),
    workerRegistry: new WorkerRegistry({ workersDir: paths.workersDir, logger: silentLogger }),
    registry: new ProjectRegistry({
      configManager,
      workerRegistry: new WorkerRegistry({ workersDir: paths.workersDir, logger: silentLogger }),
      taskQueue: new TaskQueue({ tasksDir: paths.tasksDir, logger: silentLogger, lifecycle }),
      lifecycle,
      approvalStore: new ApprovalStore({ approvalsDir: paths.approvalsDir, logger: silentLogger }),
      sessionManager: new SessionManager({ sessionsDir: paths.sessionsDir, logger: silentLogger }),
      heartbeatFile: paths.heartbeatFile,
      logger: silentLogger,
    }),
  };
}

test('a defined project with nothing happening reports as idle, with its real path', () => {
  const { configManager, paths } = installation();
  const workingDirectory = defineProject(paths, 'calculator', { description: 'A calculator.' });
  const { registry } = buildRegistry(configManager, paths);

  const record = registry.describe('calculator', { health: false });

  assert.equal(record.name, 'calculator');
  assert.equal(record.description, 'A calculator.');
  assert.equal(record.path, workingDirectory);
  assert.equal(record.status, 'idle');
  assert.equal(record.lastActivity, undefined, 'a project that never ran has no activity');
});

test('a project with a live worker reports as running, with the worker', () => {
  const { configManager, paths } = installation();
  defineProject(paths, 'finisher');
  const { registry, workerRegistry } = buildRegistry(configManager, paths);
  workerRegistry.register('finisher', { pid: process.pid, mode: 'worker', daemonPid: process.pid });

  const record = registry.describe('finisher', { health: false, git: false });

  assert.equal(record.status, 'running');
  assert.equal(record.worker.pid, process.pid);
  assert.equal(record.worker.mode, 'worker');
});

test('a worker record whose process is gone does not keep a project "running"', () => {
  const { configManager, paths } = installation();
  defineProject(paths, 'finisher');
  const { registry, workerRegistry } = buildRegistry(configManager, paths);
  workerRegistry.register('finisher', { pid: DEAD_PID, mode: 'worker' });

  assert.equal(registry.describe('finisher', { health: false, git: false }).status, 'idle');
});

test('a standalone orchestrator still shows as running — it is a legitimate way to run', () => {
  const { configManager, paths } = installation();
  defineProject(paths, 'finisher');
  const { registry } = buildRegistry(configManager, paths);
  writeJsonAtomic(paths.heartbeatFile, {
    state: 'running', pid: process.pid, project: 'finisher', startedAt: new Date().toISOString(),
  });

  const record = registry.describe('finisher', { health: false, git: false });

  assert.equal(record.status, 'running');
  assert.equal(record.worker.mode, 'standalone');
});

test('a pending approval outranks everything — it is the fact the operator can act on', () => {
  const { configManager, paths } = installation();
  defineProject(paths, 'finisher');
  const { registry, approvalStore, workerRegistry } = buildRegistry(configManager, paths);
  workerRegistry.register('finisher', { pid: process.pid });
  approvalStore.create('finisher', {
    category: 'implementation-plan', approvalClass: 'review', title: 'Plan review',
  });

  const record = registry.describe('finisher', { health: false, git: false });

  assert.equal(record.status, 'waiting-approval', 'not "running" — the owner is the blocker');
  assert.equal(record.pendingApprovals.length, 1);
  assert.equal(record.pendingApprovals[0].title, 'Plan review');
});

test('a blocked lifecycle reports blocked; a stuck current task does too', () => {
  const { configManager, paths } = installation();
  defineProject(paths, 'alpha');
  defineProject(paths, 'beta');
  const { registry, lifecycle, taskQueue } = buildRegistry(configManager, paths);

  lifecycle.transition('alpha', 'blocked', 'cannot proceed');
  const queue = taskQueue.ensure('beta');
  queue.tasks.push({ id: 'T1', state: 'failed', attempts: 3, checkpoint: null });
  taskQueue.save(queue);

  assert.equal(registry.describe('alpha', { health: false, git: false }).status, 'blocked');
  assert.equal(registry.describe('beta', { health: false, git: false }).status, 'blocked');
});

test('unstarted work in the queue reports as queued, with real counts', () => {
  const { configManager, paths } = installation();
  defineProject(paths, 'alpha');
  const { registry, taskQueue } = buildRegistry(configManager, paths);
  const queue = taskQueue.ensure('alpha');
  queue.tasks.push({ id: 'T1', state: 'done', attempts: 1, checkpoint: null });
  queue.tasks.push({ id: 'T2', state: 'pending', attempts: 0, checkpoint: null });
  queue.currentIndex = 1;
  taskQueue.save(queue);

  const record = registry.describe('alpha', { health: false, git: false });

  assert.equal(record.status, 'queued');
  assert.deepEqual(
    { done: record.tasks.done, total: record.tasks.total, current: record.tasks.current },
    { done: 1, total: 2, current: 'T2' }
  );
});

test('a project whose config is broken is still LISTED, flagged, not silently dropped', () => {
  const { configManager, paths } = installation();
  fs.writeFileSync(path.join(paths.projectsDir, 'broken.json'), JSON.stringify({ driver: 'mock' }));
  const { registry } = buildRegistry(configManager, paths);

  const record = registry.describe('broken');

  assert.equal(record.status, 'misconfigured');
  assert.match(record.problem, /workingDirectory/);
  assert.equal(registry.list({ health: false, git: false }).length, 1, 'and it appears in the list');
});

test('the real branch and commit are read from the real work tree', () => {
  const { configManager, paths } = installation();
  const workingDirectory = defineProject(paths, 'repo');
  const git = (...args) => execFileSync('git', ['-C', workingDirectory, ...args], {
    stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
  });
  git('init', '-b', 'payroll');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('add', '.');
  git('commit', '-m', 'first commit for the registry test');

  const { registry } = buildRegistry(configManager, paths);
  const record = registry.describe('repo', { health: false });

  assert.equal(record.git.branch, 'payroll');
  assert.match(record.git.commit, /^[0-9a-f]{12}$/);
  assert.equal(record.git.subject, 'first commit for the registry test');
  assert.equal(record.git.dirty, false);

  fs.writeFileSync(path.join(workingDirectory, 'new.txt'), 'uncommitted');
  registry.gitCache.clear();
  assert.equal(registry.describe('repo', { health: false }).git.dirty, true);
});

test('a project that is not a git repository reports no git facts, not invented ones', () => {
  const { configManager, paths } = installation();
  defineProject(paths, 'plain');
  const { registry } = buildRegistry(configManager, paths);

  assert.equal(registry.describe('plain', { health: false }).git, undefined);
});

test('last activity is the most recent moment across every store that records one', () => {
  const { configManager, paths } = installation();
  defineProject(paths, 'alpha');
  const { registry, lifecycle } = buildRegistry(configManager, paths);
  lifecycle.transition('alpha', 'executing', 'working');

  const record = registry.describe('alpha', { health: false, git: false });

  assert.ok(Date.parse(record.lastActivity) > 0);
});

test('the list puts what needs attention first', () => {
  const { configManager, paths } = installation();
  for (const name of ['zeta', 'alpha', 'beta']) defineProject(paths, name);
  const { registry, workerRegistry, approvalStore, lifecycle } = buildRegistry(configManager, paths);
  workerRegistry.register('zeta', { pid: process.pid });
  approvalStore.create('beta', { category: 'x', approvalClass: 'owner-gate', title: 'Decide' });
  lifecycle.transition('alpha', 'blocked', 'stuck');

  const order = registry.list({ health: false, git: false }).map((r) => r.name);

  assert.deepEqual(order, ['beta', 'alpha', 'zeta'],
    'waiting-approval, then blocked, then running — the order of the operator\'s attention');
});

test('a name is resolved case-insensitively and by unambiguous prefix, never by guess', () => {
  const { configManager, paths } = installation();
  for (const name of ['Remote-Work', 'Remote-Backup', 'calculator']) defineProject(paths, name);
  const { registry } = buildRegistry(configManager, paths);

  assert.equal(registry.resolveName('CALCULATOR').match, 'calculator');
  assert.equal(registry.resolveName('calc').match, 'calculator', 'unambiguous prefix');
  assert.equal(registry.resolveName('remote').match, null, 'two candidates — no guess');
  assert.deepEqual(registry.resolveName('remote').candidates.sort(), ['Remote-Backup', 'Remote-Work']);
  assert.equal(registry.resolveName('nothing-like-this').match, null);
  assert.equal(registry.resolveName('').match, null);
});

test('health comes from the Phase 10E analyzer, and its absence is not faked', () => {
  const { configManager, paths } = installation();
  defineProject(paths, 'alpha');
  const { registry } = buildRegistry(configManager, paths);

  assert.equal(registry.describe('alpha', { git: false }).health, undefined,
    'no analyzer supplied ⇒ no health field, rather than an invented score');

  registry.buildIntelligence = () => ({ analyze: () => ({ health: { level: 'healthy', score: 92 } }) });
  assert.deepEqual(registry.describe('alpha', { git: false }).health, { level: 'healthy', score: 92 });

  registry.buildIntelligence = () => { throw new Error('analyzer exploded'); };
  assert.equal(registry.describe('alpha', { git: false }).health, undefined,
    'a failing analyzer degrades to no health, never to a wrong one');
});

test('every status the registry can produce is declared', () => {
  assert.deepEqual(
    [...PROJECT_STATUSES].sort(),
    ['blocked', 'idle', 'misconfigured', 'queued', 'running', 'waiting-approval']
  );
});
