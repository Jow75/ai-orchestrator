/**
 * taskQueue.js — Persistent progress through a mission's task plan.
 *
 * Where `missionPlan.js` is the immutable plan (derived from project JSON),
 * `TaskQueue` is the mutable progress through it: which task is current,
 * how many attempts it has had, and its outcome once finished. Persisted at
 * `state/tasks/<project>.json` via the same atomic-write primitives as
 * every other piece of orchestrator state — a crash, rate limit, or reboot
 * mid-task loses nothing; the next start resumes the exact same task.
 *
 * A task queue is scoped to one session: if a new session starts (a truly
 * fresh mission, not a resume), the queue reinitializes from the plan.
 */

import path from 'node:path';
import { writeJsonAtomic, readJsonSafe } from '../state/statePersistence.js';
import { TaskState, TASK_RESUMABLE_STATES } from './taskState.js';

export class TaskQueue {
  /**
   * @param {object} options
   * @param {string} options.tasksDir - Directory for per-project task queues.
   * @param {object} options.logger - Module logger.
   */
  constructor({ tasksDir, logger }) {
    this.tasksDir = tasksDir;
    this.logger = logger;
  }

  file(project) {
    return path.join(this.tasksDir, `${project}.json`);
  }

  /** Load the persisted queue for a project, or null if none exists. */
  load(project) {
    return readJsonSafe(this.file(project), { logger: this.logger });
  }

  /**
   * Load the existing queue if it matches this session and plan, otherwise
   * initialize a fresh one. This is the single entry point the orchestrator
   * calls at the start of a mission-mode run.
   *
   * @param {string} project - Project name.
   * @param {object[]} planTasks - Normalized tasks (see missionPlan.js).
   * @param {string} sessionId - The active session's id.
   * @returns {object} The queue state (persisted shape — see initialize()).
   */
  getOrInitialize(project, planTasks, sessionId) {
    const existing = this.load(project);
    const planIds = planTasks.map((t) => t.id);
    const matchesPlan = existing
      && existing.sessionId === sessionId
      && existing.tasks.length === planIds.length
      && existing.tasks.every((t, i) => t.id === planIds[i]);

    if (matchesPlan) return existing;

    if (existing && existing.sessionId === sessionId) {
      // Same session, but the task plan itself changed shape — the project
      // config was edited mid-mission. Reconciling arbitrary edits is out
      // of scope for this phase; restart the queue and say so plainly.
      this.logger.warn('Task plan changed mid-mission; restarting the task queue', {
        project, previousTaskIds: existing.tasks.map((t) => t.id), newTaskIds: planIds,
      });
    }

    return this.initialize(project, planTasks, sessionId);
  }

  /** Create and persist a fresh queue from a plan. */
  initialize(project, planTasks, sessionId) {
    const queue = {
      project,
      sessionId,
      currentIndex: 0,
      tasks: planTasks.map((t) => ({
        id: t.id,
        state: TaskState.PENDING,
        attempts: 0,
        checkpoint: null,
      })),
    };
    this.save(queue);
    this.logger.info('Task queue initialized', { project, taskCount: planTasks.length });
    return queue;
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
}

export default TaskQueue;
