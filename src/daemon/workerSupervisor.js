/**
 * workerSupervisor.js — Phase 12 M1: mission worker lifecycle.
 *
 * The daemon never runs a mission in its own process. A mission is a long,
 * hostile thing to host: it drives an external AI CLI, it can hang, it can
 * exhaust memory, and — most importantly — an uncaught error inside it would
 * take down the service that the phone, the desktop, and the scheduler all
 * depend on. So every mission is a CHILD PROCESS running the same
 * `bin/ai-orchestrator.js start <project>` a human would run, with `--worker`
 * added so it withdraws the machine-singleton duties (see src/app.js).
 *
 * Two rules govern everything here:
 *
 *  1. FILES ARE THE SOURCE OF TRUTH. The IPC channel gives low-latency events
 *     and a clean stop path, but it is never what the system believes. A
 *     daemon that restarts re-derives reality from the worker registry
 *     (adoptExisting) and keeps supervising missions it did not spawn.
 *  2. ONE SUPERVISOR PER PROJECT. Enforced here (before spawning) and again
 *     inside the worker itself (App.claimProjectAsWorker), because a check
 *     that only exists in the caller is a check that a crash can skip.
 */

import path from 'node:path';
import { fork } from 'node:child_process';
import { isPidAlive } from '../state/heartbeat.js';
import { readJsonSafe } from '../state/statePersistence.js';
import { ROOT_DIR } from '../infra/paths.js';

/** How long a stopped worker gets to exit gracefully before SIGKILL. */
export const GRACEFUL_STOP_MS = 20_000;

export class WorkerSupervisor {
  /**
   * @param {object} options
   * @param {import('./workerRegistry.js').WorkerRegistry} options.registry
   * @param {object} options.config - The `daemon` config block.
   * @param {object} options.logger
   * @param {object} options.paths - Resolved runtime paths.
   * @param {string} [options.binPath] - Override the CLI entry (tests).
   * @param {Function} [options.forkFn] - Injectable child_process.fork (tests).
   */
  constructor({ registry, config, logger, paths, binPath, forkFn }) {
    this.registry = registry;
    this.config = config ?? {};
    this.logger = logger;
    this.paths = paths;
    this.binPath = binPath ?? path.join(ROOT_DIR, 'bin', 'ai-orchestrator.js');
    this.forkFn = forkFn ?? fork;
    /** project -> { child, project, startedAt } for workers WE spawned. */
    this.children = new Map();
    this.listeners = new Set();
  }

  /** Subscribe to worker events ({type, project, ...}). */
  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger.warn('Worker event listener failed', { error: error.message });
      }
    }
  }

  /** Max concurrent workers (config `daemon.maxWorkers`). */
  get maxWorkers() {
    return this.config.maxWorkers ?? 3;
  }

  /**
   * Every worker the daemon knows about: those it spawned plus any it adopted
   * or that outlived a previous daemon. Registry records are authoritative.
   */
  list() {
    return this.registry.listAlive().map((record) => ({
      project: record.project,
      pid: record.pid,
      startedAt: record.startedAt,
      state: record.state,
      /** False ⇒ running but not a child of this daemon (adopted/orphaned). */
      attached: this.children.has(record.project),
    }));
  }

  /** Is this project currently supervised by anyone? */
  holderOf(project) {
    return this.registry.holderOf(project);
  }

  /**
   * Whether a standalone (pre-Phase-12) orchestrator owns the machine right
   * now. The daemon must not start workers alongside one: that process holds
   * the API port and polls Telegram itself, so both halves of the exclusive
   * ownership contract would be violated at once.
   */
  standaloneHolder() {
    const heartbeat = readJsonSafe(this.paths.heartbeatFile, { logger: this.logger });
    if (heartbeat?.state === 'running' && heartbeat.pid && isPidAlive(heartbeat.pid)) {
      return heartbeat;
    }
    return null;
  }

  /**
   * Start supervising a project.
   *
   * @param {string} project
   * @param {object} [options]
   * @param {boolean} [options.fresh] - Abandon an interrupted session first.
   * @returns {{ok: boolean, reason?: string, pid?: number, project?: string}}
   */
  start(project, { fresh = false } = {}) {
    const existing = this.holderOf(project);
    if (existing) {
      return {
        ok: false,
        reason: `Project "${project}" is already being supervised (pid ${existing.pid}).`,
      };
    }
    const standalone = this.standaloneHolder();
    if (standalone) {
      return {
        ok: false,
        reason:
          `A standalone orchestrator (pid ${standalone.pid}) is supervising this machine. ` +
          'Stop it with "ai-orchestrator stop" before the Core Service can start missions.',
      };
    }
    const running = this.list().length;
    if (running >= this.maxWorkers) {
      return {
        ok: false,
        reason:
          `Already supervising ${running} missions (daemon.maxWorkers is ${this.maxWorkers}). ` +
          'Raise the cap or stop a mission first.',
      };
    }

    const args = ['start', project, '--worker'];
    if (fresh) args.push('--fresh');

    let child;
    try {
      child = this.forkFn(this.binPath, args, {
        cwd: this.paths.root ?? ROOT_DIR,
        // DETACHED IS LOAD-BEARING, not tidiness. Live validation of this
        // milestone proved that a plain (attached) fork dies with the daemon
        // on Windows: killing the service took both mission workers with it,
        // which would mean every service restart — including an upgrade or a
        // crash — destroys hours of unattended work. Detaching gives the
        // worker its own process group so it outlives its supervisor, and the
        // worker registry is what lets the next daemon find it again.
        //
        // This is the same conclusion the desktop reached in Phase 8 for the
        // same reason (see desktop/main/orchestratorBridge.js: detached so an
        // overnight mission survives the window closing).
        detached: true,
        // 'ignore' for stdio + 'ipc': the worker's observability is its
        // winston log files. Piping would need a reader for the life of a
        // child that outlives us, and an unread pipe can fill and block the
        // worker's own log writes.
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: {
          ...process.env,
          AI_ORCHESTRATOR_DAEMON_PID: String(process.pid),
        },
      });
      // Do not let a supervised mission keep the service's event loop alive;
      // the IPC channel and exit handler keep working regardless.
      child.unref?.();
    } catch (error) {
      return { ok: false, reason: `Could not start worker: ${error.message}` };
    }

    this.children.set(project, { child, project, startedAt: new Date().toISOString() });
    this.attachChildHandlers(project, child);

    this.logger.info('Mission worker started', { project, pid: child.pid });
    this.emit({ type: 'worker:started', project, pid: child.pid });
    return { ok: true, project, pid: child.pid };
  }

  /** Wire IPC + exit handling for a worker we spawned. */
  attachChildHandlers(project, child) {
    child.on('message', (message) => {
      if (!message?.type) return;
      this.emit({ ...message, project });
    });

    child.on('error', (error) => {
      this.logger.warn('Mission worker error', { project, error: error.message });
      this.emit({ type: 'worker:error', project, error: error.message });
    });

    child.once('exit', (code, signal) => {
      this.children.delete(project);
      // The worker unregisters itself on a clean shutdown; if it died hard,
      // the record is stale and must be cleared so the project is startable
      // again rather than permanently "held" by a process that no longer exists.
      const record = this.registry.read(project);
      const crashed = Boolean(record && record.state === 'running');
      if (crashed) this.registry.unregister(project);

      this.logger[crashed ? 'warn' : 'info']('Mission worker exited', {
        project, code, signal, crashed,
      });
      this.emit({ type: 'worker:exited', project, code, signal, crashed });
    });
  }

  /**
   * Stop one worker gracefully. Prefers IPC (the worker unwinds its mission
   * and archives a resumable session), then SIGTERM for workers this daemon
   * did not spawn, then SIGKILL as a last resort after a grace period.
   *
   * @param {string} project
   * @param {object} [options]
   * @param {string} [options.reason]
   * @param {number} [options.graceMs]
   * @returns {{ok: boolean, reason?: string, via?: string}}
   */
  stop(project, { reason = 'daemon stop', graceMs = GRACEFUL_STOP_MS } = {}) {
    const tracked = this.children.get(project);
    const record = this.holderOf(project);
    if (!tracked && !record) {
      return { ok: false, reason: `No mission is running for "${project}".` };
    }

    let via;
    if (tracked?.child?.connected) {
      try {
        tracked.child.send({ type: 'stop', reason });
        via = 'ipc';
      } catch {
        via = undefined;
      }
    }
    if (!via) {
      // Adopted worker, or a dead IPC channel. NOT a signal: on Windows a
      // cross-process SIGTERM is TerminateProcess, which would kill the
      // mission instead of letting it archive a resumable session (found in
      // this milestone's live validation). The stop-request file is the
      // graceful path on every platform — see WorkerRegistry.stopFileFor.
      if (!this.registry.requestStop(project, reason)) {
        return { ok: false, reason: `Could not write a stop request for "${project}".` };
      }
      via = 'stop-file';
    }

    if (graceMs > 0) {
      // Escalation, not the primary mechanism: a worker that ignores a
      // graceful stop is hung, and a hung mission must not block the project
      // forever. The grace window is generous enough for an agent process to
      // exit and the session to be archived first.
      const timer = setTimeout(() => {
        const pid = tracked?.child?.pid ?? record?.pid;
        if (pid && isPidAlive(pid)) {
          this.logger.warn('Worker ignored graceful stop; forcing termination', { project, pid });
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // Already gone between the probe and the kill — nothing to do.
          }
          this.registry.clearStop(project);
        }
      }, graceMs);
      timer.unref();
    }

    this.logger.info('Stop requested for mission worker', { project, via, reason });
    return { ok: true, via };
  }

  /** Stop every worker (daemon shutdown). */
  stopAll(reason = 'daemon shutdown') {
    const results = [];
    for (const { project } of this.list()) {
      results.push({ project, ...this.stop(project, { reason }) });
    }
    return results;
  }

  /**
   * Re-derive state from disk at daemon boot:
   *  - workers still alive are ADOPTED (kept running, tracked by pid — a
   *    mission must not be killed just because its supervisor restarted);
   *  - records whose process is gone are reaped and reported as crashes.
   *
   * @returns {{adopted: object[], reaped: object[]}}
   */
  adoptExisting() {
    const adopted = this.registry.listAlive().map((record) => ({
      project: record.project, pid: record.pid, startedAt: record.startedAt,
    }));
    const reaped = this.registry.reapStale();

    for (const worker of adopted) {
      this.logger.info('Adopted a mission worker that outlived the previous daemon', worker);
      this.emit({ type: 'worker:adopted', ...worker });
    }
    for (const record of reaped) {
      this.logger.warn('Cleared the record of a worker that died without shutting down', {
        project: record.project, pid: record.pid, lastUpdate: record.updatedAt,
      });
      this.emit({ type: 'worker:crashed', project: record.project, pid: record.pid });
    }
    return { adopted, reaped };
  }
}

export default WorkerSupervisor;
