/**
 * exitReason.js — Standardized per-run outcome classification.
 *
 * `classifyExit()` (exitClassifier.js) answers "why did the PROCESS exit?"
 * in engine terms. This module answers the higher-level question the rest of
 * the platform actually wants: "what was the OUTCOME of this run?", as one
 * value from a fixed, provider-neutral vocabulary.
 *
 * Every run is stamped with an `exitReason`. P2 (missions), P3 (prompt
 * queue), and the desktop UI consume it directly instead of re-deriving
 * intent from raw exit codes and output — the classification happens once,
 * here, and is recorded in the ledger, the session, and the timeline.
 *
 * Pure logic, no I/O. Deliberately engine-agnostic: it is a function of the
 * generic exit cause plus progress/blocked facts, never of Claude specifics.
 */

import { ExitCause } from './exitClassifier.js';

/**
 * The complete, fixed vocabulary of run outcomes. Some values are not yet
 * produced in the current phase (verification_failed → P6, timeout →
 * future); they are defined now so later phases need not change this enum.
 * @enum {string}
 */
export const ExitReason = Object.freeze({
  PROGRESS: 'progress', //                     ran and advanced the workspace
  COMPLETED: 'completed', //                   declared the mission finished
  NO_PROGRESS: 'no_progress', //               ran cleanly but changed nothing
  BLOCKED_PERMISSION: 'blocked_permission', // needs a permission it lacks
  BLOCKED_TOOL: 'blocked_tool', //             lacks access to a tool/resource
  BLOCKED_MISSING_FILE: 'blocked_missing_file', // a required file is absent
  BLOCKED_OTHER: 'blocked_other', //           blocked for another stated reason
  RATE_LIMIT: 'rate_limit', //                 hit the engine usage limit
  NETWORK: 'network', //                       transient network failure
  CRASH: 'crash', //                           unexpected exit / external kill
  SPAWN_FAILURE: 'spawn_failure', //           the engine never started
  TIMEOUT: 'timeout', //                       reserved (no timeouts in P0)
  VERIFICATION_FAILED: 'verification_failed', //reserved for the P6 verifier
  USER_STOP: 'user_stop', //                   operator requested a stop
  ORCHESTRATOR_STOP: 'orchestrator_stop', //   orchestrator stopped itself
  UNKNOWN: 'unknown',
});

/** Map a blocked-state category (blockedPatterns.js) to a blocked exitReason. */
const BLOCKED_CATEGORY_TO_REASON = {
  'permission-denied': ExitReason.BLOCKED_PERMISSION,
  'no-access': ExitReason.BLOCKED_TOOL,
  'missing-file': ExitReason.BLOCKED_MISSING_FILE,
  'cannot-proceed': ExitReason.BLOCKED_OTHER,
  'awaiting-input': ExitReason.BLOCKED_OTHER,
};

/**
 * Derive the standardized outcome of a single run.
 *
 * @param {object} params
 * @param {string} params.cause - The generic ExitCause from classifyExit().
 * @param {boolean} params.markerHit - Did the mission completion marker appear?
 * @param {boolean} params.progressed - Did the workspace signature change?
 * @param {object} [params.blocked] - detectBlockedState() result, if any.
 * @param {boolean} [params.stopRequested] - Was an operator stop in progress?
 * @returns {string} An {@link ExitReason} value.
 */
export function deriveExitReason({ cause, markerHit, progressed, blocked, stopRequested }) {
  // An operator stop overrides the run's own outcome: whatever the process
  // did, the reason it ended here is that a human asked us to stop.
  if (stopRequested) return ExitReason.USER_STOP;

  switch (cause) {
    case ExitCause.USAGE_LIMIT:
      return ExitReason.RATE_LIMIT;
    case ExitCause.NETWORK:
      return ExitReason.NETWORK;
    case ExitCause.SPAWN_FAILURE:
      return ExitReason.SPAWN_FAILURE;
    case ExitCause.INTERRUPTED: // external kill (not our stop) is a crash
    case ExitCause.CRASH:
      return ExitReason.CRASH;
    case ExitCause.COMPLETED: {
      if (markerHit) return ExitReason.COMPLETED;
      if (progressed) return ExitReason.PROGRESS;
      // No marker, no progress: a blocked signal explains why nothing happened.
      if (blocked?.blocked) {
        return BLOCKED_CATEGORY_TO_REASON[blocked.category] ?? ExitReason.BLOCKED_OTHER;
      }
      return ExitReason.NO_PROGRESS;
    }
    default:
      return ExitReason.UNKNOWN;
  }
}

/** Reasons that indicate the agent is stuck and needs human attention. */
export const BLOCKED_REASONS = Object.freeze([
  ExitReason.BLOCKED_PERMISSION,
  ExitReason.BLOCKED_TOOL,
  ExitReason.BLOCKED_MISSING_FILE,
  ExitReason.BLOCKED_OTHER,
]);

export default { ExitReason, deriveExitReason, BLOCKED_REASONS };
