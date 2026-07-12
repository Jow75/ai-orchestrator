/**
 * missionPlan.js — Phase P2: mission = ordered tasks.
 *
 * A project is either:
 *  - **legacy** (no `tasks` defined): the whole mission is one implicit
 *    task, driven by `promptFile`/`mission.completionMarker` exactly as in
 *    v1/P0/P1. Every existing project and test keeps working unchanged.
 *  - **mission mode** (`tasks: [...]` non-empty): an ordered plan. Each task
 *    has its own prompt, objective, verification, and per-task run budget.
 *    The orchestrator advances to the next task only once the current one
 *    is verified — never on the agent's say-so alone.
 *
 * This module validates and normalizes the raw `tasks` array from project
 * JSON (called from configManager during project validation, so problems
 * surface at config-load time, not mid-mission) and provides pure,
 * side-effect-free lookups the orchestrator and task queue consume.
 */

import fs from 'node:fs';
import path from 'node:path';
import { isKnownVerifierType, listVerifierTypes } from '../verify/verifierRegistry.js';
import { isKnownRole, ROLES } from '../agents/agentProfile.js';

/** Default launches allowed for a single task before it is marked FAILED. */
export const DEFAULT_TASK_MAX_RUNS = 5;

/**
 * True when the project has no task list (single-prompt / v1 behaviour).
 * @param {object} project
 * @returns {boolean}
 */
export function isLegacyMission(project) {
  return !Array.isArray(project.tasks) || project.tasks.length === 0;
}

/**
 * Validate and normalize ONE raw task entry. Shared by
 * `normalizeAndValidateTasks()` (the static `tasks` array, at config-load
 * time) and Phase P3's `queue add` CLI command (a single task appended to
 * an already-running project's persisted queue) — one validation path,
 * not two that could quietly disagree.
 *
 * @param {object} entry - Raw task config ({id, prompt, objective?, ...}).
 * @param {object} params
 * @param {string} params.label - How to refer to this task in problems
 *   (e.g. `tasks[0]` or `the new task`).
 * @param {string} params.workingDirectory - For resolving `prompt`.
 * @param {Set<string>} params.seenIds - Ids already used; this task's id is
 *   added to it on success (mutated — callers validating a list share one
 *   set across entries; a single-task caller passes a fresh empty set).
 * @returns {{task: object|null, problems: string[]}}
 */
export function validateSingleTask(entry, { label, workingDirectory, seenIds }) {
  const problems = [];

  if (!entry || typeof entry !== 'object') {
    return { task: null, problems: [`${label} must be an object.`] };
  }

  const id = typeof entry.id === 'string' && entry.id ? entry.id : null;
  if (!id) {
    problems.push(`${label}.id is required (a short unique string, e.g. "T1").`);
  } else if (seenIds.has(id)) {
    problems.push(`${label}.id "${id}" is not unique — task ids must be distinct.`);
  } else {
    seenIds.add(id);
  }

  let resolvedPromptFile = null;
  if (!entry.prompt) {
    problems.push(`${label}.prompt is required (the task's prompt file).`);
  } else {
    const promptPath = path.isAbsolute(entry.prompt)
      ? entry.prompt
      : path.join(workingDirectory ?? '', entry.prompt);
    if (!fs.existsSync(promptPath)) {
      problems.push(`${label}.prompt not found: ${promptPath}`);
    } else {
      resolvedPromptFile = promptPath;
    }
  }

  const verify = Array.isArray(entry.verify) ? entry.verify : [];
  for (const [vIndex, verifier] of verify.entries()) {
    if (!verifier?.type) {
      problems.push(`${label}.verify[${vIndex}] is missing "type".`);
    } else if (!isKnownVerifierType(verifier.type)) {
      problems.push(
        `${label}.verify[${vIndex}].type "${verifier.type}" is unknown. ` +
        `Known verifier types: ${listVerifierTypes().join(', ')}.`
      );
    }
  }

  // Phase 9: optional agent routing. `role` must be a known role; `agent` is
  // a free agent-id string (existence is checked at routing time, since
  // agents are global config the task validator can't see). Both absent →
  // the task runs on the project's default agent, exactly as before Phase 9.
  if (entry.role !== undefined && !isKnownRole(entry.role)) {
    problems.push(
      `${label}.role "${entry.role}" is unknown. Known roles: ${ROLES.join(', ')}.`
    );
  }
  if (entry.agent !== undefined && (typeof entry.agent !== 'string' || !entry.agent)) {
    problems.push(`${label}.agent must be a non-empty agent-id string when present.`);
  }
  if (entry.capabilities !== undefined && !Array.isArray(entry.capabilities)) {
    problems.push(`${label}.capabilities must be an array of strings when present.`);
  }

  // Phase 10H: optional coordination fields. `dependsOn` must name EARLIER
  // tasks (ids already in seenIds) — that single rule keeps the ordered
  // queue's semantics intact and makes dependency cycles structurally
  // impossible. `resources` are opaque lock names (see resourceLocks.js).
  if (entry.dependsOn !== undefined) {
    if (!Array.isArray(entry.dependsOn)) {
      problems.push(`${label}.dependsOn must be an array of earlier task ids when present.`);
    } else {
      for (const dep of entry.dependsOn) {
        if (dep === id) {
          problems.push(`${label} ("${id}") cannot depend on itself.`);
        } else if (!seenIds.has(dep)) {
          problems.push(
            `${label}.dependsOn "${dep}" must reference an EARLIER task in the plan/queue.`
          );
        }
      }
    }
  }
  if (entry.resources !== undefined && !Array.isArray(entry.resources)) {
    problems.push(`${label}.resources must be an array of resource-name strings when present.`);
  }
  // Phase 10A: optional approval category — checked against policy at run
  // time (categories are global config this validator can't see); here we
  // only require a non-empty string.
  if (entry.approval !== undefined && (typeof entry.approval !== 'string' || !entry.approval)) {
    problems.push(`${label}.approval must be a non-empty category string when present.`);
  }

  if (problems.length && !id) return { task: null, problems };

  return {
    task: {
      id: id ?? label,
      objective: entry.objective ?? id ?? label,
      prompt: entry.prompt,
      resolvedPromptFile,
      continuePrompt: entry.continuePrompt ?? null, // null = fall back to mission.continuePrompt
      verify,
      maxRuns: Number.isInteger(entry.maxRuns) && entry.maxRuns > 0
        ? entry.maxRuns
        : DEFAULT_TASK_MAX_RUNS,
      // Phase 9 routing hints (null/[] when unspecified → default agent).
      role: entry.role ?? null,
      agent: entry.agent ?? null,
      capabilities: Array.isArray(entry.capabilities)
        ? entry.capabilities.filter((c) => typeof c === 'string')
        : [],
      // Phase 10 coordination/approval fields ([]/null → exactly pre-P10).
      dependsOn: Array.isArray(entry.dependsOn)
        ? entry.dependsOn.filter((d) => typeof d === 'string')
        : [],
      resources: Array.isArray(entry.resources)
        ? entry.resources.filter((r) => typeof r === 'string')
        : [],
      approval: entry.approval ?? null,
    },
    problems,
  };
}

/**
 * Validate and normalize a project's raw `tasks` array. Called during
 * project config validation; returns problems rather than throwing so the
 * caller can report every issue in the project at once (matching
 * configManager's existing "collect all problems, throw once" style).
 *
 * @param {object} project - The project config (workingDirectory, mission, ...).
 * @returns {{tasks: object[], problems: string[]}}
 */
export function normalizeAndValidateTasks(project) {
  const raw = project.tasks;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { tasks: [], problems: [] };
  }

  const problems = [];
  const seenIds = new Set();
  const tasks = raw.map((entry, index) => {
    const { task, problems: taskProblems } = validateSingleTask(entry, {
      label: `tasks[${index}]`,
      workingDirectory: project.workingDirectory,
      seenIds,
    });
    problems.push(...taskProblems);
    return task;
  }).filter(Boolean);

  return { tasks, problems };
}

/**
 * The task at a given index, or null past the end of the plan.
 * @param {object} project
 * @param {number} index
 * @returns {object|null}
 */
export function getTaskAt(project, index) {
  return project.tasks?.[index] ?? null;
}

/**
 * Look up a task by id.
 * @param {object} project
 * @param {string} id
 * @returns {object|null}
 */
export function getTaskById(project, id) {
  return project.tasks?.find((t) => t.id === id) ?? null;
}

/**
 * The index of a task by id, or -1 if not found.
 * @param {object} project
 * @param {string} id
 * @returns {number}
 */
export function getTaskIndex(project, id) {
  return project.tasks?.findIndex((t) => t.id === id) ?? -1;
}

/** Total number of tasks in the plan (0 for legacy missions). */
export function taskCount(project) {
  return project.tasks?.length ?? 0;
}

export default {
  isLegacyMission, normalizeAndValidateTasks, getTaskAt, getTaskById,
  getTaskIndex, taskCount, DEFAULT_TASK_MAX_RUNS,
};
