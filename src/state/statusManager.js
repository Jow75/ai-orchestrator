/**
 * statusManager.js — Status Manager.
 *
 * Maintains `status.json`: a live, human-readable snapshot of what the
 * orchestrator is doing right now. Users (and the dashboard API) read this
 * file to check on a long-running mission without opening the agent.
 *
 * The file is advisory output only — the orchestrator never reads it back
 * for decisions (session records in state/ are the source of truth).
 */

import { writeJsonAtomic } from './statePersistence.js';

export class StatusManager {
  /**
   * @param {object} options
   * @param {string} options.statusFile - Absolute path of status.json.
   * @param {object} options.logger - Module logger.
   * @param {number} [options.updateIntervalMs] - Periodic refresh cadence.
   */
  constructor({ statusFile, logger, updateIntervalMs = 5_000 }) {
    this.statusFile = statusFile;
    this.logger = logger;
    this.updateIntervalMs = updateIntervalMs;
    this.timer = null;
    this.startedAt = Date.now();

    /** The live status model; see write() for the serialised shape. */
    this.status = {
      orchestrator: {
        state: 'starting',
        pid: process.pid,
        startedAt: new Date(this.startedAt).toISOString(),
        version: '2.4.0',
      },
      project: null,
      session: null,
      agent: {
        driver: null,
        pid: null,
        childPids: [],
        state: 'not-started',
      },
      activity: {
        currentTask: null,
        lastOutputAt: null,
        lastRestartAt: null,
        lastResumeAt: null,
      },
      counters: {
        runs: 0,
        resumes: 0,
        crashes: 0,
        rateLimits: 0,
      },
      rateLimit: {
        waiting: false,
        resumeAt: null,
        estimatedWaitMs: null,
      },
      /** Phase P2: task-queue progress, populated only in mission mode. */
      mission: {
        mode: 'legacy',
        currentTaskId: null,
        taskIndex: null,
        totalTasks: 0,
        taskState: null,
        taskAttempts: 0,
        /** Phase 9: which agent is (or last) handling the current work. */
        currentAgent: null,
        currentAgentRole: null,
      },
    };
  }

  /** Merge a partial update into the status model and persist immediately. */
  set(patch) {
    for (const [section, value] of Object.entries(patch)) {
      if (
        value && typeof value === 'object' && !Array.isArray(value) &&
        this.status[section] && typeof this.status[section] === 'object'
      ) {
        Object.assign(this.status[section], value);
      } else {
        this.status[section] = value;
      }
    }
    this.write();
  }

  /** Copy live counters from a session record into the status model. */
  syncSession(session) {
    this.set({
      project: session.project,
      session: {
        id: session.id,
        engineSessionId: session.engineSessionId,
        state: session.state,
        createdAt: session.createdAt,
      },
      counters: {
        runs: session.runs,
        resumes: session.resumes,
        crashes: session.crashes,
        rateLimits: session.rateLimits,
      },
      rateLimit: {
        waiting: session.state === 'waiting-rate-limit',
        resumeAt: session.resumeAt,
        estimatedWaitMs: session.resumeAt
          ? Math.max(0, new Date(session.resumeAt).getTime() - Date.now())
          : null,
      },
    });
  }

  /**
   * Copy live task-queue progress into the status model. Pass `null` for a
   * legacy (single-prompt) mission to clear any stale task info.
   * @param {object|null} queue - A TaskQueue persisted state object, or null.
   */
  syncTaskQueue(queue) {
    if (!queue) {
      this.set({
        mission: {
          mode: 'legacy', currentTaskId: null, taskIndex: null,
          totalTasks: 0, taskState: null, taskAttempts: 0,
        },
      });
      return;
    }
    const current = queue.tasks[queue.currentIndex] ?? null;
    this.set({
      mission: {
        mode: 'tasks',
        currentTaskId: current?.id ?? null,
        taskIndex: current ? queue.currentIndex : queue.tasks.length,
        totalTasks: queue.tasks.length,
        taskState: current?.state ?? 'done',
        taskAttempts: current?.attempts ?? 0,
      },
    });
  }

  /** Serialise the current model to status.json (atomic write). */
  write() {
    const snapshot = {
      ...this.status,
      orchestrator: {
        ...this.status.orchestrator,
        uptimeMs: Date.now() - this.startedAt,
      },
      updatedAt: new Date().toISOString(),
    };
    try {
      writeJsonAtomic(this.statusFile, snapshot);
    } catch (error) {
      // Status is best-effort observability; never let it kill supervision.
      this.logger.warn('Failed to write status.json', { error: error.message });
    }
  }

  /** Return the current in-memory status (for the dashboard API). */
  get() {
    return {
      ...this.status,
      orchestrator: {
        ...this.status.orchestrator,
        uptimeMs: Date.now() - this.startedAt,
      },
    };
  }

  /** Begin periodic refreshes so uptime/wait estimates stay current. */
  startUpdates() {
    if (this.timer) return;
    this.timer = setInterval(() => this.write(), this.updateIntervalMs);
    this.timer.unref(); // never keep the process alive just for status writes
    this.write();
  }

  /** Stop periodic refreshes and write a final snapshot. */
  stopUpdates(finalState = 'stopped') {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.status.orchestrator.state = finalState;
    this.write();
  }
}

export default StatusManager;
