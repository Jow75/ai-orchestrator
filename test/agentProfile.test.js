/**
 * Unit tests for agentProfile.js — the pure agent-definition validator that
 * mirrors missionPlan.validateSingleTask()'s collect-problems style.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ROLES, isKnownRole, validateAgentProfile, validateAgentList,
} from '../src/agents/agentProfile.js';

test('ROLES includes the expected specialized roles plus general', () => {
  for (const role of ['planner', 'coding', 'testing', 'documentation', 'research', 'review', 'general']) {
    assert.ok(ROLES.includes(role), `missing role ${role}`);
  }
  assert.equal(isKnownRole('coding'), true);
  assert.equal(isKnownRole('nonsense'), false);
});

test('a minimal valid agent normalizes with defaults', () => {
  const { agent, problems } = validateAgentProfile(
    { id: 'coder', driver: 'claude' },
    { label: 'agent', seenIds: new Set() }
  );
  assert.equal(problems.length, 0);
  assert.deepEqual(agent, {
    id: 'coder', role: 'general', driver: 'claude',
    capabilities: [], config: {}, enabled: true,
  });
});

test('role, capabilities, config, and enabled are carried through', () => {
  const { agent } = validateAgentProfile(
    { id: 'r', role: 'review', driver: 'cli', capabilities: ['audit'], config: { cli: { command: 'x' } }, enabled: false },
    { label: 'agent', seenIds: new Set() }
  );
  assert.equal(agent.role, 'review');
  assert.deepEqual(agent.capabilities, ['audit']);
  assert.deepEqual(agent.config, { cli: { command: 'x' } });
  assert.equal(agent.enabled, false);
});

test('missing id and driver are reported', () => {
  const { agent, problems } = validateAgentProfile({}, { label: 'agents[0]', seenIds: new Set() });
  assert.equal(agent, null);
  assert.ok(problems.some((p) => p.includes('.id is required')));
});

test('an unknown role is rejected', () => {
  const { problems } = validateAgentProfile(
    { id: 'x', driver: 'claude', role: 'wizard' },
    { label: 'agent', seenIds: new Set() }
  );
  assert.ok(problems.some((p) => p.includes('role "wizard" is unknown')));
});

test('an unregistered driver is rejected when a predicate is supplied', () => {
  const { problems } = validateAgentProfile(
    { id: 'x', driver: 'ghost' },
    { label: 'agent', seenIds: new Set(), isKnownDriver: (d) => d === 'claude' }
  );
  assert.ok(problems.some((p) => p.includes('"ghost" is not a registered driver')));
});

test('duplicate ids across a list are reported (mirrors validateSingleTask)', () => {
  // The entry is kept (id is present) but a "not unique" problem is raised —
  // the registry's own id-keyed Map is what ultimately dedupes (last wins).
  const { problems } = validateAgentList([
    { id: 'a', driver: 'claude' },
    { id: 'a', driver: 'claude' },
  ]);
  assert.ok(problems.some((p) => p.includes('not unique')));
});

test('validateAgentList returns empty for a non-array or empty input', () => {
  assert.deepEqual(validateAgentList(undefined), { agents: [], problems: [] });
  assert.deepEqual(validateAgentList([]), { agents: [], problems: [] });
});
