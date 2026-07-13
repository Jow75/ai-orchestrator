'use strict';

/**
 * orchestratorBridge.js — the only place the desktop app touches the
 * backend. Every method picks one of two paths:
 *
 *  - LIVE  (an orchestrator process is currently supervising, detected via
 *    state/heartbeat.json): talk to the dashboard HTTP API — the exact
 *    integration surface Phase P7 built "for the future desktop app."
 *  - IDLE  (nothing running, so there is no HTTP server to reach): use the
 *    same library classes the CLI's read-only commands use
 *    (ConfigManager/TaskQueue/MemoryStore/MissionTimeline/SessionManager —
 *    all exported from src/index.js as documented "Library usage"). These
 *    are thin, file-backed wrappers with no supervision/verification
 *    decision logic of their own, so using them directly is reuse, not
 *    duplication.
 *
 * Starting a mission spawns `bin/ai-orchestrator.js start <project>` as a
 * real child process — exactly what a human typing the CLI command would
 * do — never an in-process re-implementation of Orchestrator/App.
 *
 * This module is plain CommonJS (see desktop/package.json) so Electron's
 * preload/main process story stays simple; it reaches the backend's ESM
 * modules via dynamic import(), which CommonJS supports natively.
 */

const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const BIN_PATH = path.join(ROOT_DIR, 'bin', 'ai-orchestrator.js');

/** Lazily import the ESM backend modules this bridge needs (cached once). */
let backendPromise = null;
function backend() {
  if (!backendPromise) {
    backendPromise = Promise.all([
      import('../../src/config/configManager.js'),
      import('../../src/state/sessionManager.js'),
      import('../../src/state/missionTimeline.js'),
      import('../../src/mission/taskQueue.js'),
      import('../../src/mission/missionPlan.js'),
      import('../../src/memory/memoryStore.js'),
      import('../../src/api/apiAuth.js'),
      import('../../src/state/heartbeat.js'),
      import('../../src/state/statePersistence.js'),
      import('../../src/infra/logger.js'),
      import('../../src/drivers/driverRegistry.js'),
      import('../../src/agents/agentRegistry.js'),
      import('../../src/agents/agentHealth.js'),
      import('../../src/app.js'),
      // Phase 10 read/mutate surfaces.
      import('../../src/approvals/approvalStore.js'),
      import('../../src/mission/missionLifecycle.js'),
      import('../../src/coordination/resourceLocks.js'),
      import('../../src/coordination/agentMessages.js'),
      import('../../src/coordination/dependencyGraph.js'),
    ]).then(
      ([
        configManagerMod, sessionManagerMod, missionTimelineMod, taskQueueMod,
        missionPlanMod, memoryStoreMod, apiAuthMod, heartbeatMod,
        statePersistenceMod, loggerMod, driverRegistryMod, agentRegistryMod,
        agentHealthMod, appMod,
        approvalStoreMod, missionLifecycleMod, resourceLocksMod, agentMessagesMod,
        dependencyGraphMod,
      ]) => ({
        ConfigManager: configManagerMod.ConfigManager,
        ConfigError: configManagerMod.ConfigError,
        SessionManager: sessionManagerMod.SessionManager,
        MissionTimeline: missionTimelineMod.MissionTimeline,
        TaskQueue: taskQueueMod.TaskQueue,
        validateSingleTask: missionPlanMod.validateSingleTask,
        MemoryStore: memoryStoreMod.MemoryStore,
        loadOrCreateToken: apiAuthMod.loadOrCreateToken,
        isPidAlive: heartbeatMod.isPidAlive,
        readJsonSafe: statePersistenceMod.readJsonSafe,
        silentLogger: loggerMod.silentLogger,
        DriverRegistry: driverRegistryMod.DriverRegistry,
        AgentRegistry: agentRegistryMod.AgentRegistry,
        AgentHealth: agentHealthMod.AgentHealth,
        STOP_REQUEST_FILENAME: appMod.STOP_REQUEST_FILENAME,
        ApprovalStore: approvalStoreMod.ApprovalStore,
        MissionLifecycle: missionLifecycleMod.MissionLifecycle,
        ResourceLockManager: resourceLocksMod.ResourceLockManager,
        AgentMessageBus: agentMessagesMod.AgentMessageBus,
        readyTasks: dependencyGraphMod.readyTasks,
        blockedByDependencies: dependencyGraphMod.blockedByDependencies,
      })
    );
  }
  return backendPromise;
}

class OrchestratorBridge {
  /**
   * @param {object} [options]
   * @param {string} [options.rootDir] - Installation root (tests override).
   * @param {typeof fetch} [options.fetchImpl] - Injectable for tests.
   */
  constructor({ rootDir = ROOT_DIR, fetchImpl = globalThis.fetch } = {}) {
    this.rootDir = rootDir;
    this.fetchImpl = fetchImpl;
    this._configManager = null;
    this.liveChild = null; // the process this bridge itself spawned, if any
  }

  // ---------------------------------------------------------------- setup --

  async configManager() {
    const { ConfigManager } = await backend();
    if (!this._configManager) {
      this._configManager = new ConfigManager({ rootDir: this.rootDir });
    }
    return this._configManager;
  }

  async paths() {
    const cm = await this.configManager();
    return cm.getPaths();
  }

  async logger() {
    return (await backend()).silentLogger;
  }

  // ------------------------------------------------------------ liveness --

  /** Is an orchestrator process currently supervising (any project)? */
  async isLive() {
    const { readJsonSafe, isPidAlive } = await backend();
    const paths = await this.paths();
    const heartbeat = readJsonSafe(paths.heartbeatFile);
    return Boolean(heartbeat && heartbeat.state === 'running' && isPidAlive(heartbeat.pid));
  }

  async apiBase() {
    const cm = await this.configManager();
    const api = cm.getAll().api ?? {};
    return `http://${api.host ?? '127.0.0.1'}:${api.port ?? 4711}`;
  }

  async apiToken() {
    const { loadOrCreateToken } = await backend();
    const paths = await this.paths();
    return loadOrCreateToken(paths.apiTokenFile);
  }

  /**
   * Call the dashboard HTTP API. Never throws — network problems come back
   * as `{ ok: false, reason }` so callers can fall back or surface a clear
   * message instead of crashing an IPC handler.
   */
  async apiCall(pathSuffix, { method = 'GET', body, auth = false, timeoutMs = 4000 } = {}) {
    if (!this.fetchImpl) {
      return { ok: false, status: 0, reason: 'fetch is not available in this runtime.' };
    }
    const headers = { 'content-type': 'application/json' };
    if (auth) headers.authorization = `Bearer ${await this.apiToken()}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(`${await this.apiBase()}${pathSuffix}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const data = await res.json().catch(() => null);
      return { ok: res.ok, status: res.status, data };
    } catch (error) {
      return { ok: false, status: 0, reason: error.message };
    } finally {
      clearTimeout(timer);
    }
  }

  // ------------------------------------------------------------- reads ---

  /** Defined projects + whether each has an active session (idle-safe). */
  async listProjects() {
    const cm = await this.configManager();
    const { SessionManager, silentLogger } = await backend();
    const paths = cm.getPaths();
    const sessionManager = new SessionManager({ sessionsDir: paths.sessionsDir, logger: silentLogger });
    const active = new Set(sessionManager.listActiveSessions().map((s) => s.project));
    return cm.listProjects().map((name) => ({ name, hasActiveSession: active.has(name) }));
  }

  async getStatus() {
    if (await this.isLive()) {
      const result = await this.apiCall('/api/status');
      if (result.ok) return result.data;
    }
    const { readJsonSafe } = await backend();
    const paths = await this.paths();
    return readJsonSafe(paths.statusFile);
  }

  async getHealth() {
    const result = await this.apiCall('/api/health');
    return result.ok ? result.data : null;
  }

  async getTasks(project) {
    if (await this.isLive()) {
      const result = await this.apiCall(`/api/tasks/${encodeURIComponent(project)}`);
      if (result.ok) return result.data;
    }
    const { TaskQueue, silentLogger } = await backend();
    const paths = await this.paths();
    return new TaskQueue({ tasksDir: paths.tasksDir, logger: silentLogger }).load(project);
  }

  async getMemory(project) {
    if (await this.isLive()) {
      const result = await this.apiCall(`/api/memory/${encodeURIComponent(project)}`);
      if (result.ok) return result.data;
    }
    const { MemoryStore, silentLogger } = await backend();
    const paths = await this.paths();
    return new MemoryStore({ memoryDir: paths.memoryDir, logger: silentLogger }).load(project);
  }

  async getTimeline(project) {
    if (await this.isLive()) {
      const result = await this.apiCall(`/api/timeline/${encodeURIComponent(project)}`);
      if (result.ok) return result.data;
    }
    const { MissionTimeline, silentLogger } = await backend();
    const paths = await this.paths();
    return new MissionTimeline({ timelineDir: paths.timelineDir, logger: silentLogger }).read(project);
  }

  async getSessionHistory(project) {
    if (await this.isLive()) {
      const result = await this.apiCall(`/api/sessions/${encodeURIComponent(project)}/history`);
      if (result.ok) return result.data;
    }
    const { SessionManager, silentLogger } = await backend();
    const paths = await this.paths();
    return new SessionManager({ sessionsDir: paths.sessionsDir, logger: silentLogger }).getHistory(project);
  }

  async listDrivers() {
    const { DriverRegistry, silentLogger } = await backend();
    return new DriverRegistry({ logger: silentLogger }).listDrivers();
  }

  /** Build an AgentRegistry + resolved roster for a project (idle helper). */
  async agentRosterFor(project) {
    const { AgentRegistry, DriverRegistry, silentLogger } = await backend();
    const cm = await this.configManager();
    const paths = cm.getPaths();
    const registry = new AgentRegistry({
      driverRegistry: new DriverRegistry({ logger: silentLogger }),
      logger: silentLogger,
      agentsFile: paths.agentsFile,
    });
    if (project) {
      try {
        return { registry, roster: registry.agentsFor(cm.getProject(project)) };
      } catch {
        return { registry, roster: [] };
      }
    }
    return { registry, roster: registry.globalAgents() };
  }

  /** Phase 9: the agent roster (live → API, idle → registry). */
  async getAgents(project) {
    if (await this.isLive()) {
      const q = project ? `?project=${encodeURIComponent(project)}` : '';
      const result = await this.apiCall(`/api/agents${q}`);
      if (result.ok) return result.data;
    }
    const { roster } = await this.agentRosterFor(project);
    return roster;
  }

  /** Phase 9: per-agent health + performance (live → API, idle → store). */
  async getAgentHealth(project) {
    if (await this.isLive()) {
      const q = project ? `?project=${encodeURIComponent(project)}` : '';
      const result = await this.apiCall(`/api/agents/health${q}`);
      if (result.ok) return result.data;
    }
    const { AgentHealth, silentLogger } = await backend();
    const paths = await this.paths();
    const { roster } = await this.agentRosterFor(project);
    return new AgentHealth({ healthFile: paths.agentHealthFile, logger: silentLogger }).report(roster);
  }

  /** Global config (for Settings' read-only notification/paths display). */
  async getGlobalConfig() {
    const cm = await this.configManager();
    return cm.getAll();
  }

  /** Resolved runtime paths (for Settings' "project locations" panel). */
  async getPaths() {
    return this.paths();
  }

  /** One project's config, or `{ error }` rather than throwing (display-only). */
  async getProjectDetails(name) {
    const cm = await this.configManager();
    try {
      const project = cm.getProject(name);
      return {
        name, driver: project.driver, workingDirectory: project.workingDirectory,
        promptFile: project.promptFile ?? null, taskCount: project.tasks?.length ?? 0,
      };
    } catch (error) {
      return { name, error: error.message };
    }
  }

  // ---------------------------------------------------------- task queue --

  async addTask(project, task) {
    if (await this.isLive()) {
      const result = await this.apiCall(`/api/tasks/${encodeURIComponent(project)}/add`, {
        method: 'POST', auth: true, body: task,
      });
      return result.data ?? { ok: false, reason: result.reason ?? 'Request failed.' };
    }
    const { TaskQueue, validateSingleTask, silentLogger } = await backend();
    const cm = await this.configManager();
    let projectConfig;
    try {
      projectConfig = cm.getProject(project);
    } catch (error) {
      return { ok: false, reason: error.message };
    }
    const paths = await this.paths();
    const taskQueue = new TaskQueue({ tasksDir: paths.tasksDir, logger: silentLogger });
    const queue = taskQueue.ensure(project);
    const { task: normalized, problems } = validateSingleTask(task, {
      label: `task "${task.id}"`,
      workingDirectory: projectConfig.workingDirectory,
      seenIds: new Set(queue.tasks.map((t) => t.id)),
    });
    if (problems.length) return { ok: false, problems };
    taskQueue.enqueue(queue, normalized);
    return { ok: true, position: queue.tasks.length };
  }

  async removeTask(project, taskId) {
    return this.mutateTaskQueue(project, { live: `remove`, auth: true, body: { taskId } }, (taskQueue, queue) =>
      taskQueue.removeTask(queue, taskId));
  }

  async reorderTask(project, taskId, direction) {
    return this.mutateTaskQueue(
      project,
      { live: 'reorder', auth: true, body: { taskId, direction } },
      (taskQueue, queue) => taskQueue.reorderTask(queue, taskId, direction)
    );
  }

  async approveTask(project, taskId) {
    return this.mutateTaskQueue(project, { live: 'approve', auth: true, body: { taskId } }, (taskQueue, queue) =>
      taskQueue.approveRetry(queue, taskId));
  }

  async skipTask(project, taskId, reason) {
    return this.mutateTaskQueue(
      project,
      { live: 'skip', auth: true, body: { taskId, reason } },
      (taskQueue, queue) => taskQueue.operatorSkip(queue, taskId, reason)
    );
  }

  /** Shared plumbing: live → the matching /api/tasks/:project/<verb> route; idle → direct TaskQueue call. */
  async mutateTaskQueue(project, { live: verb, auth, body }, idleMutate) {
    if (await this.isLive()) {
      const result = await this.apiCall(`/api/tasks/${encodeURIComponent(project)}/${verb}`, {
        method: 'POST', auth, body,
      });
      return result.data ?? { ok: false, reason: result.reason ?? 'Request failed.' };
    }
    const { TaskQueue, MissionLifecycle, silentLogger } = await backend();
    const paths = await this.paths();
    const taskQueue = new TaskQueue({
      tasksDir: paths.tasksDir,
      logger: silentLogger,
      lifecycle: new MissionLifecycle({ lifecycleDir: paths.lifecycleDir, logger: silentLogger }),
    });
    const queue = taskQueue.load(project);
    if (!queue) return { ok: false, reason: `No task queue for "${project}".` };
    return idleMutate(taskQueue, queue);
  }

  // -------------------------------------------------------------- memory --

  async addNote(project, note) {
    if (await this.isLive()) {
      const result = await this.apiCall(`/api/memory/${encodeURIComponent(project)}/notes`, {
        method: 'POST', auth: true, body: note,
      });
      return result.data ?? { ok: false, reason: result.reason ?? 'Request failed.' };
    }
    if (!note?.text) return { ok: false, reason: '"text" is required.' };
    const { MemoryStore, silentLogger } = await backend();
    const paths = await this.paths();
    new MemoryStore({ memoryDir: paths.memoryDir, logger: silentLogger })
      .addNote(project, { category: note.category ?? 'project', text: note.text });
    return { ok: true };
  }

  async resolveFailure(project, failureId) {
    if (await this.isLive()) {
      const result = await this.apiCall(
        `/api/memory/${encodeURIComponent(project)}/failures/${failureId}/resolve`,
        { method: 'POST', auth: true }
      );
      return result.data ?? { ok: false, reason: result.reason ?? 'Request failed.' };
    }
    const { MemoryStore, silentLogger } = await backend();
    const paths = await this.paths();
    return new MemoryStore({ memoryDir: paths.memoryDir, logger: silentLogger })
      .resolveFailure(project, Number(failureId));
  }

  // ------------------------------------------------------------ projects --

  /** Create a new (legacy single-prompt) project — mirrors `projects add`. */
  async createProject(name, { dir, promptFile, driver = 'claude' }) {
    const cm = await this.configManager();
    try {
      const file = cm.saveProject(name, {
        driver,
        workingDirectory: path.resolve(dir),
        promptFile,
      });
      return { ok: true, file };
    } catch (error) {
      return { ok: false, reason: error.message };
    }
  }

  // ------------------------------------------------------------- control --

  /**
   * Start (or resume) supervising a project — spawns the real CLI binary,
   * exactly as a human would run `ai-orchestrator start <project>`. Runs
   * with Electron's bundled Node (ELECTRON_RUN_AS_NODE) so it never depends
   * on a system Node install, detached so an overnight mission survives the
   * desktop window closing. stdio is fully ignored deliberately: piping it
   * would require *something* to keep draining the pipe for the life of the
   * child, and a detached process outliving this app has no such reader —
   * an unread pipe can fill and block the orchestrator's own log writes.
   * Observability instead comes from the winston log files (see logTail.js).
   */
  async startMission(project, { fresh = false } = {}) {
    if (await this.isLive()) {
      return { ok: false, reason: 'An orchestrator is already running. Stop it before starting another.' };
    }
    const args = [BIN_PATH, 'start', project];
    if (fresh) args.push('--fresh');

    return new Promise((resolve) => {
      const child = spawn(process.execPath, args, {
        cwd: this.rootDir,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      });

      let settled = false;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      child.once('error', (error) => settle({ ok: false, reason: error.message }));
      // No 'error' within a short grace window means the process launched.
      setTimeout(() => settle({ ok: true, pid: child.pid }), 500);
      child.unref();
    });
  }

  /**
   * Stop the live orchestrator gracefully (resumable). Prefers the HTTP
   * control endpoint (P7's sanctioned mechanism); falls back to writing the
   * same stop-request file the CLI's `stop` command writes, for the rare
   * case where the API itself is unreachable (e.g. `api.enabled: false`)
   * even though the process is alive.
   */
  async stopMission(reason) {
    if (!(await this.isLive())) {
      return { ok: false, reason: 'No running orchestrator found.' };
    }
    const result = await this.apiCall('/api/control/stop', { method: 'POST', auth: true, body: { reason } });
    if (result.ok) return result.data ?? { ok: true };

    const { STOP_REQUEST_FILENAME } = await backend();
    const paths = await this.paths();
    try {
      fs.writeFileSync(path.join(paths.stateDir, STOP_REQUEST_FILENAME), '');
      return { ok: true, viaFallback: true };
    } catch (error) {
      return { ok: false, reason: error.message };
    }
  }

  // ------------------------------------------------- Phase 10 surfaces ---

  /** 10A: pending approvals everywhere, or one project's history. */
  async getApprovals(project) {
    if (await this.isLive()) {
      const suffix = project ? `/api/approvals/${encodeURIComponent(project)}` : '/api/approvals';
      const result = await this.apiCall(suffix);
      if (result.ok) return result.data;
    }
    const { ApprovalStore, silentLogger } = await backend();
    const paths = await this.paths();
    const store = new ApprovalStore({ approvalsDir: paths.approvalsDir, logger: silentLogger });
    return project ? store.list(project) : store.pendingAll();
  }

  /** 10A: decide a request (approve/reject/modify/done). */
  async decideApproval(project, id, decision, note) {
    if (await this.isLive()) {
      const result = await this.apiCall(
        `/api/approvals/${encodeURIComponent(project)}/${encodeURIComponent(id)}/decide`,
        { method: 'POST', auth: true, body: { decision, note } }
      );
      return result.data ?? { ok: false, reason: result.reason ?? 'Request failed.' };
    }
    const { ApprovalStore, silentLogger } = await backend();
    const paths = await this.paths();
    return new ApprovalStore({ approvalsDir: paths.approvalsDir, logger: silentLogger })
      .resolve(project, id, { decision, note, by: 'owner', via: 'desktop' });
  }

  /** 10D: a mission's lifecycle record (state + history). */
  async getLifecycle(project) {
    if (await this.isLive()) {
      const result = await this.apiCall(`/api/lifecycle/${encodeURIComponent(project)}`);
      if (result.ok) return result.data;
    }
    const { MissionLifecycle, silentLogger } = await backend();
    const paths = await this.paths();
    return new MissionLifecycle({ lifecycleDir: paths.lifecycleDir, logger: silentLogger }).get(project);
  }

  /** 10H: coordination view (locks, ready set, stalls, messages). */
  async getCoordination(project) {
    if (await this.isLive()) {
      const result = await this.apiCall(`/api/coordination/${encodeURIComponent(project)}`);
      if (result.ok) return result.data;
    }
    const {
      ResourceLockManager, AgentMessageBus, TaskQueue,
      readyTasks, blockedByDependencies, silentLogger,
    } = await backend();
    const paths = await this.paths();
    const queue = new TaskQueue({ tasksDir: paths.tasksDir, logger: silentLogger }).load(project);
    return {
      locks: new ResourceLockManager({ coordinationDir: paths.coordinationDir, logger: silentLogger }).held(),
      readyTasks: queue ? readyTasks(queue).map((t) => t.id) : [],
      waitingOnDependencies: queue ? blockedByDependencies(queue) : [],
      messages: new AgentMessageBus({ coordinationDir: paths.coordinationDir, logger: silentLogger }).list(project),
    };
  }

  /** 10E: project intelligence (live only adds nothing — always via API when up). */
  async getIntelligence(project) {
    if (await this.isLive()) {
      const result = await this.apiCall(`/api/intelligence/${encodeURIComponent(project)}`);
      if (result.ok) return result.data;
    }
    // Idle: reuse the API server's own assembly through a direct import
    // would drag many modules in; the desktop keeps this live-only and
    // shows a hint otherwise.
    return null;
  }

  /** 10G: schedules with next-due times. */
  async getSchedules() {
    if (await this.isLive()) {
      const result = await this.apiCall('/api/schedules');
      if (result.ok) return result.data;
    }
    const { readJsonSafe } = await backend();
    const paths = await this.paths();
    const raw = readJsonSafe(paths.schedulesFile);
    return { schedules: Array.isArray(raw) ? raw : (raw?.schedules ?? []), problems: [] };
  }

  // --------------------------------------------------------- api token ---

  async getApiToken() {
    const { loadOrCreateToken } = await backend();
    const paths = await this.paths();
    return loadOrCreateToken(paths.apiTokenFile);
  }

  async rotateApiToken() {
    const { loadOrCreateToken } = await backend();
    const paths = await this.paths();
    return loadOrCreateToken(paths.apiTokenFile, { rotate: true });
  }
}

module.exports = { OrchestratorBridge, ROOT_DIR, BIN_PATH };
