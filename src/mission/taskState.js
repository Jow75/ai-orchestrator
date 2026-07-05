/**
 * taskState.js — Task lifecycle states.
 *
 * Mirrors the session-level lifecycle (`state/sessionManager.js`) at the
 * granularity of a single task within a multi-task mission.
 *
 *   PENDING ──► ACTIVE ──► DONE
 *                 │  ▲
 *                 ▼  │ (verification failed, retries remain)
 *              VERIFYING
 *                 │
 *                 ▼ (retries exhausted, or agent/breaker reports blocked)
 *          FAILED / BLOCKED
 *
 * VERIFYING is transient in this phase (verification is synchronous, run
 * immediately after each launch) rather than a state a task rests in across
 * a restart — it is defined now so a future asynchronous verifier (e.g. a
 * CI pipeline polled over time) has a natural home without a state-machine
 * redesign.
 */

export const TaskState = Object.freeze({
  PENDING: 'pending',
  ACTIVE: 'active',
  VERIFYING: 'verifying',
  DONE: 'done',
  FAILED: 'failed',
  BLOCKED: 'blocked',
});

/** Task states that mean "this task still needs launches." */
export const TASK_RESUMABLE_STATES = Object.freeze([TaskState.PENDING, TaskState.ACTIVE]);

export default { TaskState, TASK_RESUMABLE_STATES };
