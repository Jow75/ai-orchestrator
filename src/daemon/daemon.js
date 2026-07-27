/**
 * daemon.js — Phase 12 M1: the AI-Orchestrator Core Service.
 *
 * This is the composition root for the always-running process, the way
 * src/app.js is the composition root for a single supervised mission. It owns
 * the four things that can only have one owner per machine, and nothing else:
 *
 *   1. The HTTP API (:4711) — so the desktop and CLI have something to talk to
 *      whether or not a mission happens to be running (before Phase 12 the API
 *      lived inside the mission process and vanished with it).
 *   2. The EXCLUSIVE Telegram inbound poll — getUpdates is offset-acknowledged,
 *      so a second poller silently destroys the first one's messages. See the
 *      ApprovalManager constructor for the full reasoning; the daemon is the
 *      one process in the system that sets receiveDecisions: true when workers
 *      are in play.
 *   3. The scheduler tick — due missions now start as supervised workers
 *      instead of detached top-level processes.
 *   4. Mission worker lifecycle — spawning, adopting, stopping (see
 *      workerSupervisor.js).
 *
 * What it deliberately does NOT own:
 *
 *   - Running missions. Never in-process: an uncaught error inside a mission
 *     would take down the phone, the desktop and the scheduler at once.
 *   - Mission-level notifications. Workers still emit their own mission and
 *     approval notifications exactly as they always have. If the daemon also
 *     announced them, every event would arrive twice — the precise duplicate
 *     class Phase 11 M2 spent a milestone eliminating. Consolidating
 *     notification routing into the service belongs with M2's Mission Card
 *     work, where the sending side is being rewritten anyway.
 */

import os from 'node:os';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import path from 'node:path';

import ConfigManager from '../config/configManager.js';
import { createLogger, childLogger } from '../infra/logger.js';
import { ensureRuntimeDirs } from '../infra/paths.js';
import { VERSION } from '../infra/version.js';
import { loadOrCreateToken } from '../api/apiAuth.js';
import { userFacingError } from '../infra/errors.js';
import DashboardServer from '../api/dashboardServer.js';
import StatusManager from '../state/statusManager.js';
import SessionManager from '../state/sessionManager.js';
import MissionTimeline from '../state/missionTimeline.js';
import TaskQueue from '../mission/taskQueue.js';
import MissionLifecycle from '../mission/missionLifecycle.js';
import MemoryStore from '../memory/memoryStore.js';
import AgentRegistry from '../agents/agentRegistry.js';
import AgentHealth from '../agents/agentHealth.js';
import DriverRegistry from '../drivers/driverRegistry.js';
import ApprovalStore from '../approvals/approvalStore.js';
import ApprovalManager from '../approvals/approvalManager.js';
import TelegramApprovalProvider from '../approvals/providers/telegramProvider.js';
import EmailApprovalProvider from '../approvals/providers/emailProvider.js';
import ResourceLockManager from '../coordination/resourceLocks.js';
import AgentMessageBus from '../coordination/agentMessages.js';
import NotificationEngine from '../notifications/notificationEngine.js';
import MissionScheduler from '../scheduler/missionScheduler.js';
import { buildActivitySummary } from '../scheduler/activitySummary.js';
import { ProgressLedger } from '../progress/progressLedger.js';

import DaemonRecord from './daemonRecord.js';
import WorkerRegistry from './workerRegistry.js';
import WorkerSupervisor from './workerSupervisor.js';

/** The file `ai-orchestrator daemon stop` drops to request a clean shutdown. */
export const DAEMON_STOP_FILENAME = 'daemon.stop';

export class Daemon extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {string} [options.rootDir] - Override installation root (tests).
   * @param {Function} [options.forkFn] - Injectable child spawner (tests).
   */
  constructor(options = {}) {
    super();
    this.configManager = new ConfigManager(options);
    this.config = this.configManager.getAll();
    this.paths = this.configManager.getPaths();
    ensureRuntimeDirs(this.paths);

    this.daemonConfig = this.config.daemon ?? {};
    this.logger = createLogger({
      ...this.config.logging,
      directory: this.paths.logsDir,
    });

    this.record = new DaemonRecord({
      daemonFile: this.paths.daemonFile,
      logger: childLogger(this.logger, 'daemon'),
    });

    this.workerRegistry = new WorkerRegistry({
      workersDir: this.paths.workersDir,
      logger: childLogger(this.logger, 'daemon'),
    });
    this.supervisor = new WorkerSupervisor({
      registry: this.workerRegistry,
      config: this.daemonConfig,
      logger: childLogger(this.logger, 'daemon'),
      paths: this.paths,
      forkFn: options.forkFn,
    });
    this.supervisor.onEvent((event) => this.emit('worker', event));

    // --- the exclusive inbound approval channel -------------------------
    this.approvalStore = new ApprovalStore({
      approvalsDir: this.paths.approvalsDir,
      logger: childLogger(this.logger, 'approvals'),
    });
    this.approvalManager = new ApprovalManager({
      config: this.config.approvals,
      store: this.approvalStore,
      providers: this.buildApprovalProviders(),
      logger: childLogger(this.logger, 'approvals'),
      receiveDecisions: true, // the whole point of the service
    });

    // --- read models the API serves while idle --------------------------
    this.statusManager = new StatusManager({
      statusFile: this.paths.statusFile,
      logger: childLogger(this.logger, 'status'),
      updateIntervalMs: this.config.supervision.statusUpdateIntervalMs,
    });
    this.sessionManager = new SessionManager({
      sessionsDir: this.paths.sessionsDir,
      logger: childLogger(this.logger, 'sessions'),
    });
    this.timeline = new MissionTimeline({
      timelineDir: this.paths.timelineDir,
      logger: childLogger(this.logger, 'timeline'),
    });
    this.lifecycle = new MissionLifecycle({
      lifecycleDir: this.paths.lifecycleDir,
      logger: childLogger(this.logger, 'lifecycle'),
    });
    this.taskQueue = new TaskQueue({
      tasksDir: this.paths.tasksDir,
      logger: childLogger(this.logger, 'tasks'),
      lifecycle: this.lifecycle,
    });
    this.memoryStore = new MemoryStore({
      memoryDir: this.paths.memoryDir,
      logger: childLogger(this.logger, 'memory'),
    });
    this.driverRegistry = new DriverRegistry({ logger: this.logger });
    this.agentRegistry = new AgentRegistry({
      driverRegistry: this.driverRegistry,
      logger: childLogger(this.logger, 'agents'),
      agentsFile: this.paths.agentsFile,
    });
    this.agentHealth = new AgentHealth({
      healthFile: this.paths.agentHealthFile,
      logger: childLogger(this.logger, 'agents'),
    });
    this.resourceLocks = new ResourceLockManager({
      coordinationDir: this.paths.coordinationDir,
      logger: childLogger(this.logger, 'coordination'),
      staleMs: this.config.coordination?.staleLockMs,
    });
    this.messageBus = new AgentMessageBus({
      coordinationDir: this.paths.coordinationDir,
      logger: childLogger(this.logger, 'coordination'),
    });

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
      apiToken: this.apiToken,
      approvalStore: this.approvalStore,
      approvalManager: this.approvalManager,
      lifecycle: this.lifecycle,
      resourceLocks: this.resourceLocks,
      messageBus: this.messageBus,
      paths: this.paths,
      // Phase 12 M1: the optional daemon collaborator. Absent (a standalone
      // mission's own server) ⇒ the daemon routes 503 cleanly, exactly like
      // every other optional Phase 10 surface.
      daemon: this,
    });

    this.scheduler = this.buildScheduler();

    this.pollTimer = null;
    this.schedulerTimer = null;
    this.scanTimer = null;
    this.stopFileTimer = null;
    this.stopFilePath = path.join(this.paths.stateDir, DAEMON_STOP_FILENAME);
    this.startedAt = null;
    this.shuttingDown = false;
    this.stopWorkersOnShutdown = false;
  }

  /**
   * The scheduler, wired so due missions become SUPERVISED WORKERS rather than
   * detached top-level processes.
   *
   * `heartbeatFile` is deliberately omitted: orchestratorBusy() exists to stop
   * a schedule launching a second machine-wide orchestrator, and under the
   * service that constraint is both wrong (several projects may run at once)
   * and redundant (the supervisor enforces per-project exclusion and the
   * worker cap itself).
   */
  buildScheduler() {
    const notifications = new NotificationEngine({
      config: this.config.notifications,
      logger: childLogger(this.logger, 'notifications'),
    });
    const ledger = new ProgressLedger({
      ledgerDir: this.paths.ledgerDir,
      logger: childLogger(this.logger, 'progress'),
    });
    const scheduler = new MissionScheduler({
      schedulesFile: this.paths.schedulesFile,
      stateFile: this.paths.schedulesStateFile,
      rootDir: this.paths.root,
      logger: childLogger(this.logger, 'scheduler'),
      notifications,
      spawnFn: ({ project, fresh }) => {
        const result = this.supervisor.start(project, { fresh });
        if (!result.ok) throw new Error(result.reason);
        return result;
      },
      buildSummary: ({ sinceMs, now }) => buildActivitySummary({
        listProjects: () => this.configManager.listProjects(),
        readTimeline: (p) => this.timeline.read(p),
        recentLedger: (p, n) => ledger.recent(p, n),
        pendingApprovals: () => this.approvalStore.pendingAll(),
      }, { sinceMs, now }),
    });
    scheduler.configureSummaries(this.config.notifications?.summaries);
    return scheduler;
  }

  /**
   * Build the receiving approval providers. Identical wiring to App's, because
   * it must stay identical: the daemon has to parse exactly the grammar
   * workers publish (`APPROVE A7`, `DONE A7`, …). M1 adds no new inbound
   * command surface at all — that is M2's scope, deliberately gated behind its
   * own security review.
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

  /** Whether any two-way provider is configured (drives the poll loop). */
  get canReceive() {
    return this.approvalManager.providers.some((provider) => provider.canReceive);
  }

  /**
   * The port the API is actually listening on, falling back to the configured
   * one when the server is unavailable (api.enabled:false, or a bind failure —
   * DashboardServer degrades gracefully rather than taking the service down).
   */
  boundPort() {
    return this.dashboard.server?.address()?.port ?? this.config.api?.port ?? 4711;
  }

  // ------------------------------------------------------------ lifecycle --

  /**
   * Boot the service. Resolves once everything is up; the process then stays
   * alive on its timers and HTTP server until stop() is called.
   *
   * @returns {Promise<{pid: number, port: number, adopted: object[]}>}
   */
  async start() {
    if (this.daemonConfig.enabled === false) {
      throw userFacingError({
        cause: 'The Core Service is disabled by configuration (daemon.enabled is false).',
        impact: 'Nothing will be listening for remote commands, scheduled missions, or desktop connections.',
        fix: 'set "daemon": { "enabled": true } in config/orchestrator.json, then run "ai-orchestrator serve" again.',
      });
    }

    const previous = this.record.inspectPrevious();
    if (previous.kind === 'already-running') {
      throw userFacingError({
        cause: `The Core Service is already running (pid ${previous.previous.pid}).`,
        impact: 'Only one service may own the API port and the inbound approval channel.',
        fix: 'inspect it with "ai-orchestrator daemon status", or stop it with "ai-orchestrator daemon stop".',
      });
    }
    if (previous.kind === 'unclean-shutdown') {
      this.logger.warn('Recovering after an unclean Core Service shutdown', {
        previousPid: previous.previous.pid,
      });
    }

    // Re-derive worker reality from disk BEFORE accepting any request, so the
    // first /api/daemon call already reflects adopted missions.
    const { adopted, reaped } = this.supervisor.adoptExisting();

    await this.dashboard.start();
    this.startedAt = new Date();
    // Record the port actually BOUND, not the one requested. They differ when
    // the config asks for an ephemeral port, and — more importantly for real
    // operation — a client that trusts this record must never be sent to a
    // port nothing is listening on.
    this.record.start({ port: this.boundPort(), workers: adopted.length });
    this.installSignalHandlers();
    this.watchStopFile();
    this.startPollLoop();
    this.startSchedulerLoop();
    this.startWorkerScan();

    this.logger.info('AI-Orchestrator Core Service started', {
      pid: process.pid,
      version: VERSION,
      port: this.boundPort(),
      adoptedWorkers: adopted.length,
      reapedWorkers: reaped.length,
      telegramInbound: this.canReceive,
    });
    this.emit('started', { pid: process.pid, adopted });
    return { pid: process.pid, port: this.boundPort(), adopted };
  }

  /**
   * The exclusive inbound approval poll. This is the loop that makes remote
   * approval work when NO mission is waiting in-process — and, because the
   * worker's own receiveDecisions is false, the only loop consuming Telegram
   * updates on this machine.
   */
  startPollLoop() {
    if (!this.canReceive) {
      this.logger.info('No two-way approval provider configured; inbound polling disabled');
      return;
    }
    const intervalMs = this.daemonConfig.pollIntervalMs ?? 10_000;
    const tick = async () => {
      try {
        const resolved = await this.approvalManager.pollProvidersOnce();
        for (const request of resolved) {
          this.logger.info('Remote decision applied by the Core Service', {
            project: request.project, id: request.id, status: request.status,
          });
          this.emit('approval:resolved', request);
        }
      } catch (error) {
        this.logger.warn('Inbound approval poll failed', { error: error.message });
      }
    };
    this.pollTimer = setInterval(tick, intervalMs);
    this.pollTimer.unref();
    tick();
    this.logger.info('Inbound approval polling started (exclusive owner)', { intervalMs });
  }

  /** Periodic due-schedule check (Phase 10G, now service-hosted). */
  startSchedulerLoop() {
    const intervalMs = this.daemonConfig.schedulerTickMs ?? 60_000;
    const tick = async () => {
      try {
        const actions = await this.scheduler.runDue(new Date());
        if (actions.length) this.emit('scheduler', actions);
      } catch (error) {
        this.logger.warn('Scheduler tick failed', { error: error.message });
      }
    };
    this.schedulerTimer = setInterval(tick, intervalMs);
    this.schedulerTimer.unref();
    tick();
  }

  /** Periodic worker liveness scan — reaps records of workers that died. */
  startWorkerScan() {
    const intervalMs = this.daemonConfig.workerScanMs ?? 10_000;
    this.scanTimer = setInterval(() => {
      const reaped = this.workerRegistry.reapStale();
      for (const record of reaped) {
        this.logger.warn('Mission worker disappeared', {
          project: record.project, pid: record.pid,
        });
        this.emit('worker', { type: 'worker:crashed', project: record.project, pid: record.pid });
      }
      this.record.setContext({ workers: this.supervisor.list().length });
    }, intervalMs);
    this.scanTimer.unref();
  }

  /**
   * Watch for a stop request written by `ai-orchestrator daemon stop`.
   *
   * Same reasoning as the worker stop file: on Windows a cross-process
   * SIGTERM is TerminateProcess, so the service would die without releasing
   * its record — and the next `daemon status` would then report a crash the
   * operator never had. This makes a deliberate stop look deliberate.
   */
  watchStopFile() {
    this.stopFilePath = path.join(this.paths.stateDir, DAEMON_STOP_FILENAME);
    try {
      fs.rmSync(this.stopFilePath, { force: true }); // never inherit a stale request
    } catch {
      // Nothing actionable.
    }
    this.stopFileTimer = setInterval(() => {
      if (!fs.existsSync(this.stopFilePath)) return;
      try {
        fs.rmSync(this.stopFilePath, { force: true });
      } catch {
        // Nothing actionable.
      }
      this.logger.info('Stop requested via "daemon stop"');
      this.stop('operator stop').finally(() => this.exitProcess(0));
    }, 2_000);
    this.stopFileTimer.unref();
  }

  /**
   * Leave the process. Isolated behind a method so the shutdown paths are
   * testable: a bare process.exit() inside them terminates the test runner
   * mid-file, which silently skips every test after it while still reporting
   * success (found exactly that way while building this milestone).
   */
  // eslint-disable-next-line class-methods-use-this
  exitProcess(code) {
    process.exit(code);
  }

  installSignalHandlers() {
    const stop = (signal) => {
      this.logger.info(`Received ${signal}; stopping the Core Service`);
      this.stop(`signal ${signal}`).finally(() => this.exitProcess(0));
    };
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
      process.on(signal, stop);
    }
    process.on('uncaughtException', (error) => {
      this.logger.error('Uncaught exception in the Core Service — shutting down', {
        error: error.message, stack: error.stack,
      });
      this.stop('uncaught-exception').finally(() => this.exitProcess(1));
    });
    process.on('unhandledRejection', (reason) => {
      this.logger.error('Unhandled rejection in the Core Service — shutting down', {
        reason: reason instanceof Error ? reason.stack : String(reason),
      });
      this.stop('unhandled-rejection').finally(() => this.exitProcess(1));
    });
  }

  /**
   * Shut the service down.
   *
   * Running missions are LEFT ALIVE by default and re-adopted by the next
   * daemon (adoptExisting). Restarting the service — to upgrade it, or because
   * Windows rebooted it — must not destroy hours of unattended work, and the
   * worker registry makes recovering ownership a file read.
   *
   * @param {string} [reason]
   * @param {{stopWorkers?: boolean}} [options]
   */
  async stop(reason = 'shutdown', { stopWorkers = this.stopWorkersOnShutdown } = {}) {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    for (const timer of [this.pollTimer, this.schedulerTimer, this.scanTimer, this.stopFileTimer]) {
      if (timer) clearInterval(timer);
    }
    this.pollTimer = this.schedulerTimer = this.scanTimer = this.stopFileTimer = null;

    if (stopWorkers) {
      const results = this.supervisor.stopAll(reason);
      this.logger.info('Requested stop of every mission worker', { count: results.length });
    } else {
      const surviving = this.supervisor.list();
      if (surviving.length) {
        this.logger.info('Leaving mission workers running; the next service start will adopt them', {
          projects: surviving.map((w) => w.project),
        });
      }
    }

    await this.dashboard.stop();
    this.record.stop();
    this.logger.info('AI-Orchestrator Core Service stopped', { reason });
    this.emit('stopped', { reason });
  }

  // --------------------------------------------------------------- status --

  /** Host resources — what a remote operator asks for first ("is it alive?"). */
  hostReport() {
    const total = os.totalmem();
    const free = os.freemem();
    return {
      hostname: os.hostname(),
      platform: os.platform(),
      cpuCount: os.cpus().length,
      loadAverage: os.loadavg()[0],
      memoryTotalBytes: total,
      memoryFreeBytes: free,
      memoryUsedPercent: total ? Math.round(((total - free) / total) * 100) : null,
      uptimeMs: Math.round(os.uptime() * 1000),
    };
  }

  /** The full service report served by GET /api/daemon. */
  statusReport() {
    return {
      running: true,
      pid: process.pid,
      version: VERSION,
      startedAt: this.startedAt ? this.startedAt.toISOString() : null,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt.getTime() : 0,
      port: this.boundPort(),
      telegramInbound: this.canReceive,
      maxWorkers: this.supervisor.maxWorkers,
      workers: this.supervisor.list(),
      pendingApprovals: this.approvalStore.pendingAll().length,
      projects: this.configManager.listProjects(),
      host: this.hostReport(),
    };
  }
}

export default Daemon;
