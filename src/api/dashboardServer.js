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
import { readyTasks, blockedByDependencies } from '../coordination/dependencyGraph.js';
import { ProjectIntelligence } from '../intelligence/projectIntelligence.js';
import { SelfImprovement } from '../intelligence/selfImprovement.js';
import { MissionScheduler } from '../scheduler/missionScheduler.js';
import { ProgressLedger } from '../progress/progressLedger.js';

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
    approvalStore, approvalManager, lifecycle, resourceLocks, messageBus, paths, stopAll,
    daemon,
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
    // Phase 10 (all optional — endpoints 503 cleanly when absent).
    this.approvalStore = approvalStore;
    this.approvalManager = approvalManager;
    this.lifecycle = lifecycle;
    this.resourceLocks = resourceLocks;
    this.messageBus = messageBus;
    this.paths = paths;
    this.stopAll = stopAll; // stops every parallel mission (10H)
    // Phase 12 M1 (optional): the Core Service hosting this server. Present
    // only when `ai-orchestrator serve` built it; a standalone mission's own
    // server leaves it undefined and every /api/daemon route 503s cleanly —
    // the same optional-collaborator contract every Phase 10 surface uses.
    this.daemon = daemon;
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

    // ── Phase 12 M1: the Core Service ────────────────────────────────────
    // Unauthenticated like every other GET since P0, and local-only by the
    // same `api.host` bind. It reports what is running; it changes nothing.
    app.get('/api/daemon', (req, res) => {
      if (!this.daemon) {
        return res.status(503).json({
          running: false,
          error: 'This API is served by a standalone mission, not the Core Service.',
        });
      }
      res.json(this.daemon.statusReport());
    });

    app.get('/api/daemon/workers', (req, res) => {
      if (!this.daemon) return res.status(503).json({ error: 'Core Service not available.' });
      res.json(this.daemon.supervisor.list());
    });

    // ── Phase 12 M2: the operator surfaces ───────────────────────────────
    // These are what make the desktop (M3) a client of the same registry the
    // phone reads, rather than a second implementation of "what is running".

    // The full project registry: status, worker, branch, commit, health.
    // `?health=false` / `?git=false` skip the expensive parts for a fast list.
    app.get('/api/registry', (req, res) => {
      if (!this.daemon) return res.status(503).json({ error: 'Core Service not available.' });
      res.json(this.daemon.projectRegistry.list({
        health: req.query.health !== 'false',
        git: req.query.git !== 'false',
      }));
    });

    app.get('/api/registry/:project', (req, res) => {
      if (!this.daemon) return res.status(503).json({ error: 'Core Service not available.' });
      res.json(this.daemon.projectRegistry.describe(req.params.project));
    });

    // The event log — the spine every interface reads.
    app.get('/api/events', (req, res) => {
      if (!this.daemon) return res.status(503).json({ error: 'Core Service not available.' });
      const sinceSeq = Number.parseInt(req.query.since, 10);
      res.json(this.daemon.events.read({
        sinceSeq: Number.isFinite(sinceSeq) ? sinceSeq : undefined,
        project: req.query.project || undefined,
        types: req.query.type ? String(req.query.type).split(',') : undefined,
        limit: Number.parseInt(req.query.limit, 10) || undefined,
      }));
    });

    // Which project each remote channel currently has selected.
    app.get('/api/operator/context', (req, res) => {
      if (!this.daemon) return res.status(503).json({ error: 'Core Service not available.' });
      res.json(this.daemon.operatorContext.all());
    });

    // Mission requests raised from a remote channel (open by default).
    app.get('/api/operator/missions', (req, res) => {
      if (!this.daemon) return res.status(503).json({ error: 'Core Service not available.' });
      res.json(req.query.all === 'true'
        ? this.daemon.missionRequests.list(req.query.project || undefined)
        : this.daemon.missionRequests.open(req.query.project || undefined));
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

    // ── Phase 10 read surfaces ───────────────────────────────────────────

    // 10A: approval requests — all pending, or one project's full history.
    app.get('/api/approvals', (req, res) => {
      res.json(this.approvalStore ? this.approvalStore.pendingAll() : []);
    });
    app.get('/api/approvals/:project', (req, res) => {
      res.json(this.approvalStore ? this.approvalStore.list(req.params.project) : []);
    });

    // 10D: mission lifecycle — current state + transition history.
    app.get('/api/lifecycle/:project', (req, res) => {
      res.json(this.lifecycle ? this.lifecycle.get(req.params.project) : null);
    });

    // 10H: coordination — held locks, ready set, dependency stalls, messages.
    app.get('/api/coordination/:project', (req, res) => {
      const queue = this.taskQueue?.load(req.params.project) ?? null;
      res.json({
        locks: this.resourceLocks ? this.resourceLocks.held() : [],
        readyTasks: queue ? readyTasks(queue).map((t) => t.id) : [],
        waitingOnDependencies: queue ? blockedByDependencies(queue) : [],
        messages: this.messageBus ? this.messageBus.list(req.params.project) : [],
      });
    });

    // 10E: project intelligence (recommendations; never executes anything).
    app.get('/api/intelligence/:project', (req, res) => {
      const intelligence = this.buildIntelligence();
      if (!intelligence) return res.status(503).json({ error: 'Intelligence unavailable.' });
      try {
        res.json(intelligence.analyze(req.params.project));
      } catch (error) {
        res.status(400).json({ error: error.message });
      }
    });

    // 10I: self-improvement analysis (all projects, or ?project=<name>).
    app.get('/api/improvement', (req, res) => {
      const improvement = this.buildImprovement();
      if (!improvement) return res.status(503).json({ error: 'Improvement analysis unavailable.' });
      res.json(improvement.analyze(req.query.project || undefined));
    });

    // 10G: schedules — definitions merged with run state and next-due times.
    app.get('/api/schedules', (req, res) => {
      const scheduler = this.buildScheduler();
      if (!scheduler) return res.status(503).json({ error: 'Scheduler unavailable.' });
      res.json(scheduler.report());
    });
  }

  /** Lazily assemble the 10E analyzer over the same read-only views. */
  buildIntelligence() {
    if (!this.paths) return null;
    return new ProjectIntelligence({
      configManager: this.configManager,
      sessionManager: this.sessionManager,
      taskQueue: this.taskQueue,
      memoryStore: this.memoryStore,
      ledger: new ProgressLedger({ ledgerDir: this.paths.ledgerDir, logger: this.logger }),
      agentRegistry: this.agentRegistry,
      agentHealth: this.agentHealth,
      approvalStore: this.approvalStore,
      lifecycle: this.lifecycle,
      logger: this.logger,
    });
  }

  /** Lazily assemble the 10I analyzer. */
  buildImprovement() {
    if (!this.paths) return null;
    return new SelfImprovement({
      listProjects: () => this.configManager.listProjects(),
      ledger: new ProgressLedger({ ledgerDir: this.paths.ledgerDir, logger: this.logger }),
      memoryStore: this.memoryStore,
      taskQueue: this.taskQueue,
      agentHealth: this.agentHealth,
      approvalStore: this.approvalStore,
      logger: this.logger,
    });
  }

  /** Lazily assemble a read/report-only scheduler view. */
  buildScheduler() {
    if (!this.paths) return null;
    return new MissionScheduler({
      schedulesFile: this.paths.schedulesFile,
      stateFile: this.paths.schedulesStateFile,
      heartbeatFile: this.paths.heartbeatFile,
      rootDir: this.paths.root,
      logger: this.logger,
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

    // ── Phase 12 M1: mission control through the Core Service ────────────
    // These are what finally make several projects independently startable:
    // each one becomes its own supervised worker process, so "start
    // Calculator while Remote Work runs" stops being a machine-wide conflict.
    app.post('/api/daemon/missions/start', auth, (req, res) => {
      if (!this.daemon) return res.status(503).json({ error: 'Core Service not available.' });
      const { project, fresh } = req.body ?? {};
      if (!project) {
        return res.status(400).json({ ok: false, reason: '"project" is required.' });
      }
      try {
        this.configManager.getProject(project);
      } catch (error) {
        return res.status(404).json({ ok: false, reason: error.message });
      }
      const result = this.daemon.supervisor.start(project, { fresh: fresh === true });
      res.status(result.ok ? 200 : 409).json(result);
    });

    app.post('/api/daemon/missions/stop', auth, (req, res) => {
      if (!this.daemon) return res.status(503).json({ error: 'Core Service not available.' });
      const { project, reason } = req.body ?? {};
      if (!project) {
        return res.status(400).json({ ok: false, reason: '"project" is required.' });
      }
      const result = this.daemon.supervisor.stop(project, { reason: reason ?? 'stopped via API' });
      res.status(result.ok ? 200 : 404).json(result);
    });

    /**
     * Phase 12 M2: run one operator command through the SAME router the
     * remote channel uses.
     *
     * This is the architectural claim of the milestone made testable: Telegram
     * is one client, not the interface. The desktop (M3), the CLI, and any
     * future web console send the same strings here and get the same answers,
     * with no duplicated command logic anywhere.
     *
     * Behind the P7 token, because it can start and stop missions.
     * `channel` defaults to 'api' so confirmations issued to a phone are not
     * redeemable from here and vice versa (see confirmations.js).
     */
    app.post('/api/operator/command', auth, async (req, res) => {
      if (!this.daemon) return res.status(503).json({ error: 'Core Service not available.' });
      const { text, channel, chatId, from } = req.body ?? {};
      if (typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ ok: false, reason: '"text" is required.' });
      }
      const result = await this.daemon.commandRouter.handle({
        text,
        channel: channel || 'api',
        chatId: chatId ?? null,
        from: from || 'api',
      });
      res.json({ ok: true, reply: result.reply });
    });

    app.post('/api/control/stop', auth, async (req, res) => {
      if (!this.orchestrator && !this.stopAll) {
        res.status(503).json({ error: 'No live orchestrator to stop.' });
        return;
      }
      const reason = req.body?.reason ?? 'stopped via API';
      // Phase 10H: stop EVERY parallel mission when the App provided the
      // aggregate; the single-orchestrator path is unchanged otherwise.
      if (this.stopAll) await this.stopAll(reason);
      else await this.orchestrator.stop(reason);
      res.json({ ok: true });
    });

    // ── Phase 10 mutating surfaces ───────────────────────────────────────

    // 10A: decide an approval request (approve/reject/modify/done).
    app.post('/api/approvals/:project/:id/decide', auth, (req, res) => {
      if (!this.approvalStore) {
        return res.status(503).json({ error: 'Approval store not available.' });
      }
      const { decision, note } = req.body ?? {};
      const params = { decision, note, by: 'api', via: 'api' };
      const result = this.approvalManager
        ? this.approvalManager.resolve(req.params.project, req.params.id, params)
        : this.approvalStore.resolve(req.params.project, req.params.id, params);
      res.status(result.ok ? 200 : 400).json(result);
    });

    // 10H: post a cross-agent message.
    app.post('/api/messages/:project', auth, (req, res) => {
      if (!this.messageBus) return res.status(503).json({ error: 'Message bus not available.' });
      const { from, to, topic, text } = req.body ?? {};
      if (!from || !to || !text) {
        return res.status(400).json({ ok: false, reason: '"from", "to", and "text" are required.' });
      }
      const message = this.messageBus.post(req.params.project, { from, to, topic, text });
      res.json({ ok: true, message });
    });

    // 10G: schedule management.
    app.post('/api/schedules/add', auth, (req, res) => {
      const scheduler = this.buildScheduler();
      if (!scheduler) return res.status(503).json({ error: 'Scheduler unavailable.' });
      const result = scheduler.add(req.body ?? {});
      res.status(result.ok ? 200 : 400).json(result);
    });
    app.post('/api/schedules/:id/remove', auth, (req, res) => {
      const scheduler = this.buildScheduler();
      if (!scheduler) return res.status(503).json({ error: 'Scheduler unavailable.' });
      const result = scheduler.remove(req.params.id);
      res.status(result.ok ? 200 : 404).json(result);
    });
    app.post('/api/schedules/:id/enable', auth, (req, res) => {
      const scheduler = this.buildScheduler();
      if (!scheduler) return res.status(503).json({ error: 'Scheduler unavailable.' });
      const result = scheduler.setEnabled(req.params.id, req.body?.enabled !== false);
      res.status(result.ok ? 200 : 404).json(result);
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
