/**
 * heartbeat.js — Heartbeat Monitor.
 *
 * While supervising, the orchestrator stamps a heartbeat file every few
 * seconds. On startup it inspects the previous heartbeat:
 *
 *  - Heartbeat says "running" and that PID is gone  → the orchestrator died
 *    without a clean shutdown (power failure, reboot, kill). Combined with a
 *    resumable session record this triggers automatic recovery.
 *  - Heartbeat says "running" and the PID is alive  → another orchestrator
 *    instance is already supervising; refuse to double-launch.
 *
 * This is how "Windows rebooted mid-mission" turns into "the mission simply
 * continues" once Task Scheduler relaunches us.
 */

import { writeJsonAtomic, readJsonSafe } from './statePersistence.js';

export class Heartbeat {
  /**
   * @param {object} options
   * @param {string} options.heartbeatFile - Path of the heartbeat file.
   * @param {object} options.logger - Module logger.
   * @param {number} [options.intervalMs] - Stamping cadence.
   */
  constructor({ heartbeatFile, logger, intervalMs = 15_000 }) {
    this.heartbeatFile = heartbeatFile;
    this.logger = logger;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.context = {};
  }

  /**
   * Inspect the previous run's heartbeat before starting a new one.
   *
   * @returns {{ kind: 'clean'|'unclean-shutdown'|'already-running', previous: object|null }}
   */
  inspectPrevious() {
    const previous = readJsonSafe(this.heartbeatFile, { logger: this.logger });
    if (!previous || previous.state !== 'running') {
      return { kind: 'clean', previous };
    }

    if (previous.pid && isPidAlive(previous.pid)) {
      return { kind: 'already-running', previous };
    }

    // A "running" heartbeat with a dead PID means we never shut down cleanly.
    this.logger.warn('Unclean shutdown detected (stale running heartbeat)', {
      previousPid: previous.pid,
      lastBeatAt: previous.timestamp,
    });
    return { kind: 'unclean-shutdown', previous };
  }

  /**
   * Start stamping heartbeats.
   *
   * @param {object} [context] - Extra fields recorded with each beat
   *   (project name, session id) to aid post-mortems.
   */
  start(context = {}) {
    this.context = context;
    this.beat('running');
    this.timer = setInterval(() => this.beat('running'), this.intervalMs);
    this.timer.unref(); // heartbeats must not keep a finished process alive
  }

  /** Update the context recorded with future beats (e.g. session changes). */
  setContext(context) {
    this.context = { ...this.context, ...context };
  }

  /** Write one heartbeat stamp. */
  beat(state) {
    try {
      writeJsonAtomic(this.heartbeatFile, {
        state,
        pid: process.pid,
        timestamp: new Date().toISOString(),
        ...this.context,
      });
    } catch (error) {
      // Heartbeat failures must never take down supervision.
      this.logger.warn('Heartbeat write failed', { error: error.message });
    }
  }

  /** Stop stamping and record a clean shutdown. */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.beat('stopped');
  }
}

/**
 * Check whether a PID refers to a live process (signal 0 probe).
 *
 * @param {number} pid
 * @returns {boolean}
 */
export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means "alive but not ours" — still alive.
    return error.code === 'EPERM';
  }
}

export default Heartbeat;
