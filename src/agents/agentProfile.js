/**
 * agentProfile.js — Phase 9: agent definition validation & normalization.
 *
 * An "agent" is a named, role-tagged binding of an AI engine driver plus its
 * own engine settings and capability tags. It sits ON TOP of the existing
 * driver layer (`src/drivers/`) — the driver is still the only thing that
 * knows about a specific engine; an agent just says "this driver, in this
 * role, is called X and is good at Y."
 *
 * This module is pure (no I/O): it validates one raw agent entry and returns
 * a normalized profile plus a list of problems, exactly mirroring
 * `missionPlan.validateSingleTask()`'s collect-problems-then-report style so
 * config errors surface at load time, not mid-mission.
 */

/**
 * The specialized roles an agent can fill.
 * Supports both legacy roles (P9) and the permanent canonical nine roles (Mission 2).
 */
export const ROLES = Object.freeze([
  // Legacy roles
  'planner',
  'coding',
  'testing',
  'documentation',
  'research',
  'review',
  'general',
  // Canonical nine agent roles
  'diagnostic',
  'architecture',
  'implementation',
  'verification',
  'provider-routing',
  'adversarial',
  'remediation',
  'auditor',
  'authorization',
]);

/** Canonical nine roles mapping. */
export const CANONICAL_ROLES = Object.freeze({
  AGENT_ONE: 'diagnostic',
  AGENT_TWO: 'architecture',
  AGENT_THREE: 'implementation',
  AGENT_FOUR: 'verification',
  AGENT_FIVE: 'provider-routing',
  AGENT_SIX: 'adversarial',
  AGENT_SEVEN: 'remediation',
  AGENT_EIGHT: 'auditor',
  AGENT_NINE: 'authorization',
});

/** Canonical Nine Agents definition roster. */
export const CANONICAL_NINE_AGENTS = Object.freeze([
  Object.freeze({
    id: 'agent-one',
    name: 'Agent One — Principal Diagnostic Engineer',
    role: 'diagnostic',
    driver: 'agy',
    capabilities: Object.freeze(['inspection', 'diagnostics', 'code-audit']),
    responsibilities: Object.freeze([
      'Project discovery and workspace audit',
      'Defect and bottleneck identification',
      'Baseline establishment and verification',
      'Evidence-backed diagnostic reporting',
    ]),
    config: Object.freeze({ agy: { model: 'gemini-3.8-flash-high' } }),
    enabled: true,
  }),
  Object.freeze({
    id: 'agent-two',
    name: 'Agent Two — Chief Architect and Engineering Planner',
    role: 'architecture',
    driver: 'agy',
    capabilities: Object.freeze(['planning', 'architecture', 'task-decomposition']),
    responsibilities: Object.freeze([
      'Engineering roadmap and implementation plan',
      'Architectural integrity and trade-off evaluation',
      'Explicit acceptance criteria definition',
      'Dependency and concurrency ordering',
    ]),
    config: Object.freeze({ agy: { model: 'gemini-3.8-flash-high' } }),
    enabled: true,
  }),
  Object.freeze({
    id: 'agent-three',
    name: 'Agent Three — Principal Implementation Engineer',
    role: 'implementation',
    driver: 'agy',
    capabilities: Object.freeze(['coding', 'refactoring', 'tool-execution']),
    responsibilities: Object.freeze([
      'Codebase implementation and defect repair',
      'Persistence, error recovery, and resilience',
      'Substantive code changes and refactoring',
      'Test authoring and updating',
    ]),
    config: Object.freeze({ agy: { model: 'gemini-3.8-flash-high' } }),
    enabled: true,
  }),
  Object.freeze({
    id: 'agent-four',
    name: 'Agent Four — Independent Verification Engineer',
    role: 'verification',
    driver: 'claude',
    capabilities: Object.freeze(['testing', 'verification', 'regression-check']),
    responsibilities: Object.freeze([
      'Independent verification of implementation against criteria',
      'Full test suite and regression suite execution',
      'Runtime health and service verification',
      'Evidence recording for test claims',
    ]),
    config: Object.freeze({ claude: { model: 'sonnet' } }),
    enabled: true,
  }),
  Object.freeze({
    id: 'agent-five',
    name: 'Agent Five — AI Provider, Model Integration, and Routing Specialist',
    role: 'provider-routing',
    driver: 'agy',
    capabilities: Object.freeze(['provider-audit', 'model-routing', 'api-integration']),
    responsibilities: Object.freeze([
      'Provider inventory and model availability matrix',
      'Task-aware intelligent routing and fallback policies',
      'Provider health monitoring and failure classification',
      'Latency, capacity, and capability verification',
    ]),
    config: Object.freeze({ agy: { model: 'gemini-3.8-flash-high' } }),
    enabled: true,
  }),
  Object.freeze({
    id: 'agent-six',
    name: 'Agent Six — Adversarial Reviewer and Failure Investigator',
    role: 'adversarial',
    driver: 'agy',
    capabilities: Object.freeze(['adversarial-review', 'stress-testing', 'failure-investigation']),
    responsibilities: Object.freeze([
      'Adversarial challenge of claims and edge cases',
      'Failure reproduction and resilience analysis',
      'Security boundaries and resource leak checks',
      'Discovery of unhandled failure modes',
    ]),
    config: Object.freeze({ agy: { model: 'claude-opus-4-6-thinking' } }),
    enabled: true,
  }),
  Object.freeze({
    id: 'agent-seven',
    name: 'Agent Seven — Remediation and Iteration Coordinator',
    role: 'remediation',
    driver: 'agy',
    capabilities: Object.freeze(['remediation', 'iteration-management', 'coordination']),
    responsibilities: Object.freeze([
      'Evaluation of verification and adversarial findings',
      'Remediation decision making and priority scheduling',
      'Prevention of circular or ineffective patching loops',
      'Coordination of corrective engineering iterations',
    ]),
    config: Object.freeze({ agy: { model: 'gemini-3.8-flash-high' } }),
    enabled: true,
  }),
  Object.freeze({
    id: 'agent-eight',
    name: 'Agent Eight — Integration Auditor and Completion Gate',
    role: 'auditor',
    driver: 'claude',
    capabilities: Object.freeze(['audit', 'compliance', 'cross-agent-reconciliation']),
    responsibilities: Object.freeze([
      'Cross-agent reconciliation and evidence audit',
      'Requirements coverage and acceptance criteria verification',
      'Git readiness and secret hygiene auditing',
      'Completion qualification and gate assessment',
    ]),
    config: Object.freeze({ claude: { model: 'sonnet' } }),
    enabled: true,
  }),
  Object.freeze({
    id: 'agent-nine',
    name: 'Agent Nine — Executive Authorization, Continuation, and Mission Control',
    role: 'authorization',
    driver: 'agy',
    capabilities: Object.freeze(['authorization', 'mission-control', 'checkpoint-management']),
    responsibilities: Object.freeze([
      'Standing internal project-scoped authorization authority',
      'Continuation approvals and autonomous unblocking',
      'Mission state and checkpoint preservation',
      'Formal completion sign-off and closure',
    ]),
    config: Object.freeze({ agy: { model: 'gemini-3.8-flash-high' } }),
    enabled: true,
  }),
]);

/** True if `role` is one of the known {@link ROLES}. */
export function isKnownRole(role) {
  return ROLES.includes(role);
}

/**
 * Validate and normalize ONE raw agent definition.
 *
 * @param {object} entry - Raw agent config
 *   ({id, role?, driver, capabilities?, config?, enabled?}).
 * @param {object} params
 * @param {string} params.label - How to refer to this agent in problems.
 * @param {Set<string>} params.seenIds - Ids already used; this agent's id is
 *   added on success (shared across a list; a single-entry caller passes a
 *   fresh set).
 * @param {(driverId: string) => boolean} [params.isKnownDriver] - Optional
 *   predicate to validate the referenced driver id exists. Omitted → driver
 *   id is only checked for presence (registry validates existence lazily).
 * @returns {{agent: object|null, problems: string[]}}
 */
export function validateAgentProfile(entry, { label, seenIds, isKnownDriver } = {}) {
  const problems = [];

  if (!entry || typeof entry !== 'object') {
    return { agent: null, problems: [`${label ?? 'agent'} must be an object.`] };
  }

  const id = typeof entry.id === 'string' && entry.id ? entry.id : null;
  if (!id) {
    problems.push(`${label}.id is required (a short unique string, e.g. "coder").`);
  } else if (seenIds?.has(id)) {
    problems.push(`${label}.id "${id}" is not unique — agent ids must be distinct.`);
  } else {
    seenIds?.add(id);
  }

  const role = entry.role ?? 'general';
  if (!isKnownRole(role)) {
    problems.push(
      `${label}.role "${role}" is unknown. Known roles: ${ROLES.join(', ')}.`
    );
  }

  const driver = typeof entry.driver === 'string' && entry.driver ? entry.driver : null;
  if (!driver) {
    problems.push(`${label}.driver is required (a driver id, e.g. "claude" or "cli").`);
  } else if (isKnownDriver && !isKnownDriver(driver)) {
    problems.push(`${label}.driver "${driver}" is not a registered driver.`);
  }

  if (entry.capabilities !== undefined && !Array.isArray(entry.capabilities)) {
    problems.push(`${label}.capabilities must be an array of strings when present.`);
  }

  if (problems.length && !id) return { agent: null, problems };

  return {
    agent: {
      id: id ?? label,
      role,
      driver,
      capabilities: Array.isArray(entry.capabilities)
        ? entry.capabilities.filter((c) => typeof c === 'string')
        : [],
      // Per-agent engine settings (e.g. a `claude` or `cli` block) — merged
      // over the project's own driver settings at launch time.
      config: entry.config && typeof entry.config === 'object' ? entry.config : {},
      enabled: entry.enabled !== false,
      ...(typeof entry.name === 'string' && entry.name ? { name: entry.name } : {}),
      ...(Array.isArray(entry.responsibilities) ? { responsibilities: entry.responsibilities.filter((r) => typeof r === 'string') } : {}),
    },
    problems,
  };
}

/**
 * Validate a whole list of raw agent definitions (the `agents` array from
 * config). Returns normalized agents (invalid ones dropped) + every problem,
 * matching `normalizeAndValidateTasks()`.
 *
 * @param {object[]} rawAgents
 * @param {object} [params]
 * @param {(driverId: string) => boolean} [params.isKnownDriver]
 * @returns {{agents: object[], problems: string[]}}
 */
export function validateAgentList(rawAgents, { isKnownDriver } = {}) {
  if (!Array.isArray(rawAgents) || rawAgents.length === 0) {
    return { agents: [], problems: [] };
  }
  const problems = [];
  const seenIds = new Set();
  const agents = rawAgents
    .map((entry, index) =>
      validateAgentProfile(entry, { label: `agents[${index}]`, seenIds, isKnownDriver })
    )
    .flatMap(({ agent, problems: p }) => {
      problems.push(...p);
      return agent ? [agent] : [];
    });
  return { agents, problems };
}

export default { ROLES, isKnownRole, validateAgentProfile, validateAgentList };