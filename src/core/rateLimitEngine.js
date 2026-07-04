/**
 * rateLimitEngine.js — Usage-Limit Recovery Engine.
 *
 * The number-one feature of AI-Orchestrator: when the engine reports that
 * its usage limit is reached, this module works out exactly how long to
 * wait, waits (interruptibly), and hands control back so the orchestrator
 * can resume the very same session. No progress is ever lost.
 *
 * The reset time is parsed from engine output by the driver (it knows its
 * engine's message formats); this engine applies policy: grace margin,
 * bounds, and the fallback wait when parsing fails.
 */

import { sleep } from '../infra/time.js';

/** Never wait less than this — a zero/negative wait would hot-loop.
 *  Overridable via config `rateLimit.minWaitMs` (mainly for tests). */
const MIN_WAIT_MS = 5_000;

/** Longest single sleep chunk; short chunks keep cancellation responsive. */
const SLEEP_CHUNK_MS = 5_000;

/** Progress logging cadence while waiting out a limit. */
const WAIT_LOG_INTERVAL_MS = 15 * 60 * 1000; // every 15 minutes

export class RateLimitEngine {
  /**
   * @param {object} options
   * @param {object} options.config - The `rateLimit` config block
   *   ({defaultWaitMs, maxWaitMs, resumeGraceMs}).
   * @param {object} options.logger - Module logger.
   */
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Decide how long to wait before resuming.
   *
   * @param {object} params
   * @param {import('../drivers/aiDriver.js').AIDriver} params.driver
   * @param {string} params.outputTail - Recent engine output.
   * @returns {{resumeAt: Date, waitMs: number, source: 'parsed'|'default'}}
   */
  computeWait({ driver, outputTail }) {
    const parsed = driver.extractLimitResetTime(outputTail);

    let waitMs;
    let source;
    if (parsed && !Number.isNaN(parsed.getTime())) {
      waitMs = parsed.getTime() + this.config.resumeGraceMs - Date.now();
      source = 'parsed';
    } else {
      waitMs = this.config.defaultWaitMs;
      source = 'default';
    }

    // Clamp: waits must be sane even if the engine announces a strange time.
    const minWaitMs = this.config.minWaitMs ?? MIN_WAIT_MS;
    waitMs = Math.min(Math.max(waitMs, minWaitMs), this.config.maxWaitMs);
    const resumeAt = new Date(Date.now() + waitMs);

    this.logger.info('Usage limit wait computed', {
      waitMs,
      resumeAt: resumeAt.toISOString(),
      source,
      parsedResetTime: parsed?.toISOString() ?? null,
    });

    return { resumeAt, waitMs, source };
  }

  /**
   * Sleep until `resumeAt`, logging progress and honouring cancellation.
   *
   * Re-derives the remaining time from the wall clock on every tick, so the
   * wait stays correct even if the machine sleeps/hibernates in between.
   *
   * @param {Date} resumeAt - When to wake up.
   * @param {object} [options]
   * @param {AbortSignal} [options.signal] - Cancels the wait (operator stop).
   * @returns {Promise<'elapsed'|'aborted'>}
   */
  async waitUntil(resumeAt, { signal } = {}) {
    let lastLog = Date.now();

    while (Date.now() < resumeAt.getTime()) {
      if (signal?.aborted) return 'aborted';

      const remainingMs = resumeAt.getTime() - Date.now();
      if (Date.now() - lastLog >= WAIT_LOG_INTERVAL_MS) {
        this.logger.info('Still waiting for usage limit reset', {
          remainingMinutes: Math.ceil(remainingMs / 60_000),
          resumeAt: resumeAt.toISOString(),
        });
        lastLog = Date.now();
      }

      // Sleep in short chunks so cancellation is responsive.
      const chunk = Math.min(remainingMs, SLEEP_CHUNK_MS);
      await sleep(chunk, signal);
    }

    return signal?.aborted ? 'aborted' : 'elapsed';
  }
}

export default RateLimitEngine;
