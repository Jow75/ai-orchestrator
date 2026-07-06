/**
 * memoryStore.js — Phase P5: long-term, cross-session project memory.
 *
 * The progress ledger (P0/P1) and task queue (P2/P3) already remember
 * *what happened, run by run*. What they don't keep is anything that
 * survives past the data structure that produced it: a task queue
 * reinitializing (plan shape changed) discards its old tasks' checkpoints
 * entirely, and neither the ledger nor the queue has a place for a durable
 * fact a human wants remembered ("the build system is X", "always run
 * lint before tests") or a catalog of past blockers that persists whether
 * or not the mission that hit them is still active.
 *
 * `MemoryStore` fills that gap with three categories, persisted at
 * `state/memory/<project>.json`:
 *
 *  - `notes`      — operator-authored durable facts (`memory add` CLI),
 *                   categorized `project` (general) or `architecture`
 *                   (build/structure/convention facts). Never auto-added
 *                   or auto-removed; only a human's own record.
 *  - `failures`   — auto-recorded every time `Orchestrator#block()` fires
 *                   (a BLOCKED or FAILED terminal outcome), independent of
 *                   which session or task-queue incarnation hit it. An
 *                   operator marks one `resolved` once its cause is fixed.
 *  - `taskHistory`— archived from a task queue's DONE/FAILED/BLOCKED tasks
 *                   right before `TaskQueue` reinitializes and would
 *                   otherwise discard them (see `TaskQueue#getOrInitialize`
 *                   case 2). Lets a later plan that reuses the same task
 *                   id learn what happened last time, across an edit that
 *                   would otherwise erase that history.
 *
 * All three are read by the Phase P4 Continuation Builder and folded into
 * the resume/retry briefing — see `continuationBuilder.js`.
 */

import path from 'node:path';
import { writeJsonAtomic, readJsonSafe } from '../state/statePersistence.js';
import { TaskState } from '../mission/taskState.js';

/** Task states worth archiving — anything actually attempted, terminally. */
const ARCHIVABLE_STATES = [TaskState.DONE, TaskState.FAILED, TaskState.BLOCKED];

export class MemoryStore {
  /**
   * @param {object} options
   * @param {string} [options.memoryDir] - Directory for per-project memory
   *   files. Absent in hand-built test configs that predate this phase —
   *   every method degrades to a safe no-op/empty-result rather than
   *   throwing, matching `TaskQueue`'s `tasksDir` guard.
   * @param {object} options.logger - Module logger.
   */
  constructor({ memoryDir, logger }) {
    this.memoryDir = memoryDir;
    this.logger = logger;
  }

  file(project) {
    return path.join(this.memoryDir, `${project}.json`);
  }

  /** Load the persisted memory for a project, or null if none/unconfigured. */
  load(project) {
    if (!this.memoryDir) return null;
    return readJsonSafe(this.file(project), { logger: this.logger });
  }

  /** Load existing memory, or create (and persist) an empty record. */
  ensure(project) {
    const existing = this.load(project);
    if (existing) return existing;
    const memory = { project, notes: [], failures: [], taskHistory: [] };
    this.save(memory);
    return memory;
  }

  save(memory) {
    if (!this.memoryDir) return;
    try {
      writeJsonAtomic(this.file(memory.project), memory);
    } catch (error) {
      this.logger.warn('Failed to persist project memory', {
        project: memory.project, error: error.message,
      });
    }
  }

  /**
   * Record a durable, operator-authored fact (the `memory add` CLI).
   *
   * @param {string} project
   * @param {{category: 'project'|'architecture', text: string}} note
   * @returns {object} The updated memory record.
   */
  addNote(project, { category, text }) {
    const memory = this.ensure(project);
    memory.notes.push({
      id: nextId(memory.notes), category, text, at: new Date().toISOString(),
    });
    this.save(memory);
    return memory;
  }

  /**
   * Auto-recorded whenever supervision blocks (see `Orchestrator#block()`).
   * Never throws and never affects supervision — a failed write is logged
   * and swallowed, same as the progress ledger.
   *
   * @param {string} project
   * @param {{category: string, reason: string, hint?: string, taskId?: string}} failure
   */
  recordFailure(project, { category, reason, hint, taskId }) {
    if (!this.memoryDir) return;
    const memory = this.ensure(project);
    memory.failures.push({
      id: nextId(memory.failures), category, reason, hint: hint ?? null,
      taskId: taskId ?? null, at: new Date().toISOString(), resolved: false,
    });
    this.save(memory);
  }

  /**
   * Mark a failure entry resolved (an operator has fixed its cause).
   *
   * @returns {{ok: boolean, reason?: string}}
   */
  resolveFailure(project, failureId) {
    const memory = this.ensure(project);
    const failure = memory.failures.find((f) => f.id === failureId);
    if (!failure) return { ok: false, reason: `No failure with id ${failureId}.` };
    failure.resolved = true;
    this.save(memory);
    return { ok: true };
  }

  /** Unresolved failures, most recent first, capped to `limit`. */
  activeFailures(project, limit = 5) {
    const memory = this.load(project);
    if (!memory) return [];
    return memory.failures.filter((f) => !f.resolved).slice(-limit).reverse();
  }

  /** Operator notes, most recent first, capped to `limit`. */
  recentNotes(project, limit = 5) {
    const memory = this.load(project);
    if (!memory) return [];
    return memory.notes.slice(-limit).reverse();
  }

  /**
   * Archive a queue's terminally-attempted tasks before it is discarded
   * (see `TaskQueue#getOrInitialize`, "plan shape changed" case) — without
   * this, DONE/FAILED/BLOCKED history for a task id is lost the moment the
   * static plan is edited mid-mission.
   *
   * @param {string} project
   * @param {object[]} tasks - The outgoing queue's task entries.
   */
  archiveTaskHistory(project, tasks) {
    if (!this.memoryDir) return;
    const archivable = tasks.filter((t) => ARCHIVABLE_STATES.includes(t.state));
    if (!archivable.length) return;

    const memory = this.ensure(project);
    for (const task of archivable) {
      memory.taskHistory.push({
        taskId: task.id, outcome: task.state, attempts: task.attempts,
        summary: task.checkpoint?.summary ?? null, at: new Date().toISOString(),
      });
    }
    this.save(memory);
    this.logger.info('Archived outgoing task history before queue reinitialization', {
      project, taskIds: archivable.map((t) => t.id),
    });
  }

  /** Prior archived attempts for a task id, oldest → newest. */
  taskHistoryFor(project, taskId) {
    const memory = this.load(project);
    if (!memory) return [];
    return memory.taskHistory.filter((h) => h.taskId === taskId);
  }
}

/** Small incrementing id, unique within one project's memory record. */
function nextId(entries) {
  return entries.length ? Math.max(...entries.map((e) => e.id)) + 1 : 1;
}

export default MemoryStore;
