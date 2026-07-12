/**
 * resourceLocks.js — Phase 10H: cross-mission resource locking.
 *
 * Tasks may declare `resources: ["database", "shared-lib", ...]` — opaque
 * names for anything two missions must not touch at once. Locks are global
 * (one file at `state/coordination/locks.json`, atomic writes) because
 * their whole purpose is synchronizing ACROSS parallel missions running in
 * one process (Phase 10H's `start a b c`) — or across future distributed
 * workers sharing the state directory.
 *
 * Safety properties:
 *   - all-or-nothing: a task acquires every resource it declares or none.
 *   - stale reclaim: a lock whose holding process is dead (pid gone) or
 *     older than `staleMs` is reclaimable — a crash never wedges the fleet.
 *   - release is idempotent and holder-scoped: a mission can only release
 *     its own locks.
 */

import path from 'node:path';
import { writeJsonAtomic, readJsonSafe } from '../state/statePersistence.js';
import { isPidAlive } from '../state/heartbeat.js';

/** Default reclaim age for a lock held by a live-looking process. */
const DEFAULT_STALE_MS = 3_600_000; // 1 hour

export class ResourceLockManager {
  /**
   * @param {object} options
   * @param {string} [options.coordinationDir] - Absent ⇒ safe no-op mode
   *   (acquire always succeeds; nothing persists) for pre-P10 harnesses.
   * @param {object} options.logger
   * @param {number} [options.staleMs]
   */
  constructor({ coordinationDir, logger, staleMs = DEFAULT_STALE_MS }) {
    this.coordinationDir = coordinationDir;
    this.logger = logger;
    this.staleMs = staleMs;
  }

  file() {
    return path.join(this.coordinationDir, 'locks.json');
  }

  load() {
    if (!this.coordinationDir) return { locks: {} };
    return readJsonSafe(this.file(), { logger: this.logger }) ?? { locks: {} };
  }

  save(state) {
    if (!this.coordinationDir) return;
    try {
      writeJsonAtomic(this.file(), state);
    } catch (error) {
      this.logger.warn('Failed to persist resource locks', { error: error.message });
    }
  }

  /** Whether an existing lock may be reclaimed (holder dead or too old). */
  isStale(lock) {
    if (lock.holder?.pid && !isPidAlive(lock.holder.pid)) return true;
    return Date.now() - new Date(lock.at).getTime() > this.staleMs;
  }

  /**
   * Try to acquire every named resource for one holder (all-or-nothing).
   *
   * @param {string[]} resources
   * @param {{project: string, taskId?: string, sessionId?: string, pid?: number}} holder
   * @returns {{ok: boolean, conflicts?: {resource: string, heldBy: object}[]}}
   */
  acquireAll(resources, holder) {
    if (!resources?.length || !this.coordinationDir) return { ok: true };
    const state = this.load();

    const conflicts = [];
    for (const resource of resources) {
      const lock = state.locks[resource];
      if (!lock) continue;
      const sameHolder = lock.holder?.project === holder.project
        && (lock.holder?.taskId ?? null) === (holder.taskId ?? null);
      if (sameHolder) continue; // re-acquire after a retry/restart is fine
      if (this.isStale(lock)) {
        this.logger.warn('Reclaiming stale resource lock', {
          resource, previousHolder: lock.holder,
        });
        delete state.locks[resource];
        continue;
      }
      conflicts.push({ resource, heldBy: lock.holder });
    }
    if (conflicts.length) return { ok: false, conflicts };

    const at = new Date().toISOString();
    for (const resource of resources) {
      state.locks[resource] = { holder: { ...holder, pid: holder.pid ?? process.pid }, at };
    }
    this.save(state);
    this.logger.info('Resources locked', { resources, project: holder.project, taskId: holder.taskId });
    return { ok: true };
  }

  /**
   * Release locks held by a holder. With `taskId` only that task's locks;
   * without it, everything the project holds (mission end / shutdown).
   *
   * @param {{project: string, taskId?: string}} holder
   * @returns {string[]} The released resource names.
   */
  releaseAll({ project, taskId }) {
    if (!this.coordinationDir) return [];
    const state = this.load();
    const released = [];
    for (const [resource, lock] of Object.entries(state.locks)) {
      if (lock.holder?.project !== project) continue;
      if (taskId !== undefined && lock.holder?.taskId !== taskId) continue;
      delete state.locks[resource];
      released.push(resource);
    }
    if (released.length) {
      this.save(state);
      this.logger.info('Resources released', { resources: released, project, taskId });
    }
    return released;
  }

  /** Every currently-held lock, for the coordination CLI/API view. */
  held() {
    const state = this.load();
    return Object.entries(state.locks).map(([resource, lock]) => ({
      resource,
      holder: lock.holder,
      at: lock.at,
      stale: this.isStale(lock),
    }));
  }
}

export default ResourceLockManager;
