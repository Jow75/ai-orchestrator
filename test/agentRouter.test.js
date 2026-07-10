/**
 * Unit tests for agentRouter.selectAgent — the pure routing precedence:
 * explicit agent id > role > capabilities > default.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { selectAgent } from '../src/agents/agentRouter.js';
import { AgentRegistry } from '../src/agents/agentRegistry.js';
import DriverRegistry from '../src/drivers/driverRegistry.js';
import { silentLogger } from '../src/infra/logger.js';

function registryWith(agents) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aio-router-')), 'agents.json');
  fs.writeFileSync(file, JSON.stringify({ agents }));
  return new AgentRegistry({
    driverRegistry: new DriverRegistry({ logger: silentLogger }),
    logger: silentLogger,
    agentsFile: file,
  });
}

const project = { name: 'p', driver: 'claude' };
const ROSTER = [
  { id: 'coder', role: 'coding', driver: 'claude', capabilities: ['code', 'refactor'] },
  { id: 'tester', role: 'testing', driver: 'mock', capabilities: ['test'] },
  { id: 'gen', role: 'general', driver: 'claude' },
];

test('an explicit agent id wins', () => {
  const r = registryWith(ROSTER);
  const { agent, reason } = selectAgent({ agent: 'tester' }, r, project);
  assert.equal(agent.id, 'tester');
  assert.match(reason, /explicit agent/);
});

test('a role routes to an agent filling it', () => {
  const r = registryWith(ROSTER);
  const { agent, reason } = selectAgent({ role: 'coding' }, r, project);
  assert.equal(agent.id, 'coder');
  assert.match(reason, /role "coding"/);
});

test('capabilities route to an agent advertising all of them', () => {
  const r = registryWith(ROSTER);
  const { agent } = selectAgent({ capabilities: ['code', 'refactor'] }, r, project);
  assert.equal(agent.id, 'coder');
});

test('an explicit agent id takes precedence over role', () => {
  const r = registryWith(ROSTER);
  const { agent } = selectAgent({ agent: 'tester', role: 'coding' }, r, project);
  assert.equal(agent.id, 'tester');
});

test('a task with no hints falls back to the default agent', () => {
  const r = registryWith(ROSTER);
  const { agent, reason } = selectAgent({ id: 'T1' }, r, project);
  assert.equal(agent.id, 'gen'); // general-role agent is the default
  assert.equal(reason, 'default');
});

test('an unknown explicit agent id falls back to the default (does not throw)', () => {
  const r = registryWith(ROSTER);
  const { agent, reason } = selectAgent({ agent: 'ghost' }, r, project);
  assert.equal(agent.id, 'gen');
  assert.match(reason, /not found/);
});

test('LEGACY GUARANTEE: an agent-less project always routes to the implicit default', () => {
  const r = new AgentRegistry({
    driverRegistry: new DriverRegistry({ logger: silentLogger }),
    logger: silentLogger,
    agentsFile: undefined,
  });
  // Even a task asking for a specific role gets the implicit default, because
  // that's the only agent that exists — behavior is identical to pre-Phase-9.
  const { agent } = selectAgent({ role: 'coding' }, r, project);
  assert.equal(agent.implicit, true);
  assert.equal(agent.driver, 'claude');
});
