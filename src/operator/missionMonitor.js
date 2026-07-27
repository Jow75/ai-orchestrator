/**
 * missionMonitor.js — Phase 12 M2, Priority 4: real progress, or none.
 *
 * The directive asks for live updates — Planning, Coding, Testing, Blocked,
 * Waiting for approval, Finished — and then constrains them absolutely:
 *
 *     "Progress must come from real execution.
 *      Never fake percentages. Never invent confidence. Never simulate work."
 *
 * So this module measures rather than reports. Every 15 seconds it re-reads
 * state that a MISSION WROTE — `state/lifecycle/<project>.json` (Phase 10D)
 * and `state/tasks/<project>.json` (Phase P2) — and turns each observed CHANGE
 * into an event. A task counted as done is a task whose verifiers passed and
 * whose checkpoint was persisted. There is no percentage anywhere in this file
 * because there is no honest one to compute: elapsed time is not progress, and
 * a mission that has finished 2 of 5 tasks is exactly "2/5", not "40%".
 *
 * WHY DERIVE RATHER THAN HAVE WORKERS REPORT. Two reasons, both structural:
 *
 *  1. It keeps the worker path at zero changes for a second milestone. The
 *     Phase 12 Invariant survives because there is nothing new inside a
 *     mission to regress.
 *  2. It works for workers this daemon did not spawn — adopted after a service
 *     restart, or started standalone. A push-based design would go silent for
 *     exactly the missions most worth watching (the ones that outlived
 *     something).
 *
 * WHAT IT DELIBERATELY DOES NOT ANNOUNCE. A running mission already notifies
 * the owner about approvals, completion, blocking, and crashes through the
 * notification engine. Re-announcing those here would double every message
 * that matters most — the precise defect class Phase 11 M2 spent a milestone
 * eliminating. The monitor therefore announces only the phases nothing else
 * covers, and records everything as events regardless.
 */

import { TERMINAL_STATES } from '../mission/missionLifecycle.js';
import { missionEventFor } from '../events/eventTypes.js';
import { TaskState } from '../mission/taskState.js';
import { renderPhaseUpdate } from './render.js';

/** How often mission state is re-derived from disk. */
export const DEFAULT_INTERVAL_MS = 15_000;

/**
 * Phases pushed to the owner's channel.
 *
 * Everything else is excluded for a stated reason, not by omission:
 *   received / analyzed   sub-second book-keeping before any work; 'planned'
 *                         is the first moment there is anything to say.
 *   approval-pending      the Approval Manager already published the request
 *                         itself, with the buttons to answer it.
 *   approved              the owner's own reply already confirmed it.
 *   agents-assigned       an internal routing step, invisible to the outcome.
 *   completed / blocked   the mission sends a full Mission Card for these.
 *   failed                the mission sends 'session:gave-up'.
 */
export const ANNOUNCED_PHASES = Object.freeze([
  'planned', 'executing', 'verifying', 'fixing', 'cancelled',
]);

export class MissionMonitor {
  /**
   * @param {object} deps
   * @param {import('./projectRegistry.js').ProjectRegistry} deps.registry
   * @param {import('../mission/missionLifecycle.js').MissionLifecycle} deps.lifecycle
   * @param {import('../mission/taskQueue.js').TaskQueue} deps.taskQueue
   * @param {import('../approvals/approvalStore.js').ApprovalStore} deps.approvalStore
   * @param {import('../events/eventStore.js').EventStore} deps.events
   * @param {{broadcast: (text: string) => Promise<number>}} [deps.gateway]
   * @param {object} [deps.config] - The `operator` config block.
   * @param {object} deps.logger
   */
  constructor({ registry, lifecycle, taskQueue, approvalStore, events, gateway, config, logger }) {
    this.registry = registry;
    this.lifecycle = lifecycle;
    this.taskQueue = taskQueue;
    this.approvalStore = approvalStore;
    this.events = events;
    this.gateway = gateway;
    this.config = config ?? {};
    this.logger = logger;
    this.timer = null;
    /** project → last observed snapshot; the baseline every change is against. */
    this.seen = new Map();
    /** project → epoch ms of the last pushed update (rate limiting). */
    this.lastPush = new Map();
  }

  get intervalMs() {
    return this.config.progressIntervalMs ?? DEFAULT_INTERVAL_MS;
  }

  /**
   * Prime the baseline WITHOUT announcing anything.
   *
   * Called at daemon start: the state on disk describes what already happened,
   * possibly days ago. Announcing it would page the owner about a mission that
   * finished last Tuesday every time the service restarts.
   */
  prime() {
    for (const project of this.projects()) {
      this.seen.set(project, this.snapshot(project));
    }
    return this.seen.size;
  }

  start() {
    if (this.timer) return false;
    this.prime();
    this.timer = setInterval(() => {
      this.tick().catch((error) => {
        this.logger?.warn('Mission monitor tick failed', { error: error.message });
      });
    }, this.intervalMs);
    this.timer.unref();
    return true;
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Projects worth watching: every defined one (reads are small file reads). */
  projects() {
    try {
      return this.registry.names();
    } catch (error) {
      this.logger?.warn('Could not list projects', { error: error.message });
      return [];
    }
  }

  /** Everything observable about one project's mission, right now. */
  snapshot(project) {
    const lifecycle = this.lifecycle?.get(project) ?? null;
    const queue = this.taskQueue?.load(project) ?? null;
    const tasks = queue?.tasks ?? [];
    return {
      state: lifecycle?.state ?? null,
      updatedAt: lifecycle?.updatedAt ?? null,
      tasksDone: tasks.filter((t) => t.state === TaskState.DONE).length,
      tasksTotal: tasks.length,
      currentTaskId: tasks[queue?.currentIndex ?? 0]?.id ?? null,
      pendingApprovalIds: (this.approvalStore?.pending(project) ?? []).map((r) => r.id),
    };
  }

  /**
   * One observation round.
   *
   * @returns {Promise<object[]>} The changes observed this round.
   */
  async tick(now = Date.now()) {
    const changes = [];
    for (const project of this.projects()) {
      const before = this.seen.get(project) ?? null;
      const after = this.snapshot(project);
      this.seen.set(project, after);
      if (!before) continue; // first sighting is a baseline, never news

      const change = this.diff(project, before, after);
      if (!change) continue;
      changes.push(change);
      this.record(project, change);
      // eslint-disable-next-line no-await-in-loop
      await this.announce(project, change, now);
    }
    return changes;
  }

  /** What actually changed between two snapshots, or null. */
  diff(project, before, after) {
    const phaseChanged = before.state !== after.state && after.state !== null;
    const taskProgressed = after.tasksDone > before.tasksDone;
    const taskChanged = before.currentTaskId !== after.currentTaskId;
    const newApprovals = after.pendingApprovalIds.filter(
      (id) => !before.pendingApprovalIds.includes(id)
    );

    if (!phaseChanged && !taskProgressed && !taskChanged && !newApprovals.length) return null;
    return {
      project,
      state: after.state,
      previousState: before.state,
      phaseChanged,
      taskProgressed,
      taskChanged,
      newApprovals,
      tasksDone: after.tasksDone,
      tasksTotal: after.tasksTotal,
      currentTaskId: after.currentTaskId,
      terminal: TERMINAL_STATES.includes(after.state),
    };
  }

  /**
   * Write the change to the event log. This happens for EVERY change, whether
   * or not the owner is messaged — the log is the system's record, not the
   * notification history.
   */
  record(project, change) {
    for (const id of change.newApprovals) {
      const request = this.approvalStore?.get(project, id);
      this.events?.append({
        type: 'approval.required',
        project,
        actor: 'mission',
        payload: {
          id,
          title: request?.title ?? null,
          category: request?.category ?? null,
          approvalClass: request?.approvalClass ?? null,
        },
      });
    }

    if (change.phaseChanged || change.taskProgressed || change.taskChanged) {
      this.events?.append({
        type: 'mission.progress',
        project,
        actor: 'mission',
        payload: {
          state: change.state,
          previousState: change.previousState,
          tasksDone: change.tasksDone,
          tasksTotal: change.tasksTotal,
          currentTaskId: change.currentTaskId,
        },
      });
    }

    if (change.phaseChanged && change.terminal) {
      const type = missionEventFor(change.state);
      if (type) {
        this.events?.append({
          type,
          project,
          actor: 'mission',
          payload: { tasksDone: change.tasksDone, tasksTotal: change.tasksTotal },
        });
      }
    }
  }

  /**
   * Push the change to the owner, if it is one of the phases nothing else
   * announces and the per-project rate limit allows it.
   *
   * @returns {Promise<string|null>} The text sent, or null.
   */
  async announce(project, change, now = Date.now()) {
    if (!this.gateway) return null;
    if (this.config.progressUpdates === false) return null;
    if (!change.phaseChanged || !ANNOUNCED_PHASES.includes(change.state)) return null;

    const minInterval = this.config.progressMinIntervalMs ?? 60_000;
    // `undefined` means nothing has ever been pushed for this project, which
    // always passes. Treating it as "pushed at epoch 0" happens to work with a
    // real clock and silently swallows the first update with any other one —
    // a limiter whose correctness depends on the current year is not a limiter.
    const last = this.lastPush.get(project);
    if (last !== undefined && minInterval > 0 && now - last < minInterval) {
      // Suppressed, not lost: the event is already recorded, and the next
      // /status shows the current phase. A retry loop flipping between
      // executing and fixing must not become a notification storm.
      this.logger?.debug?.('Suppressed a progress update (rate limit)', {
        project, state: change.state,
      });
      return null;
    }
    this.lastPush.set(project, now);

    const text = renderPhaseUpdate({
      project,
      state: change.state,
      tasksDone: change.tasksDone,
      tasksTotal: change.tasksTotal,
      taskId: change.currentTaskId,
    });
    await this.gateway.broadcast(text);
    return text;
  }
}

export default MissionMonitor;
