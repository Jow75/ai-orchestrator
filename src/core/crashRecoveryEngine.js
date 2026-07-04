/**
 * crashRecoveryEngine.js — Crash Recovery Engine.
 *
 * Decides what happens after the agent crashes: restart with exponential
 * backoff, or — after too many consecutive crashes — give up and alert the
 * operator instead of thrashing forever.
 *
 * "Consecutive" is the key word: any successful run resets the counter, so
 * a mission that occasionally crashes but keeps making progress is allowed
 * to keep going indefinitely.
 */

export class CrashRecoveryEngine {
  /**
   * @param {object} options
   * @param {object} options.config - The `recovery` config block
   *   ({maxConsecutiveCrashes, crashBackoffBaseMs, crashBackoffMaxMs}).
   * @param {object} options.logger - Module logger.
   */
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Decide the response to a crash.
   *
   * @param {object} params
   * @param {number} params.consecutiveCrashes - Crashes since the last good run (>= 1).
   * @returns {{action: 'restart'|'give-up', delayMs: number, reason: string}}
   */
  decide({ consecutiveCrashes }) {
    if (consecutiveCrashes >= this.config.maxConsecutiveCrashes) {
      const reason =
        `${consecutiveCrashes} consecutive crashes reached the configured ` +
        `limit (${this.config.maxConsecutiveCrashes}); refusing to thrash. ` +
        'The session is preserved and will resume on the next start.';
      this.logger.error('Giving up after repeated crashes', { consecutiveCrashes });
      return { action: 'give-up', delayMs: 0, reason };
    }

    // Exponential backoff: base, 2x, 4x ... capped at the configured max.
    const delayMs = Math.min(
      this.config.crashBackoffBaseMs * 2 ** (consecutiveCrashes - 1),
      this.config.crashBackoffMaxMs
    );

    this.logger.info('Crash recovery scheduled', {
      consecutiveCrashes,
      restartInMs: delayMs,
    });

    return {
      action: 'restart',
      delayMs,
      reason: `Restart ${consecutiveCrashes}/${this.config.maxConsecutiveCrashes} after ${delayMs} ms backoff`,
    };
  }
}

export default CrashRecoveryEngine;
