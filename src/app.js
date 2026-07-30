/**
 * app.js — Launcher / composition root.
 *
 * The only place in the codebase where concrete components are constructed
 * and wired together. Everything below this layer receives its dependencies
 * by injection, which is what keeps the modules loosely coupled and testable.
 *
 * Startup sequence:
 *   1. Load configuration (JSON) and resolve paths.
 *   2. Inspect the previous heartbeat:
 *        - another live orchestrator?     → refuse to double-launch
 *        - stale "running" heartbeat?     → unclean shutdown (reboot/power
 *          loss) → automatic recovery of the interrupted session
 *   3. Build state managers, drivers, orchestrator, integrations.
 *   4. Supervise until mission completion or operator stop.
 *   5. Shut down cleanly (final status, heartbeat "stopped", API closed).
 *
 * Phase 12 M1 adds ONE alternative shape: WORKER MODE (`new App({ worker:
 * true })`, reached via `start --worker`, which only the Core Service passes).
 * A worker supervises exactly as it always has — same Orchestrator, same
 * P0–P11 guarantees — but withdraws the four responsibilities that can only
 * belong to one process per machine, because the daemon now owns them:
 *
 *   global heartbeat  → the daemon's own record + a per-project worker record
 *   HTTP API (:4711)  → the daemon's server
 *   Telegram inbound  → the daemon's exclusive poll (see approvalManager.js)
 *   stop-request file → per-worker SIGTERM / IPC, so stopping one mission
 *                       does not stop every other mission on the machine
 *
 * With `worker` unset — every pre-Phase-12 caller — nothing below changes.
 */

import fs from 'node:fs';
import path from 'node:path';
import ConfigManager from './config/configManager.js';
import { createLogger, childLogger } from './infra/logger.js';
import { resolvePaths, ensureRuntimeDirs } from './infra/paths.js';
import SessionManager from './state/sessionManager.js';
import StatusManager from './state/statusManager.js';
import MissionTimeline from './state/missionTimeline.js';
import TaskQueue from './mission/taskQueue.js';
import MissionLifecycle from './mission/missionLifecycle.js';
import MemoryStore from './memory/memoryStore.js';
import AgentRegistry from './agents/agentRegistry.js';
import AgentHealth from './agents/agentHealth.js';
import Heartbeat from './state/heartbeat.js';
import DriverRegistry from './drivers/driverRegistry.js';
import Orchestrator from './core/orchestrator.js';
import NotificationEngine from './notifications/notificationEngine.js';
import NotificationState from './notifications/notificationState.js';
import PluginManager from './plugins/pluginManager.js';
import DashboardServer from './api/dashboardServer.js';
import { loadOrCreateToken } from './api/apiAuth.js';
import ApprovalStore from './approvals/approvalStore.js';
import ApprovalManager from './approvals/approvalManager.js';
import TelegramApprovalProvider from './approvals/providers/telegramProvider.js';
import EmailApprovalProvider from './approvals/providers/emailProvider.js';
import ResourceLockManager from './coordination/resourceLocks.js';
import AgentMessageBus from './coordination/agentMessages.js';
import WorkerRegistry from './daemon/workerRegistry.js';
import { readJsonSafe } from './state/statePersistence.js';
import { isPidAlive } from './state/heartbeat.js';
import { userFacingError } from './infra/errors.js';

/** Cadence for checking the CLI stop-request file while supervising. */
const STOP_FILE_POLL_MS = 5_000;

/** Name of the file `ai-orchestrator stop` drops to request a shutdown. */
export const STOP_REQUEST_FILENAME = 'stop.requested';

export class App {
  /**
   * @param {object} [options]
   * @param {string} [options.rootDir] - Override installation root (tests).
   * @param {boolean} [options.worker] - Phase 12 M1: run as a supervised
   *   mission worker under the Core Service (see the file header).
   */
  constructor(options = {}) {
    this.configManager = new ConfigManager(options);
    this.config = this.configManager.getAll();
    this.paths = this.configManager.getPaths();
    ensureRuntimeDirs(this.paths);

    /** Phase 12 M1: worker mode (see the file header). Default false. */
    this.workerMode = Boolean(options.worker);

    this.logger = createLogger({
      ...this.config.logging,
      directory: this.paths.logsDir,
    });

    this.heartbeat = new Heartbeat({
      heartbeatFile: this.paths.heartbeatFile,
      logger: childLogger(this.logger, 'heartbeat'),
      intervalMs: this.config.supervision.heartbeatIntervalMs,
    });

    this.statusManager = new StatusManager({
      statusFile: this.paths.statusFile,
      logger: childLogger(this.logger, 'status'),
      updateIntervalMs: this.config.supervision.statusUpdateIntervalMs,
    });

    this.sessionManager = new SessionManager({
      sessionsDir: this.paths.sessionsDir,
      logger: childLogger(this.logger, 'sessions'),
    });

    this.driverRegistry = new DriverRegistry({
      logger: this.logger,
      // Phase 13 M5: reads THIS process's own config snapshot (loaded once,
      // above, at construction — a worker never reloads it) — so a change
      // the daemon applies mid-mission is invisible to an already-running
      // worker by construction, and a NEW worker (the next mission) picks
      // it up automatically just by starting after the change landed.
      defaultModelProvider: () => this.config.operator?.defaultModel || '',
      // Reconciliation pass, 2026-07-30: same "worker's own config snapshot,
      // read once at construction" isolation `defaultModelProvider` already
      // documents above — `/safemode` toggles the daemon's live object, an
      // in-flight worker never rereads it.
      safeModeProvider: () => Boolean(this.config.operator?.safeMode),
      // Same isolation guarantee again: this worker's own config snapshot,
      // read once here — never re-read mid-mission. The real apiKey lives
      // in config/local.json, merged in by ConfigManager.load() already.
      nvidiaConfigProvider: () => this.config.nvidia ?? {},
    });

    // Phase 10A/10C: the Approval Manager — store + remote providers.
    this.approvalStore = new ApprovalStore({
      approvalsDir: this.paths.approvalsDir,
      logger: childLogger(this.logger, 'approvals'),
    });
    this.approvalManager = new ApprovalManager({
      config: this.config.approvals,
      store: this.approvalStore,
      providers: this.buildApprovalProviders(),
      logger: childLogger(this.logger, 'approvals'),
      // Phase 12 M1: inbound polling has exactly one owner per machine. A
      // worker publishes its requests but never consumes Telegram updates —
      // the daemon does that and writes decisions to the shared store, which
      // waitForDecision() already re-reads every iteration.
      receiveDecisions: !this.workerMode,
    });

    // Phase 10D: the mission lifecycle recorder.
    this.lifecycle = new MissionLifecycle({
      lifecycleDir: this.paths.lifecycleDir,
      logger: childLogger(this.logger, 'lifecycle'),
    });
    this.lifecycle.attachApprovals(this.approvalManager);

    // Phase 10H: cross-mission resource locks + cross-agent message bus.
    this.resourceLocks = new ResourceLockManager({
      coordinationDir: this.paths.coordinationDir,
      logger: childLogger(this.logger, 'coordination'),
      staleMs: this.config.coordination?.staleLockMs,
    });
    this.messageBus = new AgentMessageBus({
      coordinationDir: this.paths.coordinationDir,
      logger: childLogger(this.logger, 'coordination'),
    });

    this.orchestrator = new Orchestrator({
      configManager: this.configManager,
      driverRegistry: this.driverRegistry,
      sessionManager: this.sessionManager,
      statusManager: this.statusManager,
      paths: this.paths,
      logger: childLogger(this.logger, 'orchestrator'),
      approvalManager: this.approvalManager,
      lifecycle: this.lifecycle,
      resourceLocks: this.resourceLocks,
      messageBus: this.messageBus,
    });
    // Phase 10H: every orchestrator supervising a mission this process runs
    // (parallel missions each get their own instance — see start()).
    this.orchestrators = [this.orchestrator];

    this.notificationState = new NotificationState({
      notificationsDir: this.paths.notificationsDir,
      logger: childLogger(this.logger, 'notifications'),
    });
    this.notifications = new NotificationEngine({
      config: this.config.notifications,
      logger: childLogger(this.logger, 'notifications'),
      notificationState: this.notificationState,
      // Phase 11 M2: lets the engine auto-skip approval events on a channel
      // whose own two-way provider (approvals.providers.telegram/email) is
      // already delivering them — otherwise one approval sends two
      // near-identical messages to the same chat/mailbox.
      approvalsConfig: this.config.approvals,
      // Phase 13 M7: the mission-complete footer points at /files/download
      // commands ONLY a live Core Service can actually answer — this process
      // has no CommandRouter of its own (see module header: "ai-orchestrator
      // start never consults [the operator] block"). `workerMode` is exactly
      // "was this process forked by the daemon that owns one," so it stands
      // in for "is the operator interface actually there to answer this" —
      // reusing existing plumbing (`--worker`/`this.workerMode`), not new
      // architecture. A bare interactive `start` (no daemon) suppresses the
      // footer rather than pointing the owner at a command nothing answers.
      operatorConfig: this.workerMode ? this.config.operator : { enabled: false },
    });
    this.notifications.attach(this.orchestrator);
    this.notifications.attach(this.approvalManager); // Phase 10A events

    this.timeline = new MissionTimeline({
      timelineDir: this.paths.timelineDir,
      logger: childLogger(this.logger, 'timeline'),
    });
    this.timeline.attach(this.orchestrator);
    this.timeline.attachApprovals(this.approvalManager);

    // Read-only view for the dashboard API; the orchestrator owns its own
    // TaskQueue instance for actually driving mission-mode supervision.
    // The lifecycle recorder is shared so the API's operator overrides
    // (approve/skip) keep the lifecycle record in sync.
    this.taskQueue = new TaskQueue({
      tasksDir: this.paths.tasksDir,
      logger: childLogger(this.logger, 'tasks'),
      lifecycle: this.lifecycle,
    });

    // Read-only view for the dashboard API; the orchestrator owns its own
    // MemoryStore instance (see Orchestrator's constructor).
    this.memoryStore = new MemoryStore({
      memoryDir: this.paths.memoryDir,
      logger: childLogger(this.logger, 'memory'),
    });

    // Phase 9: read-only views for the dashboard API. The orchestrator owns
    // its own AgentRegistry/AgentHealth instances for actually routing runs.
    this.agentRegistry = new AgentRegistry({
      driverRegistry: this.driverRegistry,
      logger: childLogger(this.logger, 'agents'),
      agentsFile: this.paths.agentsFile,
    });
    this.agentHealth = new AgentHealth({
      healthFile: this.paths.agentHealthFile,
      logger: childLogger(this.logger, 'agents'),
    });

    this.pluginManager = new PluginManager({
      pluginsDir: this.paths.pluginsDir,
      logger: childLogger(this.logger, 'plugins'),
    });

    // Phase P7: local token gating the dashboard API's mutating endpoints
    // (generated once, persisted at state/api-token.txt). Read-only
    // endpoints are unauthenticated, as they always have been.
    this.apiToken = loadOrCreateToken(this.paths.apiTokenFile);

    this.dashboard = new DashboardServer({
      config: this.config.api,
      logger: childLogger(this.logger, 'api'),
      statusManager: this.statusManager,
      sessionManager: this.sessionManager,
      configManager: this.configManager,
      timeline: this.timeline,
      taskQueue: this.taskQueue,
      memoryStore: this.memoryStore,
      agentRegistry: this.agentRegistry,
      agentHealth: this.agentHealth,
      configManagerForAgents: this.configManager,
      orchestrator: this.orchestrator,
      apiToken: this.apiToken,
      // Phase 10 surfaces.
      approvalStore: this.approvalStore,
      approvalManager: this.approvalManager,
      lifecycle: this.lifecycle,
      resourceLocks: this.resourceLocks,
      messageBus: this.messageBus,
      paths: this.paths,
      stopAll: (reason) => this.stopAll(reason),
    });

    this.stopFilePath = path.join(this.paths.stateDir, STOP_REQUEST_FILENAME);
    this.stopFileTimer = null;
    this.shuttingDown = false;

    // Phase 12 M1: in worker mode the project — not the machine — is the unit
    // of ownership, so this registry replaces the global heartbeat lock.
    this.workerRegistry = new WorkerRegistry({
      workersDir: this.paths.workersDir,
      logger: childLogger(this.logger, 'worker'),
    });
    this.registeredProject = null;
  }

  /**
   * Phase 12 M1 (worker mode): claim this project, refusing if anything else
   * already supervises it. Two supervisors on one project would interleave
   * session records, progress signatures, and task-queue writes — the exact
   * corruption the machine-wide heartbeat lock used to prevent bluntly.
   *
   * @param {string} project
   * @returns {string|undefined} 'worker-crash' when the previous worker for
   *   this project died without cleanup (the per-project equivalent of the
   *   standalone path's stale-heartbeat detection).
   */
  claimProjectAsWorker(project) {
    const holder = this.workerRegistry.holderOf(project);
    if (holder) {
      throw userFacingError({
        cause: `Project "${project}" is already supervised by worker pid ${holder.pid}.`,
        impact: 'Two supervisors on one project would corrupt its session and task state.',
        fix: `stop the running mission first: "ai-orchestrator stop ${project}".`,
      });
    }
    const standalone = readJsonSafe(this.paths.heartbeatFile, { logger: this.logger });
    if (standalone?.state === 'running' && isPidAlive(standalone.pid)) {
      throw userFacingError({
        cause: `A standalone orchestrator (pid ${standalone.pid}) is already supervising this machine.`,
        impact: 'It owns the API port and the inbound approval channel, which the Core Service must own exclusively.',
        fix: 'stop it with "ai-orchestrator stop", then start the mission through the service again.',
      });
    }

    // A leftover "running" record with a dead pid means the previous worker
    // for THIS project was killed or lost power mid-mission.
    const stale = this.workerRegistry.read(project);
    const recoveredAfter = stale?.state === 'running' ? 'worker-crash' : undefined;
    if (recoveredAfter) {
      this.logger.warn('Previous worker for this project did not exit cleanly', {
        project, previousPid: stale.pid, lastUpdate: stale.updatedAt,
      });
    }

    this.workerRegistry.register(project, {
      pid: process.pid,
      daemonPid: Number(process.env.AI_ORCHESTRATOR_DAEMON_PID) || null,
      mode: 'worker',
    });
    this.registeredProject = project;
    return recoveredAfter;
  }

  /**
   * Phase 12 M1 (worker mode): accept control messages from the daemon over
   * the IPC channel `child_process.fork` provides. IPC is an OPTIMIZATION for
   * latency, never the system of record — a worker started without a channel
   * (or one whose daemon died) still stops correctly via SIGTERM.
   */
  installWorkerChannel() {
    if (typeof process.send !== 'function') return;
    this.workerMessageHandler = (message) => {
      if (message?.type === 'stop') {
        this.logger.info('Stop requested by the Core Service', { reason: message.reason });
        this.stopAll(message.reason ?? 'daemon stop');
      }
    };
    process.on('message', this.workerMessageHandler);
  }

  /**
   * Close the IPC channel so a finished worker can actually leave.
   *
   * A forked child with an open IPC channel has a live libuv handle, so its
   * event loop never drains and the process runs forever — mission complete,
   * session archived, worker record released, and still resident. Phase 12 M2's
   * live validation caught exactly that: a mission finished cleanly and its
   * process was still there minutes later, holding memory and never reporting
   * an exit, which also meant the daemon's `worker.completed` event never fired.
   *
   * It went unnoticed through M1's own live pass because the worker observed
   * there exited on an ERROR path (exit code 1) — a throwing process terminates
   * regardless of open handles. Only a mission that succeeds reaches this code,
   * which is precisely the case a crash-focused validation never exercises.
   */
  closeWorkerChannel() {
    if (this.workerMessageHandler) {
      process.off('message', this.workerMessageHandler);
      this.workerMessageHandler = null;
    }
    if (process.connected && typeof process.disconnect === 'function') {
      try {
        process.disconnect();
      } catch (error) {
        // Already gone (the daemon died first) — nothing to release.
        this.logger.debug?.('IPC channel was already closed', { error: error.message });
      }
    }
  }

  /**
   * Phase 12 M1 (worker mode): watch this worker's OWN stop-request file.
   *
   * The machine-global `stop.requested` file cannot serve here — it would stop
   * every mission on the machine at once. And a cross-process SIGTERM is not a
   * graceful stop on Windows at all (it is TerminateProcess, which would kill
   * the mission instead of archiving a resumable session), so this file is the
   * only mechanism that keeps "stop" meaning "stop gracefully" everywhere.
   */
  watchWorkerStopFile(project) {
    // Never inherit a stop request left behind by a previous mission.
    this.workerRegistry.clearStop(project);
    this.stopFileTimer = setInterval(() => {
      const request = this.workerRegistry.readStopRequest(project);
      if (!request) return;
      this.workerRegistry.clearStop(project);
      this.logger.info('Stop requested by the Core Service', { reason: request.reason });
      this.stopAll(request.reason ?? 'daemon stop');
    }, STOP_FILE_POLL_MS);
    this.stopFileTimer.unref();
  }

  /** Phase 12 M1 (worker mode): best-effort progress report to the daemon. */
  notifyDaemon(type, payload = {}) {
    if (typeof process.send !== 'function') return;
    try {
      process.send({ type, ...payload });
    } catch {
      // The daemon went away; files remain the source of truth.
    }
  }

  /**
   * Phase 10C: construct the enabled approval providers. Provider config
   * falls back to the matching notification channel's settings when its own
   * fields are blank — one bot/mailbox serves both systems by default.
   */
  buildApprovalProviders() {
    const providers = [];
    const providerConfig = this.config.approvals?.providers ?? {};
    const logger = childLogger(this.logger, 'approvals');

    if (providerConfig.telegram?.enabled) {
      const fallback = this.config.notifications?.telegram ?? {};
      providers.push(new TelegramApprovalProvider({
        config: {
          botToken: providerConfig.telegram.botToken || fallback.botToken,
          chatId: providerConfig.telegram.chatId || fallback.chatId,
        },
        logger,
        offsetFile: path.join(this.paths.approvalsDir, 'telegram.offset'),
      }));
    }
    if (providerConfig.email?.enabled) {
      const fallback = this.config.notifications?.email ?? {};
      providers.push(new EmailApprovalProvider({
        config: {
          smtp: Object.keys(providerConfig.email.smtp ?? {}).length
            ? providerConfig.email.smtp
            : fallback.smtp,
          from: providerConfig.email.from || fallback.from,
          to: providerConfig.email.to || fallback.to,
        },
        logger,
      }));
    }
    return providers;
  }

  /** Stop every orchestrator this process is supervising (Phase 10H). */
  async stopAll(reason) {
    await Promise.allSettled(this.orchestrators.map((o) => o.stop(reason)));
  }

  /**
   * Run supervision for a project until done.
   *
   * @param {object} params
   * @param {string} [params.projectName] - Project to supervise. Falls back
   *   to config `defaultProject`, then to the single defined project.
   * @param {string[]} [params.projectNames] - Phase 10H: several projects to
   *   supervise IN PARALLEL, each on its own Orchestrator instance. The
   *   first is the primary (owns status.json); the rest write per-project
   *   snapshots under state/status/. Capped by coordination.maxParallelMissions.
   * @param {boolean} [params.onlyIfResumable] - `resume` mode: exit quietly
   *   when nothing was interrupted (used by the Task Scheduler boot task).
   * @param {boolean} [params.fresh] - Abandon any interrupted session and
   *   start the mission from the beginning (explicit operator choice).
   * @returns {Promise<{complete: boolean, reason: string}|null>}
   */
  async start({ projectName, projectNames, onlyIfResumable = false, fresh = false } = {}) {
    const requested = [...new Set(projectNames ?? [])];
    if (requested.length > 1) {
      return this.startParallel({ projectNames: requested, fresh });
    }
    if (requested.length === 1) projectName = requested[0];
    return this.startSingle({ projectName, onlyIfResumable, fresh });
  }

  /** The single-mission path — everything before Phase 10H, unchanged. */
  async startSingle({ projectName, onlyIfResumable = false, fresh = false } = {}) {
    // Phase 12 M1: a worker never touches the machine-wide heartbeat lock —
    // that lock is what made simultaneous projects impossible. It claims the
    // PROJECT instead (claimProjectAsWorker, below, after the name resolves).
    const previous = this.workerMode
      ? { kind: 'clean', previous: null }
      : this.heartbeat.inspectPrevious();
    if (previous.kind === 'already-running') {
      throw new Error(
        `Another AI-Orchestrator instance is already running (pid ${previous.previous.pid}). ` +
        'Use "ai-orchestrator status" to inspect it or "ai-orchestrator stop" to stop it.'
      );
    }
    let recoveredAfter =
      previous.kind === 'unclean-shutdown' ? 'reboot-or-power-loss' : undefined;

    // Phase 12 M1: standalone start must also refuse a project the Core
    // Service is already supervising — the other half of the mutual exclusion
    // claimProjectAsWorker() enforces. With no daemon running the registry is
    // empty, so this costs a directory read and changes nothing.
    if (!this.workerMode) {
      const requestedName = this.resolveProjectName(projectName, previous.previous);
      const holder = requestedName ? this.workerRegistry.holderOf(requestedName) : null;
      if (holder) {
        throw userFacingError({
          cause: `Project "${requestedName}" is already supervised by the Core Service (worker pid ${holder.pid}).`,
          impact: 'Two supervisors on one project would corrupt its session and task state, so this start was refused.',
          fix: `inspect it with "ai-orchestrator daemon status", or stop that mission with "ai-orchestrator stop ${requestedName}".`,
        });
      }
    }

    const resolved = this.resolveProjectName(projectName, previous.previous);
    if (!resolved) {
      if (onlyIfResumable) {
        this.logger.info('Nothing to resume; exiting quietly (resume mode)');
        return null;
      }
      throw new Error(
        'No project specified and no default configured. ' +
        'Run "ai-orchestrator start <project>" or set "defaultProject" in config/orchestrator.json.'
      );
    }

    if (onlyIfResumable && !this.sessionManager.getResumableSession(resolved)) {
      this.logger.info('No interrupted session for project; exiting quietly', {
        project: resolved,
      });
      return null;
    }

    if (fresh) {
      const interrupted = this.sessionManager.getResumableSession(resolved);
      if (interrupted) {
        this.logger.warn('--fresh: archiving interrupted session and starting over', {
          project: resolved,
          sessionId: interrupted.id,
        });
        this.sessionManager.closeSession(interrupted, 'stopped');
      }
    }

    // Phase 12 M1: claim the project (worker mode) before any supervision
    // starts, so a conflict fails fast and without side effects.
    if (this.workerMode) {
      recoveredAfter = this.claimProjectAsWorker(resolved) ?? recoveredAfter;
    }

    if (recoveredAfter) {
      this.logger.warn('Recovering after unclean shutdown', { project: resolved });
      this.orchestrator.emit('orchestrator:recovered-after-reboot', {
        project: resolved,
      });
    }

    // Bring the platform up around the orchestrator.
    if (this.config.plugins?.enabled !== false) {
      await this.pluginManager.loadAll({
        orchestrator: this.orchestrator,
        driverRegistry: this.driverRegistry,
        config: this.config,
        logger: this.logger,
      });
    } else {
      this.logger.info('Plugin system disabled by configuration');
    }
    // In worker mode the daemon owns the API port and the machine heartbeat,
    // and stop requests arrive per-worker (SIGTERM/IPC) rather than through
    // the machine-global stop file.
    if (this.workerMode) {
      this.installSignalHandlers();
      this.installWorkerChannel();
      this.watchWorkerStopFile(resolved);
    } else {
      await this.dashboard.start();
      this.heartbeat.start({ project: resolved });
      this.installSignalHandlers();
      this.watchStopFile();
    }
    this.statusManager.startUpdates();

    this.logger.info(this.workerMode ? 'Mission worker started' : 'AI-Orchestrator started', {
      project: resolved,
      pid: process.pid,
    });
    this.notifyDaemon('worker:started', { project: resolved, pid: process.pid });

    try {
      const result = await this.orchestrator.runProject(resolved, { recoveredAfter });
      this.notifyDaemon('worker:finished', { project: resolved, result });
      return result;
    } finally {
      await this.shutdown();
    }
  }

  /**
   * Phase 10H: supervise several projects IN PARALLEL in one process —
   * true parallel mission execution by composition: each project gets its
   * own untouched Orchestrator instance (all the P0–P9 guarantees intact
   * per mission), while resource locks (`task.resources`) synchronize the
   * missions wherever they declare shared resources.
   *
   * The first project is the primary: it owns status.json and the main
   * orchestrator instance. Additional missions write their status to
   * `state/status/<project>.json`.
   *
   * @param {object} params
   * @param {string[]} params.projectNames
   * @param {boolean} [params.fresh]
   * @returns {Promise<{project: string, complete: boolean, reason: string}[]>}
   */
  async startParallel({ projectNames, fresh = false }) {
    const cap = this.config.coordination?.maxParallelMissions ?? 3;
    if (projectNames.length > cap) {
      throw new Error(
        `Refusing to start ${projectNames.length} parallel missions ` +
        `(coordination.maxParallelMissions is ${cap}). Raise the cap or start fewer.`
      );
    }
    // Validate every project (and warn on shared working directories —
    // parallel agents in one workspace confuse per-project progress
    // signatures) BEFORE touching any session state.
    const seenDirs = new Map();
    for (const name of projectNames) {
      const project = this.configManager.getProject(name);
      const dir = path.resolve(project.workingDirectory);
      if (seenDirs.has(dir)) {
        this.logger.warn('Two parallel missions share a working directory', {
          projects: [seenDirs.get(dir), name], directory: dir,
        });
      }
      seenDirs.set(dir, name);
    }

    // Same double-launch guard as a single start.
    const previous = this.heartbeat.inspectPrevious();
    if (previous.kind === 'already-running') {
      throw new Error(
        `Another AI-Orchestrator instance is already running (pid ${previous.previous.pid}).`
      );
    }

    if (fresh) {
      for (const name of projectNames) {
        const interrupted = this.sessionManager.getResumableSession(name);
        if (interrupted) this.sessionManager.closeSession(interrupted, 'stopped');
      }
    }

    // The primary keeps this.orchestrator/statusManager; each additional
    // mission gets its own Orchestrator + StatusManager (per-project
    // status snapshot), with the same engines attached.
    const missions = [{ project: projectNames[0], orchestrator: this.orchestrator }];
    for (const name of projectNames.slice(1)) {
      const statusManager = new StatusManager({
        statusFile: path.join(this.paths.statusDir, `${name}.json`),
        logger: childLogger(this.logger, 'status'),
        updateIntervalMs: this.config.supervision.statusUpdateIntervalMs,
      });
      const orchestrator = new Orchestrator({
        configManager: this.configManager,
        driverRegistry: this.driverRegistry,
        sessionManager: this.sessionManager,
        statusManager,
        paths: this.paths,
        logger: childLogger(this.logger, `orchestrator:${name}`),
        approvalManager: this.approvalManager,
        lifecycle: this.lifecycle,
        resourceLocks: this.resourceLocks,
        messageBus: this.messageBus,
      });
      this.notifications.attach(orchestrator);
      this.timeline.attach(orchestrator);
      this.orchestrators.push(orchestrator);
      missions.push({ project: name, orchestrator, statusManager });
    }

    if (this.config.plugins?.enabled !== false) {
      await this.pluginManager.loadAll({
        orchestrator: this.orchestrator, // plugins attach to the primary
        driverRegistry: this.driverRegistry,
        config: this.config,
        logger: this.logger,
      });
    }
    await this.dashboard.start();
    this.statusManager.startUpdates();
    for (const mission of missions.slice(1)) mission.statusManager.startUpdates();
    this.heartbeat.start({ project: projectNames[0], projects: projectNames });
    this.installSignalHandlers();
    this.watchStopFile();

    this.logger.info('AI-Orchestrator started (parallel missions)', {
      projects: projectNames, pid: process.pid,
    });

    try {
      const settled = await Promise.allSettled(
        missions.map(({ project, orchestrator }) => orchestrator.runProject(project))
      );
      return settled.map((outcome, i) => ({
        project: missions[i].project,
        ...(outcome.status === 'fulfilled'
          ? { complete: outcome.value.complete, reason: outcome.value.reason }
          : { complete: false, reason: `supervision error: ${outcome.reason?.message}` }),
      }));
    } finally {
      for (const mission of missions.slice(1)) mission.statusManager.stopUpdates();
      await this.shutdown();
    }
  }

  /**
   * Pick the project to supervise:
   * explicit argument > previous heartbeat (recovery) > configured default >
   * the only defined project.
   */
  resolveProjectName(projectName, previousHeartbeat) {
    if (projectName) return projectName;
    if (previousHeartbeat?.project) return previousHeartbeat.project;
    if (this.config.defaultProject) return this.config.defaultProject;
    const projects = this.configManager.listProjects();
    return projects.length === 1 ? projects[0] : null;
  }

  /** Graceful shutdown on Ctrl+C / service stop. */
  installSignalHandlers() {
    const stop = (signal) => {
      this.logger.info(`Received ${signal}; stopping gracefully`);
      // Fire and forget: runProject unwinds and start()'s finally cleans up.
      this.stopAll(`signal ${signal}`);
    };
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
      process.on(signal, stop);
    }

    process.on('uncaughtException', (error) => {
      // Log with full detail; state is already on disk (every transition is
      // persisted), so the next start resumes exactly where we died.
      this.logger.error('Uncaught exception — shutting down', {
        error: error.message,
        stack: error.stack,
      });
      this.shutdown('uncaught-exception').finally(() => process.exit(1));
    });
    process.on('unhandledRejection', (reason) => {
      this.logger.error('Unhandled rejection — shutting down', {
        reason: reason instanceof Error ? reason.stack : String(reason),
      });
      this.shutdown('unhandled-rejection').finally(() => process.exit(1));
    });
  }

  /** Poll for the stop file dropped by `ai-orchestrator stop`. */
  watchStopFile() {
    this.stopFileTimer = setInterval(() => {
      if (fs.existsSync(this.stopFilePath)) {
        fs.rmSync(this.stopFilePath, { force: true });
        this.logger.info('Stop requested via CLI stop file');
        this.stopAll('cli stop command');
      }
    }, STOP_FILE_POLL_MS);
    this.stopFileTimer.unref();
  }

  /** Tear everything down exactly once. */
  async shutdown(finalState = 'stopped') {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    if (this.stopFileTimer) clearInterval(this.stopFileTimer);
    await this.stopAll('shutdown');
    await this.pluginManager.shutdownAll();
    this.statusManager.stopUpdates(finalState);

    if (this.workerMode) {
      // A worker must never write the machine heartbeat: that file is the
      // standalone orchestrator's lock, and stamping it here would advertise a
      // machine-wide state this process was never entitled to describe.
      // Releasing the project claim is the worker's equivalent.
      if (this.registeredProject) {
        this.workerRegistry.unregister(this.registeredProject);
        this.registeredProject = null;
      }
      // Last, and load-bearing: an open IPC channel keeps this process alive
      // forever after a SUCCESSFUL mission (see closeWorkerChannel).
      this.closeWorkerChannel();
      this.logger.info('Mission worker shut down cleanly');
      return;
    }

    await this.dashboard.stop();
    this.heartbeat.stop();
    this.logger.info('AI-Orchestrator shut down cleanly');
  }
}

export default App;
