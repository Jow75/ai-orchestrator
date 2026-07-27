/**
 * workerRegistry.js — Phase 12 M1: who is supervising which project.
 *
 * The Phase 12 evidence pass established (E1) that `state/heartbeat.json` is a
 * MACHINE-wide single-instance lock: one orchestrator, period. That is exactly
 * why "start Calculator while Remote Work runs" was impossible — the lock's
 * granularity was the machine, not the project.
 *
 * This registry re-grains ownership to the project. One JSON record per
 * supervised project under `state/workers/`, each carrying the PID of the
 * worker process that owns it. Liveness is the same signal-0 PID probe the
 * heartbeat has always used, so a record left behind by a killed worker is
 * detectable rather than permanently poisonous.
 *
 * The registry is intentionally dumb: it records and reports. Deciding whether
 * a worker may start (caps, conflicts with a standalone orchestrator) belongs
 * to workerSupervisor.js.
 *
 * FILES ARE THE SOURCE OF TRUTH. The daemon also holds workers in memory with
 * live IPC channels, but a daemon restart loses that memory and not the facts —
 * re-adoption reads these records back (see WorkerSupervisor.adoptExisting).
 */

import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic, readJsonSafe } from '../state/statePersistence.js';
import { isPidAlive } from '../state/heartbeat.js';

/** A project name that is safe to use as a file name. */
function recordName(project) {
  return `${String(project).replace(/[^A-Za-z0-9._-]/g, '_')}.json`;
}

export class WorkerRegistry {
  /**
   * @param {object} options
   * @param {string} options.workersDir - state/workers.
   * @param {object} options.logger
   */
  constructor({ workersDir, logger }) {
    this.workersDir = workersDir;
    this.logger = logger;
  }

  /** Absolute path of one project's worker record. */
  fileFor(project) {
    return path.join(this.workersDir, recordName(project));
  }

  /**
   * Absolute path of one project's stop-request file.
   *
   * WHY A FILE AND NOT A SIGNAL. On Windows, `process.kill(pid, 'SIGTERM')`
   * against ANOTHER process is not a catchable signal at all — it maps to
   * TerminateProcess, killing the target instantly. Live validation of this
   * milestone caught exactly that: stopping an adopted worker killed it
   * mid-mission while the CLI cheerfully reported "the session stays
   * resumable". It did not.
   *
   * A stop-request file is the mechanism `ai-orchestrator stop` has used since
   * P0 for the same reason, and it works for a worker this daemon never
   * spawned (no IPC channel) on every platform.
   */
  stopFileFor(project) {
    return path.join(this.workersDir, `${recordName(project).replace(/\.json$/, '')}.stop`);
  }

  /** Ask the worker supervising `project` to stop gracefully. */
  requestStop(project, reason = 'stop requested') {
    try {
      fs.mkdirSync(this.workersDir, { recursive: true });
      fs.writeFileSync(
        this.stopFileFor(project),
        JSON.stringify({ reason, requestedAt: new Date().toISOString() }),
        'utf8'
      );
      return true;
    } catch (error) {
      this.logger.warn('Could not write stop request', { project, error: error.message });
      return false;
    }
  }

  /** The pending stop request for a project, or null. */
  readStopRequest(project) {
    const file = this.stopFileFor(project);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return { reason: 'stop requested' };
    }
  }

  /** Remove a stop request (consumed by the worker, or abandoned). */
  clearStop(project) {
    try {
      fs.rmSync(this.stopFileFor(project), { force: true });
    } catch {
      // Nothing actionable — a stale stop file is re-cleared on next start.
    }
  }

  /**
   * Record that `project` is now supervised by `pid`.
   *
   * @param {string} project
   * @param {object} details - { pid, daemonPid, startedAt, mode, ... }
   * @returns {object} The written record.
   */
  register(project, details = {}) {
    const record = {
      project,
      state: 'running',
      startedAt: new Date().toISOString(),
      ...details,
      updatedAt: new Date().toISOString(),
    };
    try {
      writeJsonAtomic(this.fileFor(project), record);
    } catch (error) {
      this.logger.warn('Could not write worker record', { project, error: error.message });
    }
    return record;
  }

  /** Merge fields into an existing record (no-op if it is gone). */
  update(project, patch = {}) {
    const existing = this.read(project);
    if (!existing) return null;
    const record = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    try {
      writeJsonAtomic(this.fileFor(project), record);
    } catch (error) {
      this.logger.warn('Could not update worker record', { project, error: error.message });
    }
    return record;
  }

  /** Raw record for one project, or null. */
  read(project) {
    return readJsonSafe(this.fileFor(project), { logger: this.logger });
  }

  /** Remove a project's record entirely (clean worker exit). */
  unregister(project) {
    try {
      fs.rmSync(this.fileFor(project), { force: true });
    } catch (error) {
      this.logger.warn('Could not remove worker record', { project, error: error.message });
    }
    // A stop request outlives the worker it was meant for otherwise, and would
    // stop the NEXT mission on this project the instant it starts.
    this.clearStop(project);
  }

  /**
   * Every record on disk, annotated with live/dead.
   *
   * @returns {Array<object & {alive: boolean}>}
   */
  list() {
    if (!fs.existsSync(this.workersDir)) return [];
    const files = fs.readdirSync(this.workersDir).filter((f) => f.endsWith('.json'));
    const records = [];
    for (const file of files) {
      const record = readJsonSafe(path.join(this.workersDir, file), { logger: this.logger });
      if (!record?.project) continue;
      records.push({
        ...record,
        alive: record.state === 'running' && Boolean(record.pid) && isPidAlive(record.pid),
      });
    }
    return records.sort((a, b) => a.project.localeCompare(b.project));
  }

  /** Only the records whose process is actually alive. */
  listAlive() {
    return this.list().filter((record) => record.alive);
  }

  /**
   * The live worker currently supervising `project`, or null.
   * This is the check that stops two processes fighting over one project.
   */
  holderOf(project) {
    const record = this.read(project);
    if (!record || record.state !== 'running') return null;
    if (!record.pid || !isPidAlive(record.pid)) return null;
    return record;
  }

  /**
   * Delete records whose process is gone. Returns the reaped records so the
   * caller can log/notify — a worker that vanished without unregistering
   * crashed, and that is worth surfacing rather than silently tidying away.
   *
   * @returns {object[]}
   */
  reapStale() {
    const reaped = [];
    for (const record of this.list()) {
      if (record.alive) continue;
      if (record.state === 'running') reaped.push(record);
      this.unregister(record.project);
    }
    return reaped;
  }
}

export default WorkerRegistry;
