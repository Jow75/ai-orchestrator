/**
 * agentRouter.js — Phase 9: task → agent routing (pure).
 *
 * Given a task and a project's agent roster, pick the agent that should run
 * it. Deterministic precedence, most specific first:
 *
 *   1. task.agent   — an explicit agent id ("run this on the 'coder' agent")
 *   2. task.role    — a requested role, matched to an agent filling it
 *   3. task.capabilities — any agent advertising all requested capabilities
 *   4. the project default agent (agentRegistry.defaultFor)
 *
 * A legacy task (no agent/role/capabilities) always lands on the default
 * agent — which, for an agent-less project, is the implicit agent wrapping
 * `project.driver`. That is what makes Phase 9 a no-op for existing projects.
 *
 * Pure: no I/O, no mutation. Returns `{ agent, reason }` so callers (and the
 * timeline/UI) can explain *why* an agent was chosen.
 */

/**
 * @param {object} task - A task/queue entry (may carry agent/role/capabilities).
 * @param {import('./agentRegistry.js').AgentRegistry} registry
 * @param {object} project - Validated project config.
 * @returns {{agent: object, reason: string}}
 */
export function selectAgent(task, registry, project) {
  // 1. Explicit agent id wins outright.
  if (task?.agent) {
    const agent = registry.getFor(project, task.agent);
    if (agent) return { agent, reason: `explicit agent "${task.agent}"` };
    // Named but absent: fall through to the default rather than failing the
    // whole mission — the choice is logged by the caller.
  }

  // 2. Requested role → an agent filling it (first match in roster order).
  if (task?.role && task.role !== 'general') {
    const [byRole] = registry.byRoleFor(project, task.role);
    if (byRole) return { agent: byRole, reason: `role "${task.role}"` };
  }

  // 3. Requested capabilities → an agent advertising all of them.
  if (Array.isArray(task?.capabilities) && task.capabilities.length) {
    const match = registry
      .agentsFor(project)
      .find((a) => task.capabilities.every((c) => a.capabilities.includes(c)));
    if (match) {
      return { agent: match, reason: `capabilities [${task.capabilities.join(', ')}]` };
    }
  }

  // 4. Fall back to the project default (implicit agent for agent-less projects).
  const fallbackReason = task?.agent
    ? `default (agent "${task.agent}" not found)`
    : 'default';
  return { agent: registry.defaultFor(project), reason: fallbackReason };
}

export default { selectAgent };
