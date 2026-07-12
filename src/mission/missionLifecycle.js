/**
 * missionLifecycle.js — Phase 10D: the standardized mission lifecycle.
 *
 * Every mission progresses through one visible, recorded state machine:
 *
 *   received → analyzed → planned → [approval-pending → approved] →
 *   agents-assigned → executing ⇄ verifying ⇄ fixing →
 *   completed | blocked | cancelled | failed
 *
 * The timeline (P0) answers "what happened"; the lifecycle answers "where
 * IS this mission right now, and how did it get there". Persisted per
 * project at `state/lifecycle/<project>.json` as the current state plus
 * the full transition history, exposed via `GET /api/lifecycle/:project`,
 * the `lifecycle` CLI command, and the desktop Missions view.
 *
 * Recording style matches StatusManager: the orchestrator (and Approval
 * Manager, via attachApprovals) drives transitions directly; the tracker
 * dedupes same-state repeats so a retry loop doesn't flood the history.
 * Like every observability store here, failures are logged and swallowed —
 * lifecycle recording must never disturb supervision.
 */

import path from 'node:path';
import { writeJsonAtomic, readJsonSafe } from '../state/statePersistence.js';

/** Every lifecycle state a mission can be in. */
export const LIFECYCLE_STATES = Object.freeze([
  'received', //         mission accepted by the orchestrator
  'analyzed', //         project config validated, mode determined
  'planned', //          task plan loaded / queue initialized
  'approval-pending', // paused on an owner decision
  'approved', //         the owner approved; continuing
  'agents-assigned', //  work routed to agents
  'executing', //        an agent is working
  'verifying', //        a run finished; verification deciding
  'fixing', //           verification failed; retrying with a briefing
  'completed', //        every task verified done
  'blocked', //          stopped: cannot make progress without help
  'cancelled', //        stopped by the operator
  'failed', //           gave up (crash budget, launch failure, ...)
]);

/** States that end a mission (a new start begins a fresh cycle). */
export const TERMINAL_STATES = Object.freeze(['completed', 'blocked', 'cancelled', 'failed']);

export class MissionLifecycle {
  /**
   * @param {object} options
   * @param {string} [options.lifecycleDir] - Per-project lifecycle files.
   *   Absent ⇒ every method is a safe no-op (pre-Phase-10 test harnesses).
   * @param {object} options.logger
   */
  constructor({ lifecycleDir, logger }) {
    this.lifecycleDir = lifecycleDir;
    this.logger = logger;
  }

  file(project) {
    return path.join(this.lifecycleDir, `${project}.json`);
  }

  /** Current lifecycle record for a project, or null. */
  get(project) {
    if (!this.lifecycleDir) return null;
    return readJsonSafe(this.file(project), { logger: this.logger });
  }

  /**
   * Record a transition. Unknown states are refused (typo guard); a
   * transition to the current state is ignored (dedupe); a transition on a
   * mission already in a terminal state starts a NEW cycle when the new
   * state is 'received' (the next mission), otherwise records normally —
   * operators can re-open via approve/retry flows.
   *
   * @param {string} project
   * @param {string} to - One of {@link LIFECYCLE_STATES}.
   * @param {string} [reason] - Human-readable cause, kept in history.
   * @returns {object|null} The updated record.
   */
  transition(project, to, reason) {
    if (!this.lifecycleDir) return null;
    if (!LIFECYCLE_STATES.includes(to)) {
      this.logger.warn('Ignoring unknown lifecycle state', { project, to });
      return this.get(project);
    }

    const record = this.get(project) ?? { project, state: null, history: [] };
    if (record.state === to) return record; // dedupe repeats

    const entry = {
      from: record.state,
      to,
      at: new Date().toISOString(),
      ...(reason ? { reason } : {}),
    };
    record.state = to;
    record.updatedAt = entry.at;
    record.history.push(entry);
    // Keep history bounded; the timeline holds the long tail of events.
    if (record.history.length > 200) record.history = record.history.slice(-200);

    try {
      writeJsonAtomic(this.file(project), record);
    } catch (error) {
      this.logger.warn('Failed to persist lifecycle transition', {
        project, to, error: error.message,
      });
    }
    return record;
  }

  /**
   * Subscribe to an Approval Manager so approval pauses/continues appear in
   * the lifecycle without the orchestrator having to know about them.
   * @param {import('node:events').EventEmitter} approvalManager
   */
  attachApprovals(approvalManager) {
    approvalManager.on('approval:required', ({ project, request }) =>
      this.transition(project, 'approval-pending', `awaiting decision on ${request.id} (${request.category})`));
    approvalManager.on('human-action:required', ({ project, request }) =>
      this.transition(project, 'approval-pending', `awaiting human action ${request.id} (${request.category})`));
    approvalManager.on('approval:resolved', ({ project, request }) => {
      if (request.status === 'approved' || request.status === 'modified' || request.status === 'done') {
        this.transition(project, 'approved', `${request.id} ${request.status}`);
      }
      // A rejection's consequence (blocked) is recorded by the orchestrator,
      // which owns that outcome — not inferred here.
    });
  }
}

export default MissionLifecycle;
