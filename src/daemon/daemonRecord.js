/**
 * daemonRecord.js — Phase 12 M1: the Core Service's process record.
 *
 * The daemon writes `state/daemon.json` while it is alive: pid, API port,
 * version, start time. Clients (CLI, desktop, and later the Telegram router)
 * read it to answer one question — "is the service up, and where do I reach
 * it?" — without needing a network probe first.
 *
 * This is deliberately a SEPARATE file from `state/heartbeat.json`, and that
 * separation is load-bearing. heartbeat.json is, and remains, the standalone
 * orchestrator's single-instance lock (src/app.js:296). If the daemon wrote
 * there instead, every pre-Phase-12 `status` command and the desktop's
 * `isLive()` check would report "a mission is being supervised" whenever the
 * service was merely idle. Two different questions deserve two different files:
 *
 *   heartbeat.json  → "is a standalone orchestrator supervising right now?"
 *   daemon.json     → "is the Core Service running right now?"
 *
 * The staleness contract matches heartbeat.js exactly (same three outcomes,
 * same PID-probe semantics), because operators already understand that model.
 */

import { writeJsonAtomic, readJsonSafe } from '../state/statePersistence.js';
import { isPidAlive } from '../state/heartbeat.js';
import { VERSION } from '../infra/version.js';

/** How often the daemon re-stamps its record (liveness for slow PID reuse). */
export const DAEMON_BEAT_MS = 15_000;

export class DaemonRecord {
  /**
   * @param {object} options
   * @param {string} options.daemonFile - Path of state/daemon.json.
   * @param {object} options.logger
   * @param {number} [options.intervalMs] - Re-stamp cadence.
   */
  constructor({ daemonFile, logger, intervalMs = DAEMON_BEAT_MS }) {
    this.daemonFile = daemonFile;
    this.logger = logger;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.context = {};
  }

  /**
   * Inspect any existing record before claiming the daemon role.
   *
   * @returns {{kind: 'clean'|'already-running'|'unclean-shutdown', previous: object|null}}
   */
  inspectPrevious() {
    const previous = readJsonSafe(this.daemonFile, { logger: this.logger });
    if (!previous || previous.state !== 'running') {
      return { kind: 'clean', previous: previous ?? null };
    }
    if (previous.pid && isPidAlive(previous.pid)) {
      return { kind: 'already-running', previous };
    }
    this.logger.warn('Previous daemon did not shut down cleanly', {
      previousPid: previous.pid,
      lastBeatAt: previous.timestamp,
    });
    return { kind: 'unclean-shutdown', previous };
  }

  /** Claim the daemon role and begin stamping. */
  start(context = {}) {
    this.context = context;
    this.beat('running');
    this.timer = setInterval(() => this.beat('running'), this.intervalMs);
    this.timer.unref();
  }

  /** Merge extra fields into future stamps (e.g. worker count). */
  setContext(context) {
    this.context = { ...this.context, ...context };
  }

  /** Write one stamp. Never throws — a record failure must not kill the service. */
  beat(state) {
    try {
      writeJsonAtomic(this.daemonFile, {
        state,
        pid: process.pid,
        version: VERSION,
        timestamp: new Date().toISOString(),
        ...this.context,
      });
    } catch (error) {
      this.logger.warn('Daemon record write failed', { error: error.message });
    }
  }

  /** Release the daemon role. */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.beat('stopped');
  }
}

/**
 * Read the current daemon record without constructing a DaemonRecord —
 * the read path clients use.
 *
 * @param {string} daemonFile
 * @param {object} [options]
 * @returns {{running: boolean, record: object|null, stale: boolean}}
 */
export function readDaemon(daemonFile, { logger } = {}) {
  const record = readJsonSafe(daemonFile, { logger });
  if (!record || record.state !== 'running') {
    return { running: false, record: record ?? null, stale: false };
  }
  if (record.pid && isPidAlive(record.pid)) {
    return { running: true, record, stale: false };
  }
  // "running" with a dead pid — the service died without cleanup.
  return { running: false, record, stale: true };
}

export default DaemonRecord;
