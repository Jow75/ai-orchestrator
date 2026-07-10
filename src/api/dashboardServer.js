/**
 * dashboardServer.js — Dashboard API.
 *
 * Started as a read-only HTTP API (status, sessions, timeline, tasks,
 * memory) — the integration surface for the future desktop app (and for
 * anything else: curl, scripts, monitoring). Every GET endpoint below is
 * unchanged since P0/P2/P5 and remains open on the local-only bind
 * (`api.host` default `127.0.0.1`) — observability was never a risk.
 *
 * Phase P7 adds mutating endpoints (stop the mission, edit a task queue,
 * approve/skip a blocked task, record/resolve memory) — "the UI is purely
 * an API client," so the actual desktop app needs a real mutation surface,
 * not just reads. Every mutating endpoint requires the local API token
 * (see `apiAuth.js`); every GET endpoint remains unauthenticated, matching
 * how it's always worked. Can be disabled entirely via config `api.enabled`.
 */

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { requireAuth } from './apiAuth.js';
import { validateSingleTask } from '../mission/missionPlan.js';

export class DashboardServer {
  /**
   * @param {object} deps
   * @param {object} deps.config - The `api` config block ({enabled, host, port}).
   * @param {object} deps.logger - Module logger.
   * @param {import('../state/statusManager.js').StatusManager} deps.statusManager
   * @param {import('../state/sessionManager.js').SessionManager} deps.sessionManager
   * @param {import('../config/configManager.js').ConfigManager} deps.configManager
   * @param {import('../state/missionTimeline.js').MissionTimeline} [deps.timeline]
   * @param {import('../mission/taskQueue.js').TaskQueue} [deps.taskQueue]
   * @param {import('../memory/memoryStore.js').MemoryStore} [deps.memoryStore]
   * @param {import('../core/orchestrator.js').Orchestrator} [deps.orchestrator] -
   *   Phase P7: needed only for `POST /api/control/stop` (an in-memory call
   *   on the live process, unlike every other mutating endpoint below,
   *   which mutate persisted state files the same way the CLI does).
   * @param {string} [deps.apiToken] - Phase P7: required for every mutating
   *   endpoint. Omitted (or falsy) means mutating endpoints always 401 —
   *   a safe default, not an open-by-default fallback.
   */
  constructor({
    config, logger, statusManager, sessionManager, configManager, timeline, taskQueue, memoryStore,
    agentRegistry, agentHealth, orchestrator, apiToken,
  }) {
    this.config = config;
    this.logger = logger;
    this.statusManager = statusManager;
    this.sessionManager = sessionManager;
    this.configManager = configManager;
    this.timeline = timeline;
    this.taskQueue = taskQueue;
    this.memoryStore = memoryStore;
    this.agentRegistry = agentRegistry; // Phase 9 (optional)
    this.agentHealth = agentHealth; // Phase 9 (optional)
    this.orchestrator = orchestrator;
    this.apiToken = apiToken;
    this.server = null;
    this.app = this.buildApp();
  }

  buildApp() {
    const app = express();
    app.use(helmet());
    app.use(cors());
    app.use(express.json());
    app.disable('x-powered-by');

    this.buildReadRoutes(app);
    this.buildMutatingRoutes(app);

    app.use((req, res) => {
      res.status(404).json({ error: 'Not found' });
    });

    return app;
  }

  buildReadRoutes(app) {
    // Liveness probe.
    app.get('/api/health', (req, res) => {
      res.json({ ok: true, pid: process.pid, uptimeMs: Math.round(process.uptime() * 1000) });
    });

    // The same data as status.json, straight from memory.
    app.get('/api/status', (req, res) => {
      res.json(this.statusManager.get());
    });

    // All projects with active sessions.
    app.get('/api/sessions', (req, res) => {
      res.json(this.sessionManager.listActiveSessions());
    });

    // Finished-session history for one project.
    app.get('/api/sessions/:project/history', (req, res) => {
      res.json(this.sessionManager.getHistory(req.params.project));
    });

    // Mission timeline for one project (key events over time).
    app.get('/api/timeline/:project', (req, res) => {
      res.json(this.timeline ? this.timeline.read(req.params.project) : []);
    });

    // Task queue for one project (Phase P2 mission mode; null for legacy
    // single-prompt projects or a project that hasn't run yet).
    app.get('/api/tasks/:project', (req, res) => {
      res.json(this.taskQueue ? this.taskQueue.load(req.params.project) : null);
    });

    // Long-term memory for one project (Phase P5): notes, failure catalog,
    // archived task history. Null if nothing has been recorded yet.
    app.get('/api/memory/:project', (req, res) => {
      res.json(this.memoryStore ? this.memoryStore.load(req.params.project) : null);
    });

    // Defined projects and whether each currently has an active session.
    app.get('/api/projects', (req, res) => {
      const active = new Set(
        this.sessionManager.listActiveSessions().map((s) => s.project)
      );
      res.json(
        this.configManager.listProjects().map((name) => ({
          name,
          hasActiveSession: active.has(name),
        }))
      );
    });

    // Phase 9: the agent roster. With ?project=<name> the effective roster
    // for that project (the implicit default for an agent-less project);
    // otherwise the global agents. Empty array if the agent layer is absent.
    app.get('/api/agents', (req, res) => {
      if (!this.agentRegistry) return res.json([]);
      res.json(this.rosterFor(req.query.project));
    });

    // Phase 9: per-agent engine install status + task performance tallies.
    app.get('/api/agents/health', (req, res) => {
      if (!this.agentRegistry || !this.agentHealth) return res.json([]);
      res.json(this.agentHealth.report(this.rosterFor(req.query.project)));
    });
  }

  /** Resolve an agent roster for the API (project-scoped or global). */
  rosterFor(projectName) {
    if (projectName) {
      try {
        return this.agentRegistry.agentsFor(this.configManager.getProject(projectName));
      } catch {
        return [];
      }
    }
    return this.agentRegistry.globalAgents();
  }

  /**
   * Phase P7: mutating endpoints. Every route here is mounted behind
   * `requireAuth()` and mutates the SAME persisted state files the CLI
   * mutates (`tasks add/remove/reorder`, `memory add/resolve`) — a
   * concurrently-running orchestrator process never conflicts with these,
   * because a task can only reach BLOCKED/FAILED (the only states
   * `approve`/`skip` touch) after `block()` has already closed the
   * session and the orchestrator process has already exited (see
   * `TaskQueue#currentBlockedOrFailedTask()`).
   */
  buildMutatingRoutes(app) {
    const auth = requireAuth(this.apiToken);

    app.post('/api/control/stop', auth, async (req, res) => {
      if (!this.orchestrator) {
        res.status(503).json({ error: 'No live orchestrator to stop.' });
        return;
      }
      await this.orchestrator.stop(req.body?.reason ?? 'stopped via API');
      res.json({ ok: true });
    });

    app.post('/api/tasks/:project/add', auth, (req, res) => {
      if (!this.taskQueue) return this.noTaskQueue(res);
      let project;
      try {
        project = this.configManager.getProject(req.params.project);
      } catch (error) {
        res.status(404).json({ error: error.message });
        return;
      }

      const queue = this.taskQueue.ensure(req.params.project);
      const { task, problems } = validateSingleTask(req.body ?? {}, {
        label: `task "${req.body?.id}"`,
        workingDirectory: project.workingDirectory,
        seenIds: new Set(queue.tasks.map((t) => t.id)),
      });
      if (problems.length) {
        res.status(400).json({ ok: false, problems });
        return;
      }
      this.taskQueue.enqueue(queue, task);
      res.json({ ok: true, position: queue.tasks.length });
    });

    app.post('/api/tasks/:project/remove', auth, (req, res) => {
      this.mutateQueue(res, req.params.project, (queue) => (
        this.taskQueue.removeTask(queue, req.body?.taskId)
      ));
    });

    app.post('/api/tasks/:project/reorder', auth, (req, res) => {
      this.mutateQueue(res, req.params.project, (queue) => (
        this.taskQueue.reorderTask(queue, req.body?.taskId, req.body?.direction)
      ));
    });

    app.post('/api/tasks/:project/approve', auth, (req, res) => {
      this.mutateQueue(res, req.params.project, (queue) => (
        this.taskQueue.approveRetry(queue, req.body?.taskId)
      ));
    });

    app.post('/api/tasks/:project/skip', auth, (req, res) => {
      this.mutateQueue(res, req.params.project, (queue) => (
        this.taskQueue.operatorSkip(queue, req.body?.taskId, req.body?.reason)
      ));
    });

    app.post('/api/memory/:project/notes', auth, (req, res) => {
      if (!this.memoryStore) return this.noMemoryStore(res);
      const { category, text } = req.body ?? {};
      if (!text) {
        res.status(400).json({ ok: false, reason: '"text" is required.' });
        return;
      }
      this.memoryStore.addNote(req.params.project, { category: category ?? 'project', text });
      res.json({ ok: true });
    });

    app.post('/api/memory/:project/failures/:id/resolve', auth, (req, res) => {
      if (!this.memoryStore) return this.noMemoryStore(res);
      const result = this.memoryStore.resolveFailure(req.params.project, Number(req.params.id));
      res.status(result.ok ? 200 : 404).json(result);
    });
  }

  /** Shared plumbing for the task-queue mutating endpoints. */
  mutateQueue(res, project, mutate) {
    if (!this.taskQueue) return this.noTaskQueue(res);
    const queue = this.taskQueue.load(project);
    if (!queue) {
      res.status(404).json({ ok: false, reason: `No task queue for "${project}".` });
      return;
    }
    const result = mutate(queue);
    res.status(result.ok ? 200 : 400).json(result);
  }

  noTaskQueue(res) {
    res.status(503).json({ error: 'Task queue not available.' });
  }

  noMemoryStore(res) {
    res.status(503).json({ error: 'Memory store not available.' });
  }

  /** Start listening. Failure to bind is logged but never fatal. */
  async start() {
    if (!this.config.enabled) {
      this.logger.info('Dashboard API disabled by configuration');
      return;
    }

    await new Promise((resolve) => {
      this.server = this.app.listen(this.config.port, this.config.host, () => {
        this.logger.info('Dashboard API listening', {
          url: `http://${this.config.host}:${this.config.port}/api/status`,
        });
        resolve();
      });
      this.server.on('error', (error) => {
        // The API is observability, not supervision — degrade gracefully.
        this.logger.warn('Dashboard API failed to start (continuing without it)', {
          error: error.message,
        });
        this.server = null;
        resolve();
      });
    });
  }

  /** Stop listening (clean shutdown). */
  async stop() {
    if (!this.server) return;
    await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
  }
}

export default DashboardServer;
