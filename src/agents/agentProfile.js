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
 * The specialized roles an agent can fill. `general` is the catch-all a
 * legacy/implicit single agent uses — it matches any task that doesn't ask
 * for a specific role.
 */
export const ROLES = Object.freeze([
  'planner',
  'coding',
  'testing',
  'documentation',
  'research',
  'review',
  'general',
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