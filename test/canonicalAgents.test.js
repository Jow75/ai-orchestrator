import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ROLES,
  CANONICAL_ROLES,
  CANONICAL_NINE_AGENTS,
  validateAgentProfile,
  validateAgentList,
  isKnownRole,
} from '../src/agents/agentProfile.js';
import { AgentRegistry, implicitDefaultAgent } from '../src/agents/agentRegistry.js';
import DriverRegistry from '../src/drivers/driverRegistry.js';
import { AgentMessageBus } from '../src/coordination/agentMessages.js';
import { silentLogger } from '../src/infra/logger.js';

function createRegistry(agentsFile) {
  return new AgentRegistry({
    driverRegistry: new DriverRegistry({ logger: silentLogger }),
    logger: silentLogger,
    agentsFile,
  });
}

test('canonical nine roles are recognized in ROLES and isKnownRole', () => {
  const expectedRoles = [
    'diagnostic',
    'architecture',
    'implementation',
    'verification',
    'provider-routing',
    'adversarial',
    'remediation',
    'auditor',
    'authorization',
  ];
  for (const role of expectedRoles) {
    assert.ok(ROLES.includes(role), `ROLES should include "${role}"`);
    assert.equal(isKnownRole(role), true, `isKnownRole("${role}") should be true`);
  }
  // Ensure legacy roles are also retained
  assert.equal(isKnownRole('coding'), true);
  assert.equal(isKnownRole('planner'), true);
  assert.equal(isKnownRole('general'), true);
});

test('CANONICAL_NINE_AGENTS has exactly 9 correctly formed agent profiles', () => {
  assert.equal(CANONICAL_NINE_AGENTS.length, 9);
  const seenIds = new Set();
  const seenRoles = new Set();

  for (const agent of CANONICAL_NINE_AGENTS) {
    assert.ok(agent.id.startsWith('agent-'), `Agent id ${agent.id} should start with agent-`);
    assert.ok(!seenIds.has(agent.id), `Agent id ${agent.id} must be unique`);
    seenIds.add(agent.id);

    assert.ok(isKnownRole(agent.role), `Agent role ${agent.role} must be a known role`);
    assert.ok(!seenRoles.has(agent.role), `Agent role ${agent.role} must be unique`);
    seenRoles.add(agent.role);

    assert.ok(agent.name.length > 5, `Agent name ${agent.name} must be descriptive`);
    assert.ok(Array.isArray(agent.capabilities) && agent.capabilities.length > 0);
    assert.ok(Array.isArray(agent.responsibilities) && agent.responsibilities.length > 0);
    assert.equal(agent.enabled, true);
  }
});

test('AgentRegistry loads global agents from config/agents.json', () => {
  const reg = createRegistry(path.resolve(process.cwd(), 'config/agents.json'));
  const agents = reg.globalAgents();
  assert.equal(agents.length, 9);
  assert.equal(agents[0].id, 'agent-one');
  assert.equal(agents[0].role, 'diagnostic');
  assert.equal(agents[8].id, 'agent-nine');
  assert.equal(agents[8].role, 'authorization');
});

test('AgentRegistry lookup helpers work by id and by role', () => {
  const reg = createRegistry(undefined);
  const agentOne = reg.getCanonicalAgent('agent-one');
  assert.ok(agentOne);
  assert.equal(agentOne.role, 'diagnostic');

  const agentThree = reg.getCanonicalAgent('implementation');
  assert.ok(agentThree);
  assert.equal(agentThree.id, 'agent-three');

  const unknown = reg.getCanonicalAgent('non-existent');
  assert.equal(unknown, null);
});

test('ensureCanonicalAgentsFile creates file if missing and reloads global agents', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-canon-'));
  const targetFile = path.join(tmpDir, 'agents.json');
  const reg = createRegistry(targetFile);

  assert.equal(fs.existsSync(targetFile), false);
  const ok = reg.ensureCanonicalAgentsFile(targetFile);
  assert.equal(ok, true);
  assert.equal(fs.existsSync(targetFile), true);

  const loaded = reg.globalAgents();
  assert.equal(loaded.length, 9);
  assert.equal(loaded[0].id, 'agent-one');
});

test('AgentMessageBus handles persistent task handoffs between canonical agents', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-bus-'));
  const bus = new AgentMessageBus({ coordinationDir: tmpDir, logger: silentLogger });

  const msg = bus.post('test-proj', {
    from: 'agent-one',
    to: 'agent-two',
    topic: 'handoff',
    text: 'Baseline diagnostics complete. 0 regressions.',
  });

  assert.ok(msg);
  assert.equal(msg.from, 'agent-one');
  assert.equal(msg.to, 'agent-two');

  const file = path.join(tmpDir, 'test-proj.messages.json');
  assert.ok(fs.existsSync(file));
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(record.messages.length, 1);
  assert.equal(record.messages[0].topic, 'handoff');
});

