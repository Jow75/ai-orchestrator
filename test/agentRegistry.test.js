/**
 * Unit tests for agentRegistry.js. The headline case is the
 * backward-compatibility guarantee: an agent-less project resolves to a
 * single implicit agent wrapping project.driver.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentRegistry, implicitDefaultAgent } from '../src/agents/agentRegistry.js';
import DriverRegistry from '../src/drivers/driverRegistry.js';
import { silentLogger } from '../src/infra/logger.js';

function registry(agentsFile) {
  return new AgentRegistry({
    driverRegistry: new DriverRegistry({ logger: silentLogger }),
    logger: silentLogger,
    agentsFile,
  });
}

function writeAgents(agents) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aio-agents-')), 'agents.json');
  fs.writeFileSync(file, JSON.stringify({ agents }));
  return file;
}

const claudeProject = { name: 'p', driver: 'claude' };

test('an agent-less project gets a single implicit default agent', () => {
  const r = registry(undefined); // no agents file at all
  const roster = r.agentsFor(claudeProject);
  assert.equal(roster.length, 1);
  assert.equal(roster[0].implicit, true);
  assert.equal(roster[0].id, 'default');
  assert.equal(roster[0].driver, 'claude');
  assert.deepEqual(r.defaultFor(claudeProject), implicitDefaultAgent(claudeProject));
});

test('global agents load and are looked up by id and role', () => {
  const file = writeAgents([
    { id: 'coder', role: 'coding', driver: 'claude' },
    { id: 'rev', role: 'review', driver: 'mock' },
  ]);
  const r = registry(file);
  assert.deepEqual(r.globalAgents().map((a) => a.id), ['coder', 'rev']);
  assert.equal(r.getFor(claudeProject, 'coder').role, 'coding');
  assert.equal(r.byRoleFor(claudeProject, 'review')[0].id, 'rev');
});

test('a project agents block overrides a global agent of the same id', () => {
  const file = writeAgents([{ id: 'coder', role: 'coding', driver: 'claude' }]);
  const r = registry(file);
  const project = { name: 'p', driver: 'claude', agents: [{ id: 'coder', role: 'testing', driver: 'mock' }] };
  const coder = r.getFor(project, 'coder');
  assert.equal(coder.role, 'testing');
  assert.equal(coder.driver, 'mock');
});

test('disabled agents are excluded from the roster', () => {
  const file = writeAgents([
    { id: 'on', driver: 'claude' },
    { id: 'off', driver: 'claude', enabled: false },
  ]);
  const r = registry(file);
  assert.deepEqual(r.agentsFor(claudeProject).map((a) => a.id), ['on']);
});

test('a roster of only-disabled agents falls back to the implicit default', () => {
  const file = writeAgents([{ id: 'off', driver: 'claude', enabled: false }]);
  const r = registry(file);
  const roster = r.agentsFor(claudeProject);
  assert.equal(roster.length, 1);
  assert.equal(roster[0].implicit, true);
});

test('defaultFor prefers an explicit "default" id, then a general-role agent', () => {
  const file = writeAgents([
    { id: 'coder', role: 'coding', driver: 'claude' },
    { id: 'gen', role: 'general', driver: 'claude' },
  ]);
  assert.equal(registry(file).defaultFor(claudeProject).id, 'gen');
});

test('a malformed agents file is treated as empty (never throws)', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aio-agents-')), 'agents.json');
  fs.writeFileSync(file, '{ not valid json');
  const r = registry(file);
  assert.deepEqual(r.globalAgents(), []);
  assert.equal(r.agentsFor(claudeProject)[0].implicit, true);
});

test('effectiveProject deep-merges an agent config over the project', () => {
  const r = registry(undefined);
  const project = { name: 'p', driver: 'claude', claude: { model: 'a', permissionMode: '' } };
  const agent = { id: 'x', driver: 'claude', config: { claude: { model: 'b' } } };
  const eff = r.effectiveProject(project, agent);
  assert.equal(eff.claude.model, 'b');
  assert.equal(eff.claude.permissionMode, ''); // preserved
  // The implicit/empty-config agent returns the project unchanged (identity).
  assert.strictEqual(r.effectiveProject(project, { id: 'd', driver: 'claude', config: {} }), project);
});

test('driverFor resolves the agent driver via the driver registry', () => {
  const r = registry(undefined);
  const driver = r.driverFor({ id: 'x', driver: 'mock' });
  assert.equal(driver.id, 'mock');
});
