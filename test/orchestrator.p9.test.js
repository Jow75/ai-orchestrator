/**
 * Phase 9 integration tests — the real supervision loop routing tasks to
 * different specialized agents, and the backward-compatibility guarantee
 * that an agent-less project runs exactly as before (implicit default agent).
 *
 * Both agents are backed by the `mock` driver (so no real engine is needed);
 * routing is asserted via the `agent:assigned` events, the per-agent health
 * tallies, and the agentId stamped on each task checkpoint.
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
import { AgentHealth } from '../src/agents/agentHealth.js';
import { DEFAULT_TASK_MAX_RUNS } from '../src/mission/missionPlan.js';
import { silentLogger } from '../src/infra/logger.js';

const BASE_CONFIG = {
  supervision: { statusUpdateIntervalMs: 1_000, heartbeatIntervalMs: 1_000, childProcessScanIntervalMs: 0 },
  recovery: { maxConsecutiveCrashes: 2, crashBackoffBaseMs: 10, crashBackoffMaxMs: 40, networkRetryDelayMs: 10 },
  rateLimit: { minWaitMs: 5, defaultWaitMs: 50, maxWaitMs: 500, resumeGraceMs: 0 },
  progress: { enabled: true, maxConsecutiveNoProgress: 3, interRunDelayMs: 5, blockedDetection: true },
};

/**
 * @param {object} opts
 * @param {object[]} opts.tasks - Raw tasks (may carry role/agent).
 * @param {object[]} opts.mockRuns - Scripted mock runs.
 * @param {object[]|null} opts.agents - Global agents (null → no agents file,
 *   i.e. the legacy implicit-default path).
 */
function harness({ tasks, mockRuns, agents }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-p9-'));
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
      ...t, resolvedPromptFile: promptFile,
    };
  });

  let agentsFile;
  if (agents) {
    agentsFile = path.join(root, 'agents.json');
    fs.writeFileSync(agentsFile, JSON.stringify({ agents }));
  }

  const config = { ...BASE_CONFIG };
  const project = {
    name: 'p9proj', driver: 'mock', workingDirectory: workspace,
    mission: { completionMarker: 'MISSION COMPLETE', continuePrompt: 'continue', maxRuns: 0 },
    tasks: normalizedTasks, mock: { runs: mockRuns },
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
  const orchestrator = new Orchestrator({
    configManager: { getAll: () => config, getProject: () => project },
    driverRegistry: new DriverRegistry({ logger: silentLogger }),
    sessionManager: new SessionManager({ sessionsDir: path.join(stateDir, 'sessions'), logger: silentLogger }),
    statusManager: new StatusManager({ statusFile: path.join(stateDir, 'status.json'), logger: silentLogger }),
    paths,
    logger: silentLogger,
  });

  const agentHealth = new AgentHealth({ healthFile: paths.agentHealthFile, logger: silentLogger });
  return { orchestrator, workspace, paths, project, agentHealth };
}

test('tasks route to different agents by role; each agent completes its own task', async () => {
  const { orchestrator, agentHealth, paths } = harness({
    agents: [
      { id: 'coder', role: 'coding', driver: 'mock' },
      { id: 'tester', role: 'testing', driver: 'mock' },
    ],
    tasks: [
      { id: 'T1', role: 'coding', verify: [{ type: 'file-exists', path: 'a.txt' }] },
      { id: 'T2', role: 'testing', verify: [{ type: 'file-exists', path: 'b.txt' }] },
    ],
    mockRuns: [
      { output: 'made a', writeFile: { path: 'a.txt', content: '1' }, exitCode: 0, delayMs: 15 },
      { output: 'made b', writeFile: { path: 'b.txt', content: '2' }, exitCode: 0, delayMs: 15 },
    ],
  });

  const assigned = [];
  orchestrator.on('agent:assigned', (e) => assigned.push({ taskId: e.taskId, agentId: e.agentId, role: e.role }));

  const result = await orchestrator.runProject('p9proj');
  assert.equal(result.complete, true);

  // Each task was routed to the agent filling its requested role.
  assert.deepEqual(assigned, [
    { taskId: 'T1', agentId: 'coder', role: 'coding' },
    { taskId: 'T2', agentId: 'tester', role: 'testing' },
  ]);

  // Per-agent performance was recorded independently.
  const report = agentHealth.report([
    { id: 'coder', role: 'coding', driver: 'mock', capabilities: [], enabled: true },
    { id: 'tester', role: 'testing', driver: 'mock', capabilities: [], enabled: true },
  ]);
  assert.equal(report.find((r) => r.agentId === 'coder').tasksDone, 1);
  assert.equal(report.find((r) => r.agentId === 'tester').tasksDone, 1);

  // Each checkpoint is stamped with the agent that produced it.
  const queue = JSON.parse(fs.readFileSync(path.join(paths.tasksDir, 'p9proj.json'), 'utf8'));
  assert.equal(queue.tasks[0].checkpoint.agentId, 'coder');
  assert.equal(queue.tasks[1].checkpoint.agentId, 'tester');
});

test('an explicit agent id on a task overrides role-based routing', async () => {
  const { orchestrator } = harness({
    agents: [
      { id: 'coder', role: 'coding', driver: 'mock' },
      { id: 'special', role: 'coding', driver: 'mock' },
    ],
    tasks: [{ id: 'T1', agent: 'special', role: 'coding', verify: [{ type: 'file-exists', path: 'a.txt' }] }],
    mockRuns: [{ output: 'x', writeFile: { path: 'a.txt', content: '1' }, exitCode: 0, delayMs: 15 }],
  });
  const assigned = [];
  orchestrator.on('agent:assigned', (e) => assigned.push(e.agentId));
  await orchestrator.runProject('p9proj');
  assert.deepEqual(assigned, ['special']);
});

test('LEGACY GUARANTEE: an agent-less project runs on the implicit default agent', async () => {
  const { orchestrator, agentHealth } = harness({
    agents: null, // no agents file → implicit default wrapping project.driver
    tasks: [
      { id: 'T1', verify: [{ type: 'file-exists', path: 'a.txt' }] },
      { id: 'T2', verify: [{ type: 'file-exists', path: 'b.txt' }] },
    ],
    mockRuns: [
      { output: 'made a', writeFile: { path: 'a.txt', content: '1' }, exitCode: 0, delayMs: 15 },
      { output: 'made b', writeFile: { path: 'b.txt', content: '2' }, exitCode: 0, delayMs: 15 },
    ],
  });
  const assigned = [];
  orchestrator.on('agent:assigned', (e) => assigned.push(e.agentId));

  const result = await orchestrator.runProject('p9proj');
  assert.equal(result.complete, true);
  // Every task ran on the single implicit 'default' agent.
  assert.deepEqual(assigned, ['default', 'default']);
  assert.equal(
    agentHealth.report([{ id: 'default', role: 'general', driver: 'mock', capabilities: [], enabled: true }])[0].tasksDone,
    2
  );
});
