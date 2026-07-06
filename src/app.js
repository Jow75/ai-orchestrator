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
import MemoryStore from './memory/memoryStore.js';
import Heartbeat from './state/heartbeat.js';
import DriverRegistry from './drivers/driverRegistry.js';
import Orchestrator from './core/orchestrator.js';
import NotificationEngine from './notifications/notificationEngine.js';
import PluginManager from './plugins/pluginManager.js';
import DashboardServer from './api/dashboardServer.js';

/** Cadence for checking the CLI stop-request file while supervising. */
const STOP_FILE_POLL_MS = 5_000;

/** Name of the file `ai-orchestrator stop` drops to request a shutdown. */
export const STOP_REQUEST_FILENAME = 'stop.requested';

export class App {
  /**
   * @param {object} [options]
   * @param {string} [options.rootDir] - Override installation root (tests).
   */
  constructor(options = {}) {
    this.configManager = new ConfigManager(options);
    this.config = this.configManager.getAll();
    this.paths = this.configManager.getPaths();
    ensureRuntimeDirs(this.paths);

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

    this.driverRegistry = new DriverRegistry({ logger: this.logger });

    this.orchestrator = new Orchestrator({
      configManager: this.configManager,
      driverRegistry: this.driverRegistry,
      sessionManager: this.sessionManager,
      statusManager: this.statusManager,
      paths: this.paths,
      logger: childLogger(this.logger, 'orchestrator'),
    });

    this.notifications = new NotificationEngine({
      config: this.config.notifications,
      logger: childLogger(this.logger, 'notifications'),
    });
    this.notifications.attach(this.orchestrator);

    this.timeline = new MissionTimeline({
      timelineDir: this.paths.timelineDir,
      logger: childLogger(this.logger, 'timeline'),
    });
    this.timeline.attach(this.orchestrator);

    // Read-only view for the dashboard API; the orchestrator owns its own
    // TaskQueue instance for actually driving mission-mode supervision.
    this.taskQueue = new TaskQueue({
      tasksDir: this.paths.tasksDir,
      logger: childLogger(this.logger, 'tasks'),
    });

    // Read-only view for the dashboard API; the orchestrator owns its own
    // MemoryStore instance (see Orchestrator's constructor).
    this.memoryStore = new MemoryStore({
      memoryDir: this.paths.memoryDir,
      logger: childLogger(this.logger, 'memory'),
    });

    this.pluginManager = new PluginManager({
      pluginsDir: this.paths.pluginsDir,
      logger: childLogger(this.logger, 'plugins'),
    });

    this.dashboard = new DashboardServer({
      config: this.config.api,
      logger: childLogger(this.logger, 'api'),
      statusManager: this.statusManager,
      sessionManager: this.sessionManager,
      configManager: this.configManager,
      timeline: this.timeline,
      taskQueue: this.taskQueue,
      memoryStore: this.memoryStore,
    });

    this.stopFilePath = path.join(this.paths.stateDir, STOP_REQUEST_FILENAME);
    this.stopFileTimer = null;
    this.shuttingDown = false;
  }

  /**
   * Run supervision for a project until done.
   *
   * @param {object} params
   * @param {string} [params.projectName] - Project to supervise. Falls back
   *   to config `defaultProject`, then to the single defined project.
   * @param {boolean} [params.onlyIfResumable] - `resume` mode: exit quietly
   *   when nothing was interrupted (used by the Task Scheduler boot task).
   * @param {boolean} [params.fresh] - Abandon any interrupted session and
   *   start the mission from the beginning (explicit operator choice).
   * @returns {Promise<{complete: boolean, reason: string}|null>}
   */
  async start({ projectName, onlyIfResumable = false, fresh = false } = {}) {
    // Guard against double launch / detect unclean shutdown.
    const previous = this.heartbeat.inspectPrevious();
    if (previous.kind === 'already-running') {
      throw new Error(
        `Another AI-Orchestrator instance is already running (pid ${previous.previous.pid}). ` +
        'Use "ai-orchestrator status" to inspect it or "ai-orchestrator stop" to stop it.'
      );
    }
    const recoveredAfter =
      previous.kind === 'unclean-shutdown' ? 'reboot-or-power-loss' : undefined;

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
    await this.dashboard.start();
    this.statusManager.startUpdates();
    this.heartbeat.start({ project: resolved });
    this.installSignalHandlers();
    this.watchStopFile();

    this.logger.info('AI-Orchestrator started', {
      project: resolved,
      pid: process.pid,
    });

    try {
      return await this.orchestrator.runProject(resolved, { recoveredAfter });
    } finally {
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
      this.orchestrator.stop(`signal ${signal}`);
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
        this.orchestrator.stop('cli stop command');
      }
    }, STOP_FILE_POLL_MS);
    this.stopFileTimer.unref();
  }

  /** Tear everything down exactly once. */
  async shutdown(finalState = 'stopped') {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    if (this.stopFileTimer) clearInterval(this.stopFileTimer);
    await this.orchestrator.stop('shutdown');
    await this.dashboard.stop();
    await this.pluginManager.shutdownAll();
    this.statusManager.stopUpdates(finalState);
    this.heartbeat.stop();
    this.logger.info('AI-Orchestrator shut down cleanly');
  }
}

export default App;
