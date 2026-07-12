/**
 * dependencyGraph.js — Phase 10H: task dependencies & parallel planning (pure).
 *
 * Tasks may declare `dependsOn: ["T1", ...]` (and `resources: ["db", ...]`).
 * This module is the pure logic over those declarations:
 *
 *   - validation: dependencies must name EARLIER tasks in the plan. That
 *     one rule keeps the ordered task queue's semantics intact (executing
 *     the queue in order always satisfies every dependency) and makes
 *     cycles structurally impossible — no separate cycle detection pass.
 *   - ready-set computation: which PENDING tasks could run right now
 *     (dependencies DONE) — the foundation for parallel/distributed
 *     execution and what `coordination` CLI/API report.
 *   - conflict detection: ready tasks that share a declared resource.
 *   - assignment planning (incl. work stealing): a *recommendation* of how
 *     ready tasks could be spread across the agent roster. Reported, never
 *     executed — in-mission parallel launches are future work built on
 *     exactly these primitives.
 */

import { TaskState } from '../mission/taskState.js';

/**
 * Validate `dependsOn` declarations for a task list (config-load time).
 * Shares missionPlan's collect-problems style.
 *
 * @param {object[]} tasks - Normalized tasks, in plan order.
 * @returns {string[]} problems
 */
export function validateDependencies(tasks) {
  const problems = [];
  const seen = new Set();
  for (const [index, task] of tasks.entries()) {
    for (const dep of task.dependsOn ?? []) {
      if (dep === task.id) {
        problems.push(`tasks[${index}] ("${task.id}") cannot depend on itself.`);
      } else if (!seen.has(dep)) {
        const existsLater = tasks.slice(index + 1).some((t) => t.id === dep);
        problems.push(
          existsLater
            ? `tasks[${index}] ("${task.id}") depends on "${dep}", which comes LATER in the plan — ` +
              'dependencies must reference earlier tasks (reorder the plan).'
            : `tasks[${index}] ("${task.id}") depends on unknown task "${dep}".`
        );
      }
    }
    seen.add(task.id);
  }
  return problems;
}

/** Whether every dependency of `task` is DONE within the queue. */
export function depsSatisfied(queue, task) {
  const byId = new Map(queue.tasks.map((t) => [t.id, t]));
  return (task.dependsOn ?? []).every((dep) => byId.get(dep)?.state === TaskState.DONE);
}

/**
 * The tasks that could execute right now: PENDING, at or after the queue
 * cursor, with all dependencies satisfied.
 *
 * @param {object} queue - Persisted TaskQueue state.
 * @returns {object[]} Ready queue entries, in plan order.
 */
export function readyTasks(queue) {
  if (!queue) return [];
  return queue.tasks
    .slice(queue.currentIndex)
    .filter((t) => t.state === TaskState.PENDING && depsSatisfied(queue, t));
}

/** PENDING tasks whose dependencies are NOT yet satisfied (with what's missing). */
export function blockedByDependencies(queue) {
  if (!queue) return [];
  const byId = new Map(queue.tasks.map((t) => [t.id, t]));
  return queue.tasks
    .slice(queue.currentIndex)
    .filter((t) => t.state === TaskState.PENDING && !depsSatisfied(queue, t))
    .map((t) => ({
      taskId: t.id,
      waitingOn: (t.dependsOn ?? []).filter((dep) => byId.get(dep)?.state !== TaskState.DONE),
    }));
}

/**
 * Detect resource conflicts among a set of tasks: any resource declared by
 * two or more of them.
 *
 * @param {object[]} tasks
 * @returns {{resource: string, taskIds: string[]}[]}
 */
export function resourceConflicts(tasks) {
  const byResource = new Map();
  for (const task of tasks) {
    for (const resource of task.resources ?? []) {
      if (!byResource.has(resource)) byResource.set(resource, []);
      byResource.get(resource).push(task.id);
    }
  }
  return [...byResource.entries()]
    .filter(([, taskIds]) => taskIds.length > 1)
    .map(([resource, taskIds]) => ({ resource, taskIds }));
}

/**
 * Plan how the ready set COULD be assigned across the roster — including
 * work stealing: when one agent would own several ready tasks while a
 * capable peer sits idle, the plan suggests moving the extra task over.
 *
 * A recommendation only (Phase 10E's "generate recommendations, do not
 * execute" rule applies to coordination too).
 *
 * @param {object} params
 * @param {object[]} params.ready - Ready queue entries (see readyTasks).
 * @param {object[]} params.roster - The project's agents.
 * @param {(task: object) => object} params.routeFor - task → routed agent
 *   (callers wrap agentRouter.selectAgent with their registry/project).
 * @returns {{assignments: {taskId: string, agentId: string, stolen: boolean, from?: string}[],
 *            parallelizable: number, conflicts: {resource: string, taskIds: string[]}[]}}
 */
export function planAssignments({ ready, roster, routeFor }) {
  const conflicts = resourceConflicts(ready);
  const conflicted = new Set(conflicts.flatMap((c) => c.taskIds.slice(1)));

  const assignments = [];
  const busy = new Map(); // agentId -> taskId already planned this round
  for (const task of ready) {
    if (conflicted.has(task.id)) continue; // later conflicting task waits
    const routed = routeFor(task);
    let agentId = routed.id;
    let stolen = false;
    let from;
    if (busy.has(agentId)) {
      // Work stealing: find an idle agent that can fill the task's role (or
      // any idle agent for a role-less task).
      const idle = roster.find((a) =>
        !busy.has(a.id) && a.enabled !== false
        && (!task.role || task.role === 'general' || a.role === task.role || a.role === 'general'));
      if (idle) {
        from = agentId;
        agentId = idle.id;
        stolen = true;
      } else {
        continue; // no capacity — the task simply isn't parallelizable now
      }
    }
    busy.set(agentId, task.id);
    assignments.push({ taskId: task.id, agentId, stolen, ...(from ? { from } : {}) });
  }

  return { assignments, parallelizable: assignments.length, conflicts };
}

export default {
  validateDependencies, depsSatisfied, readyTasks, blockedByDependencies,
  resourceConflicts, planAssignments,
};
