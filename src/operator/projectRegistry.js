/**
 * projectRegistry.js — Phase 12 M2: the daemon's answer to "what have I got?"
 *
 * The directive is explicit that the daemon is the source of truth for the
 * project list, and that every project must carry name, description, path,
 * status, current worker, last activity, branch, latest commit and health.
 * This module assembles exactly that, from evidence the system already holds:
 *
 *   name / description / path   config/projects/<name>.json
 *   status                      worker registry + heartbeat + lifecycle + queue
 *   worker                      state/workers/<name>.json
 *   lastActivity                lifecycle, timeline, session, worker records
 *   branch / commit             the real git work tree (never guessed)
 *   health                      Phase 10E ProjectIntelligence
 *   tasks                       state/tasks/<name>.json
 *
 * NOTHING here is invented. Every optional collaborator may be absent and the
 * corresponding field is simply omitted — a registry that reports "unknown" is
 * more useful than one that reports a confident fiction, and this project has
 * a standing rule against the latter (see missionCard.js on 'unverified').
 *
 * READ-ONLY by decree, like ProjectIntelligence: this module reports. Starting,
 * stopping, and changing anything belongs to the command router.
 */

import fs from 'node:fs';
import { gitBranch, gitHead, gitHeadSubject, gitDirty } from '../progress/progressEngine.js';
import { isPidAlive } from '../state/heartbeat.js';
import { readJsonSafe } from '../state/statePersistence.js';
import { TaskState } from '../mission/taskState.js';
import { isSimulatedProject } from '../drivers/simulation.js';

/**
 * Every status a project can report, IN THE ORDER THE LIST SORTS BY — which
 * is the order of the operator's attention, not alphabetical and not
 * lifecycle order. A phone shows about six lines before scrolling, so the
 * first line has to be the one worth reading:
 *
 *   waiting-approval  one tap from you unblocks it
 *   blocked           stuck, and needs a decision at the machine
 *   running           working; nothing for you to do
 *   queued            work is waiting to start
 *   idle              nothing happening
 *   misconfigured     broken, but not urgent — it was never running
 *
 * The directive names running / idle / blocked / queued. `waiting-approval` is
 * added because it is a genuinely different situation with a different remedy:
 * a mission parked on YOUR decision is not blocked (nothing is wrong) and is
 * not running (nothing is progressing). Collapsing it into either would hide
 * the single most actionable state a remote operator can be in.
 */
export const PROJECT_STATUSES = Object.freeze([
  'waiting-approval', 'blocked', 'running', 'queued', 'idle', 'misconfigured',
]);

/** How long git facts are reused before re-shelling out (per project). */
export const GIT_CACHE_MS = 30_000;

export class ProjectRegistry {
  /**
   * @param {object} deps
   * @param {import('../config/configManager.js').ConfigManager} deps.configManager
   * @param {import('../daemon/workerRegistry.js').WorkerRegistry} deps.workerRegistry
   * @param {import('../mission/taskQueue.js').TaskQueue} [deps.taskQueue]
   * @param {import('../mission/missionLifecycle.js').MissionLifecycle} [deps.lifecycle]
   * @param {import('../approvals/approvalStore.js').ApprovalStore} [deps.approvalStore]
   * @param {import('../state/sessionManager.js').SessionManager} [deps.sessionManager]
   * @param {import('../state/missionTimeline.js').MissionTimeline} [deps.timeline]
   * @param {() => object|null} [deps.buildIntelligence] - Lazily builds the
   *   Phase 10E analyzer. A function rather than an instance because health
   *   scoring is comparatively expensive and only some callers want it.
   * @param {string} [deps.heartbeatFile] - Detects a STANDALONE orchestrator,
   *   which is still a completely legitimate way to run a project and must
   *   therefore show as 'running' rather than as nothing at all.
   * @param {object} deps.logger
   */
  constructor({
    configManager, workerRegistry, taskQueue, lifecycle, approvalStore,
    sessionManager, timeline, buildIntelligence, heartbeatFile, logger,
  }) {
    this.configManager = configManager;
    this.workerRegistry = workerRegistry;
    this.taskQueue = taskQueue;
    this.lifecycle = lifecycle;
    this.approvalStore = approvalStore;
    this.sessionManager = sessionManager;
    this.timeline = timeline;
    this.buildIntelligence = buildIntelligence;
    this.heartbeatFile = heartbeatFile;
    this.logger = logger;
    this.gitCache = new Map();
  }

  /** Every defined project name. */
  names() {
    return this.configManager.listProjects();
  }

  /** Whether a project is defined (used before acting on an operator command). */
  has(name) {
    return this.names().includes(name);
  }

  /**
   * The names of every project whose engine is a fixture.
   *
   * Exists so a surface that renders things BELONGING to projects — approvals,
   * mission requests — can disclose simulation without describing each project
   * in full (`describe()` does git and health work no list needs) and without
   * depending on whatever `simulated` flag happened to be frozen into a stored
   * record. The config is the live truth: flipping a project to the `claude`
   * driver must stop the badge appearing on its already-queued approvals.
   *
   * A project whose config cannot be loaded is deliberately NOT reported as
   * simulated — "broken" and "pretend" are different answers, and guessing
   * between them is how a real project quietly acquires a fixture badge.
   *
   * @returns {Set<string>}
   */
  simulatedNames() {
    const simulated = new Set();
    for (const name of this.names()) {
      try {
        if (isSimulatedProject(this.configManager.getProject(name))) simulated.add(name);
      } catch {
        // Reported as 'misconfigured' by describe(); not this method's business.
      }
    }
    return simulated;
  }

  /**
   * Resolve an operator-typed project name to a real one.
   *
   * Phones make exact typing expensive, so this accepts a case-insensitive
   * match and an unambiguous prefix/substring — but NEVER guesses between two
   * candidates. An ambiguous name returns every match so the caller can ask,
   * rather than silently acting on the wrong project.
   *
   * @param {string} input
   * @returns {{match: string|null, candidates: string[]}}
   */
  resolveName(input) {
    const names = this.names();
    const needle = String(input ?? '').trim().toLowerCase();
    if (!needle) return { match: null, candidates: [] };

    const exact = names.find((n) => n.toLowerCase() === needle);
    if (exact) return { match: exact, candidates: [exact] };

    const prefix = names.filter((n) => n.toLowerCase().startsWith(needle));
    if (prefix.length === 1) return { match: prefix[0], candidates: prefix };
    if (prefix.length > 1) return { match: null, candidates: prefix };

    const contains = names.filter((n) => n.toLowerCase().includes(needle));
    if (contains.length === 1) return { match: contains[0], candidates: contains };
    return { match: null, candidates: contains };
  }

  /**
   * The full record for one project.
   *
   * @param {string} name
   * @param {{health?: boolean, git?: boolean}} [options] - Both default true;
   *   turn them off for the cheap listing path.
   * @returns {object}
   */
  describe(name, { health = true, git = true } = {}) {
    const record = { name };

    let project = null;
    try {
      project = this.configManager.getProject(name);
      record.description = project.description || null;
      record.path = project.workingDirectory;
      record.driver = project.driver;
      record.enabled = project.enabled !== false;
      // Carried on EVERY record, not just where it is currently rendered: M3's
      // desktop client reads this same registry, and a fact this important
      // must not depend on each surface remembering to look up the driver.
      record.simulated = isSimulatedProject(project);
    } catch (error) {
      // A project whose config is broken still EXISTS and must still be
      // listed — silently dropping it is how an operator ends up staring at a
      // list wondering where their project went.
      record.status = 'misconfigured';
      record.problem = error.message;
      return record;
    }

    const worker = this.workerRegistry.holderOf(name);
    if (worker) {
      record.worker = {
        pid: worker.pid,
        startedAt: worker.startedAt,
        mode: worker.mode ?? 'worker',
        daemonPid: worker.daemonPid ?? null,
      };
    } else {
      const standalone = this.standaloneHolderOf(name);
      if (standalone) {
        record.worker = { pid: standalone.pid, startedAt: standalone.startedAt ?? null, mode: 'standalone' };
      }
    }

    const lifecycle = this.lifecycle?.get(name) ?? null;
    if (lifecycle?.state) {
      record.lifecycle = lifecycle.state;
      record.lifecycleSince = lifecycle.updatedAt ?? null;
    }

    const queue = this.taskQueue?.load(name) ?? null;
    if (queue) {
      const done = queue.tasks.filter((t) => t.state === TaskState.DONE).length;
      record.tasks = {
        done,
        total: queue.tasks.length,
        current: queue.tasks[queue.currentIndex]?.id ?? null,
        currentState: queue.tasks[queue.currentIndex]?.state ?? null,
        pending: queue.tasks.filter((t) => t.state === TaskState.PENDING).length,
      };
    }

    const pending = this.approvalStore?.pending(name) ?? [];
    if (pending.length) {
      record.pendingApprovals = pending.map((r) => ({
        id: r.id, title: r.title, category: r.category, approvalClass: r.approvalClass,
      }));
    }

    record.status = this.statusOf({ worker: record.worker, lifecycle, queue, pending });

    const lastActivity = this.lastActivityOf(name, { lifecycle, worker });
    if (lastActivity) record.lastActivity = lastActivity;

    if (git && record.path) {
      const info = this.gitInfo(record.path);
      if (info) record.git = info;
    }

    if (health) {
      const scored = this.healthOf(name);
      if (scored) record.health = scored;
    }

    return record;
  }

  /**
   * Every project, ordered so the ones that need attention come first — a
   * phone screen shows about six lines before scrolling, and the projects that
   * are running or waiting on the owner are the ones worth those lines.
   *
   * @param {{health?: boolean, git?: boolean}} [options]
   * @returns {object[]}
   */
  list(options = {}) {
    const order = new Map(PROJECT_STATUSES.map((status, index) => [status, index]));
    return this.names()
      .map((name) => this.describe(name, options))
      .sort((a, b) => {
        const rank = (order.get(a.status) ?? 99) - (order.get(b.status) ?? 99);
        return rank !== 0 ? rank : a.name.localeCompare(b.name);
      });
  }

  /**
   * Derive a status from evidence, in priority order. The order matters: a
   * running mission that also has a pending approval is 'waiting-approval',
   * because that is the fact the operator can act on.
   */
  statusOf({ worker, lifecycle, queue, pending }) {
    if (pending?.length) return 'waiting-approval';
    if (lifecycle?.state === 'approval-pending') return 'waiting-approval';
    if (worker) return 'running';
    if (lifecycle?.state === 'blocked' || lifecycle?.state === 'failed') return 'blocked';
    const current = queue?.tasks?.[queue.currentIndex] ?? null;
    if (current && (current.state === TaskState.BLOCKED || current.state === TaskState.FAILED)) {
      return 'blocked';
    }
    if (current) return 'queued'; // real, unstarted work is waiting
    return 'idle';
  }

  /**
   * The most recent moment anything actually happened for this project, across
   * every store that records time. Returns an ISO string, or null when the
   * project has genuinely never run.
   */
  lastActivityOf(name, { lifecycle, worker } = {}) {
    const candidates = [
      lifecycle?.updatedAt,
      worker?.startedAt,
      this.sessionManager?.getActiveSession(name)?.updatedAt,
      this.timeline?.read(name)?.at(-1)?.at,
    ];
    let latest = null;
    for (const candidate of candidates) {
      if (!candidate) continue;
      const time = Date.parse(candidate);
      if (!Number.isFinite(time)) continue;
      if (latest === null || time > latest) latest = time;
    }
    return latest === null ? null : new Date(latest).toISOString();
  }

  /**
   * A pre-Phase-12 standalone orchestrator supervising this project. Its
   * heartbeat is machine-wide (that is exactly the constraint M1 removed), so
   * it holds at most one project at a time.
   */
  standaloneHolderOf(name) {
    if (!this.heartbeatFile || !fs.existsSync(this.heartbeatFile)) return null;
    const heartbeat = readJsonSafe(this.heartbeatFile, { logger: this.logger });
    if (heartbeat?.state !== 'running' || !heartbeat.pid || !isPidAlive(heartbeat.pid)) return null;
    return heartbeat.project === name ? heartbeat : null;
  }

  /** Real git facts for a working directory, cached briefly. Null when not a repo. */
  gitInfo(dir) {
    const cached = this.gitCache.get(dir);
    if (cached && Date.now() - cached.at < GIT_CACHE_MS) return cached.info;

    const commit = gitHead(dir);
    const info = commit
      ? {
        branch: gitBranch(dir),
        commit: commit.slice(0, 12),
        subject: gitHeadSubject(dir),
        dirty: gitDirty(dir),
      }
      : null;
    this.gitCache.set(dir, { at: Date.now(), info });
    return info;
  }

  /** Phase 10E health, or null when the analyzer is unavailable/errors. */
  healthOf(name) {
    if (!this.buildIntelligence) return null;
    try {
      const intelligence = this.buildIntelligence();
      if (!intelligence) return null;
      const analysis = intelligence.analyze(name);
      return analysis?.health ?? null;
    } catch (error) {
      this.logger?.warn('Could not score project health', { project: name, error: error.message });
      return null;
    }
  }
}

export default ProjectRegistry;
