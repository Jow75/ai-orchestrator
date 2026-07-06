/**
 * taskQueue.js — Persistent progress through a mission's task plan.
 *
 * Where `missionPlan.js` is the plan derived from a project's static JSON
 * `tasks`, `TaskQueue` is the mutable progress through it: which task is
 * current, how many attempts it has had, and its outcome once finished.
 * Persisted at `state/tasks/<project>.json` via the same atomic-write
 * primitives as every other piece of orchestrator state — a crash, rate
 * limit, or reboot mid-task loses nothing; the next start resumes the
 * exact same task.
 *
 * Phase P3 (persistent prompt queue): the queue is no longer purely
 * derived from static config. `enqueue()`/`removeTask()`/`reorderTask()`
 * let an operator (via the `tasks add/remove/reorder` CLI) build up or
 * adjust a project's plan at runtime — including bootstrapping a project
 * that has no static `tasks` at all. `getOrInitialize()` adopts any
 * persisted queue that still has unfinished work, regardless of which
 * session last touched it, which is what lets newly-queued tasks run on
 * the next `start` without re-declaring the whole plan in JSON.
 *
 * Phase P5 (memory): a reinitialization (plan shape changed mid-mission)
 * used to discard the outgoing queue's terminal tasks with no trace. An
 * optional `memoryStore` now archives their outcome first — see
 * `MemoryStore#archiveTaskHistory()`.
 *
 * Phase P7 (operator overrides): `approveRetry()`/`operatorSkip()` are the
 * only sanctioned way to re-enter or bypass a BLOCKED/FAILED task — always
 * an explicit human decision (CLI or the dashboard API's mutating
 * endpoints), never automatic.
 */

import path from 'node:path';
import { writeJsonAtomic, readJsonSafe } from '../state/statePersistence.js';
import { TaskState, TASK_RESUMABLE_STATES } from './taskState.js';

export class TaskQueue {
  /**
   * @param {object} options
   * @param {string} options.tasksDir - Directory for per-project task queues.
   * @param {object} options.logger - Module logger.
   * @param {import('../memory/memoryStore.js').MemoryStore} [options.memoryStore] -
   *   Phase P5: when a queue reinitializes (plan shape changed mid-mission),
   *   its DONE/FAILED/BLOCKED tasks are archived here before being
   *   discarded, rather than silently lost. Optional — omitted entirely in
   *   test harnesses/setups that predate P5.
   */
  constructor({ tasksDir, logger, memoryStore }) {
    this.tasksDir = tasksDir;
    this.logger = logger;
    this.memoryStore = memoryStore;
  }

  file(project) {
    return path.join(this.tasksDir, `${project}.json`);
  }

  /**
   * Load the persisted queue for a project, or null if none exists.
   * Also null (never throws) if `tasksDir` itself was never configured —
   * a legacy-only setup (e.g. a minimal hand-built config in tests) simply
   * has no task queues, which is exactly what "no queue" already means.
   */
  load(project) {
    if (!this.tasksDir) return null;
    return readJsonSafe(this.file(project), { logger: this.logger });
  }

  /**
   * Load the existing queue if it's usable for this run, otherwise
   * initialize a fresh one from the static plan. This is the single entry
   * point the orchestrator calls at the start of a mission-mode run.
   *
   * Three cases, checked in order:
   *  1. Same session, same plan shape → true resume (attempts/state as-is).
   *  2. Same session, DIFFERENT plan shape → the static config was edited
   *     while this session was active. Reconciling an arbitrary edit
   *     against in-progress work is out of scope; restart the queue and
   *     log clearly rather than silently guessing.
   *  3. Different (or no) session, but the CURRENT task is still PENDING or
   *     ACTIVE (`currentIsResumable()`) → **adopt** it (Phase P3). Covers
   *     tasks queued via the CLI that never attached to a session yet, and
   *     tasks appended onto a queue whose earlier session already
   *     completed. Deliberately checks the current task's own STATE, not
   *     merely that the index is in bounds: a BLOCKED or FAILED current
   *     task must never be silently re-adopted by a new session — that
   *     would defeat the entire point of blocking (never re-enter the same
   *     futile loop). Only a truly-idle task (never terminal) is adoptable.
   *  Otherwise: no usable queue exists → seed fresh from the static plan.
   *
   * @param {string} project - Project name.
   * @param {object[]} planTasks - Normalized static tasks (see missionPlan.js).
   * @param {string} sessionId - The active session's id.
   * @returns {object} The queue state (persisted shape — see initialize()).
   */
  getOrInitialize(project, planTasks, sessionId) {
    const existing = this.load(project);

    if (existing && existing.sessionId === sessionId) {
      const planIds = planTasks.map((t) => t.id);
      const samePlanShape = existing.tasks.length === planIds.length
        && existing.tasks.every((t, i) => t.id === planIds[i]);
      if (samePlanShape) return existing;

      this.logger.warn('Task plan changed mid-mission; restarting the task queue', {
        project, previousTaskIds: existing.tasks.map((t) => t.id), newTaskIds: planIds,
      });
      this.memoryStore?.archiveTaskHistory(project, existing.tasks);
      return this.initialize(project, planTasks, sessionId);
    }

    if (existing && this.currentIsResumable(existing)) {
      existing.sessionId = sessionId;
      this.save(existing);
      this.logger.info('Adopting existing task queue with unfinished work', {
        project, currentIndex: existing.currentIndex, totalTasks: existing.tasks.length,
      });
      return existing;
    }

    return this.initialize(project, planTasks, sessionId);
  }

  /**
   * Load the persisted queue, or create an empty, session-less one if none
   * exists yet. Used by the `tasks add` CLI command to bootstrap a queue on
   * a project with no queue history — including one with no static `tasks`
   * at all (mission mode built entirely at runtime).
   *
   * @param {string} project - Project name.
   * @returns {object} The queue state.
   */
  ensure(project) {
    const existing = this.load(project);
    if (existing) return existing;

    const queue = { project, sessionId: null, currentIndex: 0, tasks: [] };
    this.save(queue);
    return queue;
  }

  /**
   * Create and persist a fresh queue from a plan.
   *
   * Each entry carries its full normalized definition (objective,
   * resolvedPromptFile, continuePrompt, verify, maxRuns) alongside the
   * runtime fields (state, attempts, checkpoint) — the queue entry IS the
   * task from here on, not just a progress marker looked up elsewhere.
   * This is what lets `enqueue()`-added tasks (no static config entry at
   * all) work with zero special-casing in the orchestrator.
   */
  initialize(project, planTasks, sessionId) {
    const queue = {
      project,
      sessionId,
      currentIndex: 0,
      tasks: planTasks.map((t) => this.toQueueEntry(t)),
    };
    this.save(queue);
    this.logger.info('Task queue initialized', { project, taskCount: planTasks.length });
    return queue;
  }

  /** Combine a normalized task definition with fresh runtime fields. */
  toQueueEntry(task) {
    return { ...task, state: TaskState.PENDING, attempts: 0, checkpoint: null };
  }

  save(queue) {
    try {
      writeJsonAtomic(this.file(queue.project), queue);
    } catch (error) {
      this.logger.warn('Failed to persist task queue', {
        project: queue.project, error: error.message,
      });
    }
  }

  /** The current task's queue entry, or null once the plan is exhausted. */
  current(queue) {
    return queue.tasks[queue.currentIndex] ?? null;
  }

  /** True once every task has been advanced past (mission complete). */
  isComplete(queue) {
    return queue.currentIndex >= queue.tasks.length;
  }

  /** Record one more launch attempt on the current task. */
  recordAttempt(queue) {
    const task = this.current(queue);
    if (!task) return queue;
    task.attempts += 1;
    if (task.state === TaskState.PENDING) task.state = TaskState.ACTIVE;
    this.save(queue);
    return queue;
  }

  /**
   * Record the verification outcome of the current task's latest attempt,
   * regardless of whether that attempt passed, will retry, or exhausted
   * its budget. Distinct from `checkpoint` (set only on a TERMINAL outcome
   * by markDone/markFailed/markBlocked): `lastVerifyResult` is what the
   * Phase P4 Continuation Builder reads to tell the agent exactly why its
   * previous attempt on THIS task wasn't accepted, even mid-retry.
   *
   * @param {object} queue
   * @param {{passed: boolean, results: object[]}} verifyResult
   */
  recordVerifyResult(queue, verifyResult) {
    const task = this.current(queue);
    if (!task) return queue;
    task.lastVerifyResult = verifyResult;
    this.save(queue);
    return queue;
  }

  /** Mark the current task done and store its checkpoint. */
  markDone(queue, checkpoint) {
    return this.setOutcome(queue, TaskState.DONE, checkpoint);
  }

  /** Mark the current task failed (retries exhausted) and store its checkpoint. */
  markFailed(queue, checkpoint) {
    return this.setOutcome(queue, TaskState.FAILED, checkpoint);
  }

  /** Mark the current task blocked (loop/blocked-state detected) and store its checkpoint. */
  markBlocked(queue, checkpoint) {
    return this.setOutcome(queue, TaskState.BLOCKED, checkpoint);
  }

  setOutcome(queue, state, checkpoint) {
    const task = this.current(queue);
    if (!task) return queue;
    task.state = state;
    task.checkpoint = checkpoint;
    this.save(queue);
    return queue;
  }

  /** Advance to the next task. Returns the updated queue. */
  advance(queue) {
    queue.currentIndex += 1;
    this.save(queue);
    return queue;
  }

  /** Whether the current task can still be resumed (not yet terminal). */
  currentIsResumable(queue) {
    const task = this.current(queue);
    return Boolean(task && TASK_RESUMABLE_STATES.includes(task.state));
  }

  /**
   * Phase P3: append a new task to the end of the queue. `task` must
   * already be validated/normalized (see `missionPlan.validateSingleTask()`)
   * — this method does not re-check id uniqueness or prompt existence.
   *
   * @param {object} queue
   * @param {object} task - Normalized task definition.
   * @returns {object} The updated, persisted queue.
   */
  enqueue(queue, task) {
    queue.tasks.push(this.toQueueEntry(task));
    this.save(queue);
    this.logger.info('Task enqueued', { project: queue.project, taskId: task.id });
    return queue;
  }

  /**
   * Remove a task by id. Only a PENDING task may be removed — one that has
   * never been launched. Removing an ACTIVE, DONE, FAILED, or BLOCKED task
   * would either corrupt in-flight supervision or discard real history, so
   * both are refused rather than silently allowed.
   *
   * @param {object} queue
   * @param {string} taskId
   * @returns {{ok: boolean, reason?: string}}
   */
  removeTask(queue, taskId) {
    const index = queue.tasks.findIndex((t) => t.id === taskId);
    if (index === -1) return { ok: false, reason: `No task "${taskId}" in the queue.` };

    const task = queue.tasks[index];
    if (task.state !== TaskState.PENDING) {
      return {
        ok: false,
        reason: `Task "${taskId}" is ${task.state}, not pending — only a task that ` +
          'has never been launched can be removed.',
      };
    }

    queue.tasks.splice(index, 1);
    this.save(queue);
    this.logger.info('Task removed from queue', { project: queue.project, taskId });
    return { ok: true };
  }

  /**
   * Move a PENDING task one position earlier or later among the other
   * PENDING tasks. Cannot reorder a task that has already started, and
   * cannot move a task past one that has already started or finished.
   *
   * @param {object} queue
   * @param {string} taskId
   * @param {'up'|'down'} direction - 'up' = earlier, 'down' = later.
   * @returns {{ok: boolean, reason?: string}}
   */
  reorderTask(queue, taskId, direction) {
    const index = queue.tasks.findIndex((t) => t.id === taskId);
    if (index === -1) return { ok: false, reason: `No task "${taskId}" in the queue.` };
    if (queue.tasks[index].state !== TaskState.PENDING) {
      return { ok: false, reason: `Task "${taskId}" is not pending — cannot reorder it.` };
    }

    const swapWith = direction === 'up' ? index - 1 : index + 1;
    if (swapWith < 0 || swapWith >= queue.tasks.length) {
      return { ok: false, reason: `Task "${taskId}" is already at that end of the queue.` };
    }
    if (queue.tasks[swapWith].state !== TaskState.PENDING) {
      return {
        ok: false,
        reason: `Cannot move "${taskId}" past "${queue.tasks[swapWith].id}", ` +
          `which is already ${queue.tasks[swapWith].state}.`,
      };
    }

    [queue.tasks[index], queue.tasks[swapWith]] = [queue.tasks[swapWith], queue.tasks[index]];
    this.save(queue);
    this.logger.info('Task reordered', { project: queue.project, taskId, direction });
    return { ok: true };
  }

  /**
   * Phase P7: operator override — reset the current BLOCKED/FAILED task
   * back to PENDING (attempts, checkpoint, and verify result cleared) so
   * the next `start` retries it, instead of falling through to a static-
   * plan/legacy restart. Requires a human decision (the `tasks approve`
   * CLI or `POST /api/tasks/:project/approve`) — never automatic, which
   * is what keeps P0's loop-prevention guarantee intact: nothing in the
   * supervision loop itself ever re-enters a task that `block()` shut the
   * door on.
   *
   * @param {object} queue
   * @param {string} taskId
   * @returns {{ok: boolean, reason?: string}}
   */
  approveRetry(queue, taskId) {
    const task = this.currentBlockedOrFailedTask(queue, taskId);
    if (task.reason) return task;

    task.task.state = TaskState.PENDING;
    task.task.attempts = 0;
    task.task.checkpoint = null;
    task.task.lastVerifyResult = null;
    this.save(queue);
    this.logger.info('Task approved for retry by operator', { project: queue.project, taskId });
    return { ok: true };
  }

  /**
   * Phase P7: operator override — mark the current BLOCKED/FAILED task
   * done (with an `operator-skipped` checkpoint noting why) and advance
   * past it, for when automated verification can't be satisfied but a
   * human has confirmed the work is acceptable, or that it should simply
   * be abandoned. Only ever the current task, only from a terminal state
   * — this never touches an ACTIVE task, so it can never interfere with a
   * live agent (a task can only be BLOCKED/FAILED once that run has
   * already ended and supervision has already stopped — see `block()`).
   *
   * @param {object} queue
   * @param {string} taskId
   * @param {string} [reason]
   * @returns {{ok: boolean, reason?: string}}
   */
  operatorSkip(queue, taskId, reason) {
    const task = this.currentBlockedOrFailedTask(queue, taskId);
    if (task.reason) return task;

    task.task.state = TaskState.DONE;
    task.task.checkpoint = {
      ...(task.task.checkpoint ?? {}),
      outcome: 'operator-skipped',
      summary: reason ?? 'Skipped by operator',
    };
    this.save(queue);
    this.advance(queue);
    this.logger.info('Task skipped by operator', { project: queue.project, taskId, reason });
    return { ok: true };
  }

  /**
   * Shared guard for `approveRetry`/`operatorSkip`: the named task must be
   * the CURRENT task (index-wise) and in a terminal, non-resumable state.
   * Returns `{ task }` on success or `{ ok: false, reason }` on failure —
   * callers check `.reason` to distinguish the two without a second lookup.
   */
  currentBlockedOrFailedTask(queue, taskId) {
    const current = this.current(queue);
    if (!current || current.id !== taskId) {
      return { ok: false, reason: `Task "${taskId}" is not the current task in the queue.` };
    }
    if (TASK_RESUMABLE_STATES.includes(current.state)) {
      return {
        ok: false,
        reason: `Task "${taskId}" is ${current.state}, not blocked/failed — nothing to approve or skip.`,
      };
    }
    return { task: current };
  }
}

export default TaskQueue;
