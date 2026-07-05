/**
 * loopBreaker.js — Progress circuit breaker & loop detection.
 *
 * The single most important safeguard added after the overnight incident.
 * It watches the count of consecutive runs that completed but produced no
 * measurable progress, and decides whether the orchestrator may continue.
 *
 * A run "made progress" when the workspace signature changed
 * (see progress/progressEngine.js). When enough runs in a row change nothing —
 * or when the agent explicitly reports it is blocked — the breaker trips:
 * the orchestrator stops launching, preserves state, and emits a diagnostic
 * report instead of burning quota.
 *
 * Pure logic, no I/O: the decision is a function of counters and config, so
 * it is trivially unit-testable and impossible to get "stuck open".
 */

/** @enum {string} */
export const BreakerAction = Object.freeze({
  CONTINUE: 'continue', // progress detected (or below threshold) — keep going
  TRIP: 'trip', //        stop: repeated no-progress or an explicit block
});

export class LoopBreaker {
  /**
   * @param {object} options
   * @param {object} options.config - The `progress` config block.
   * @param {object} options.logger - Module logger.
   */
  constructor({ config, logger }) {
    this.maxConsecutiveNoProgress = config.maxConsecutiveNoProgress;
    this.logger = logger;
  }

  /**
   * Decide whether to continue after a completed-but-unfinished run.
   *
   * @param {object} params
   * @param {boolean} params.progressed - Did the workspace signature change?
   * @param {number} params.consecutiveNoProgress - Count *including* this run
   *   when it made no progress (caller increments before calling).
   * @param {object} [params.blocked] - Result of detectBlockedState(); when
   *   `blocked` is true the breaker trips immediately (but only in the
   *   absence of progress — a blocked message alongside real changes is not
   *   fatal).
   * @returns {{action: string, reason: string, category?: string, hint?: string}}
   */
  decide({ progressed, consecutiveNoProgress, blocked }) {
    if (progressed) {
      return { action: BreakerAction.CONTINUE, reason: 'workspace changed — progress detected' };
    }

    // No progress this run. An explicit, specific block is decisive on its own.
    if (blocked?.blocked) {
      this.logger.warn('Loop breaker: agent reported a blocked state with no progress', {
        category: blocked.category,
      });
      return {
        action: BreakerAction.TRIP,
        reason: `Agent is blocked (${blocked.category}) and made no progress`,
        category: blocked.category,
        hint: blocked.hint,
      };
    }

    if (consecutiveNoProgress >= this.maxConsecutiveNoProgress) {
      this.logger.warn('Loop breaker tripped: repeated runs with no progress', {
        consecutiveNoProgress,
        threshold: this.maxConsecutiveNoProgress,
      });
      return {
        action: BreakerAction.TRIP,
        reason:
          `${consecutiveNoProgress} consecutive runs made no measurable progress ` +
          `(threshold ${this.maxConsecutiveNoProgress}). Stopping to avoid wasting usage.`,
        category: 'stagnation',
      };
    }

    return {
      action: BreakerAction.CONTINUE,
      reason:
        `no progress this run (${consecutiveNoProgress}/${this.maxConsecutiveNoProgress}) — ` +
        'continuing cautiously',
    };
  }
}

export default LoopBreaker;
