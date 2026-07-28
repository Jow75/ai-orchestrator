/**
 * orchestrator.js — The supervision loop.
 *
 * One Orchestrator supervises one project's mission from launch to
 * completion, however many days, crashes, usage limits, or reboots that
 * takes. The loop:
 *
 *   launch the agent
 *     → observe passively while it is alive (NEVER interfere)
 *     → when (and only when) it exits, classify WHY
 *     → apply that cause's recovery strategy
 *     → resume the same engine conversation
 *   ... until the mission's completion marker appears, or the operator stops it.
 *
 * Phase P2: a project may define `tasks` — an ordered plan instead of one
 * implicit task. In that mode, "the mission's completion marker" above
 * becomes "the current task's verifiers", and completing a task advances to
 * the next one (same engine conversation) rather than ending the mission.
 * A project with no `tasks` runs exactly as before (see missionPlan.js).
 *
 * Policy lives in the engines it composes (rate-limit, crash-recovery,
 * classifier); engine-specific knowledge lives in the driver. This class is
 * pure coordination, and everything it decides is logged and persisted so a
 * process death at any instant is recoverable.
 *
 * It emits domain events (see EVENTS below); notifications, plugins, and
 * the dashboard subscribe to those rather than being called directly —
 * integrations never touch supervision logic.
 */

import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { classifyExit, ExitCause } from './exitClassifier.js';
import { RateLimitEngine } from './rateLimitEngine.js';
import { CrashRecoveryEngine } from './crashRecoveryEngine.js';
import { ProcessSupervisor } from './processSupervisor.js';
import { LoopBreaker, BreakerAction } from './loopBreaker.js';
import { detectBlockedState } from './blockedPatterns.js';
import { deriveExitReason } from './exitReason.js';
import { ProgressEngine, sampleChanges } from '../progress/progressEngine.js';
import { ProgressLedger } from '../progress/progressLedger.js';
import { writeDiagnosticReport } from '../report/diagnosticReport.js';
import { SessionState } from '../state/sessionManager.js';
import { sleep, formatDuration } from '../infra/time.js';
import { isLegacyMission } from '../mission/missionPlan.js';
import { TaskQueue } from '../mission/taskQueue.js';
import { buildCheckpoint } from '../mission/checkpoint.js';
import { runVerifiers } from '../verify/verifierRegistry.js';
import { buildLegacyContinuation, buildTaskContinuation } from '../briefing/continuationBuilder.js';
import { MemoryStore } from '../memory/memoryStore.js';
import { AgentRegistry } from '../agents/agentRegistry.js';
import { AgentHealth } from '../agents/agentHealth.js';
import { selectAgent } from '../agents/agentRouter.js';
import { effectiveApprovalConfig } from '../approvals/approvalPolicy.js';
import { buildImplementationSummary } from '../approvals/implementationSummary.js';
import { buildMissionCard } from '../notifications/missionCard.js';
import { isSimulatedProject } from '../drivers/simulation.js';
import { userFacingError } from '../infra/errors.js';

/**
 * Domain events emitted by the orchestrator.
 * Payloads always include `project`; most include the session record.
 */
export const EVENTS = Object.freeze([
  'session:launched', //  { project, session, pid, resumed }
  'session:exit', //      { project, session, verdict, exitInfo }
  'session:rate-limited', // { project, session, resumeAt, waitMs }
  'session:network-error', // { project, session, retryInMs }
  'session:crashed', //   { project, session, consecutiveCrashes, restartInMs }
  'session:resumed', //   { project, session }
  'session:gave-up', //   { project, session, reason }
  'session:recovered', // { project, session, after }
  'session:progress', //  { project, session, progressed, method }
  'mission:blocked', //   { project, session, reason, category, reportPath }
  'mission:complete', //  { project, session, summary }
  'task:done', //         { project, session, taskId, checkpoint }
  'agent:assigned', //    Phase 9: { project, session, taskId, agentId, role, reason }
  'task:verification-failed', // Phase 10F: { project, session, taskId, attempt, maxRuns, failedChecks }
]);

export class Orchestrator extends EventEmitter {
  /**
   * All collaborators are injected — nothing here builds its own
   * dependencies, which keeps the loop unit-testable with fakes.
   *
   * @param {object} deps
   * @param {import('../config/configManager.js').ConfigManager} deps.configManager
   * @param {import('../drivers/driverRegistry.js').DriverRegistry} deps.driverRegistry
   * @param {import('../state/sessionManager.js').SessionManager} deps.sessionManager
   * @param {import('../state/statusManager.js').StatusManager} deps.statusManager
   * @param {object} deps.paths - Resolved runtime paths (ledgerDir, diagnosticsDir).
   * @param {object} deps.logger - Module logger.
   * @param {import('../approvals/approvalManager.js').ApprovalManager} [deps.approvalManager] -
   *   Phase 10A: optional. Absent ⇒ no approval gating anywhere (pre-P10
   *   behavior, byte-for-byte — every existing harness constructs without it).
   * @param {import('../mission/missionLifecycle.js').MissionLifecycle} [deps.lifecycle] -
   *   Phase 10D: optional lifecycle recorder (observability only).
   * @param {import('../coordination/resourceLocks.js').ResourceLockManager} [deps.resourceLocks] -
   *   Phase 10H: optional cross-mission resource locks.
   * @param {import('../coordination/agentMessages.js').AgentMessageBus} [deps.messageBus] -
   *   Phase 10H: optional cross-agent message bus.
   */
  constructor({
    configManager, driverRegistry, sessionManager, statusManager, paths, logger,
    approvalManager, lifecycle, resourceLocks, messageBus,
  }) {
    super();
    this.configManager = configManager;
    this.driverRegistry = driverRegistry;
    this.sessionManager = sessionManager;
    this.statusManager = statusManager;
    this.paths = paths ?? configManager.getPaths?.() ?? {};
    this.logger = logger;

    const config = configManager.getAll();
    this.rateLimitEngine = new RateLimitEngine({
      config: config.rateLimit,
      logger,
    });
    this.crashRecovery = new CrashRecoveryEngine({
      config: config.recovery,
      logger,
    });
    this.supervisor = new ProcessSupervisor({
      logger,
      childScanIntervalMs: config.supervision.childProcessScanIntervalMs,
    });
    this.networkRetryDelayMs = config.recovery.networkRetryDelayMs;

    // Progress awareness & loop prevention. `progress` may be absent in
    // hand-built test configs; fall back to safe, effectively-off values.
    // The effective config is re-derived per project in runProject() so a
    // project can override the global progress settings (P1).
    this.globalProgressConfig = config.progress ?? {
      enabled: false,
      maxConsecutiveNoProgress: Infinity,
      interRunDelayMs: 0,
      blockedDetection: false,
    };
    this.progressConfig = this.globalProgressConfig;
    this.loopBreaker = new LoopBreaker({ config: this.progressConfig, logger });
    this.progressLedger = new ProgressLedger({
      ledgerDir: this.paths.ledgerDir,
      logger,
    });
    this.progressEngine = new ProgressEngine({
      progressDir: this.paths.progressDir,
      logger,
      ...(this.globalProgressConfig.ignoreDirs
        ? { ignoreDirs: this.globalProgressConfig.ignoreDirs }
        : {}),
    });

    // Phase P5: cross-session project memory (notes, failure catalog,
    // archived task history). Degrades to a safe no-op when paths.memoryDir
    // is unset (hand-built test configs that predate this phase).
    this.memoryStore = new MemoryStore({ memoryDir: this.paths.memoryDir, logger });

    // Phase P2: mission mode (ordered tasks). Unused (missionMode stays
    // false, taskQueueState stays null) for legacy single-prompt projects.
    this.taskQueueStore = new TaskQueue({
      tasksDir: this.paths.tasksDir, logger, memoryStore: this.memoryStore,
    });
    this.missionMode = false;
    this.taskQueueState = null;

    // Phase 9: multi-agent layer. AgentRegistry sits on top of the driver
    // registry; when no agents are configured (paths.agentsFile absent, or
    // no agents.json), every project routes to a single implicit agent
    // wrapping project.driver — byte-for-byte legacy behavior. AgentHealth
    // degrades to a safe no-op when paths.agentHealthFile is unset.
    this.agentRegistry = new AgentRegistry({
      driverRegistry: this.driverRegistry, logger, agentsFile: this.paths.agentsFile,
    });
    this.agentHealth = new AgentHealth({ healthFile: this.paths.agentHealthFile, logger });
    // The driver of the agent handling the current run — used for
    // engine-specific blocked-state patterns (see blockedPatternsFor).
    this.currentDriver = null;

    // Phase P4: the Continuation Builder. Off (falls back to the static
    // continuePrompt string) in hand-built test configs that omit it.
    this.briefingConfig = config.briefing ?? { enabled: false, recentRunCount: 0 };

    // Phase 10: all optional — absent collaborators degrade to exactly the
    // pre-Phase-10 behavior (no gates, no lifecycle records, no locks, no
    // messages), which is what keeps all prior tests and projects intact.
    this.approvalManager = approvalManager ?? null;
    this.lifecycle = lifecycle ?? null;
    this.resourceLocks = resourceLocks ?? null;
    this.messageBus = messageBus ?? null;
    this.approvalsConfig = config.approvals ?? { enabled: false };
    this.coordinationConfig = config.coordination ?? {};

    this.stopRequested = false;
    this.stopController = new AbortController();
    this.activeRun = null;
  }

  /**
   * Supervise a project until its mission completes or a stop is requested.
   *
   * @param {string} projectName
   * @param {object} [options]
   * @param {string} [options.recoveredAfter] - Set when startup recovery
   *   detected an unclean shutdown ('reboot-or-power-loss').
   * @returns {Promise<{complete: boolean, session: object, reason: string}>}
   */
  async runProject(projectName, options = {}) {
    try {
      return await this.superviseProject(projectName, options);
    } finally {
      // Phase 10H: whatever ended this mission (completion, block, stop,
      // crash of the supervision code itself), never leave locks behind.
      this.resourceLocks?.releaseAll({ project: projectName });
    }
  }

  /** The supervision loop proper (see {@link runProject}). */
  async superviseProject(projectName, { recoveredAfter } = {}) {
    this.lifecycle?.transition(projectName, 'received',
      recoveredAfter ? `recovered after ${recoveredAfter}` : 'mission start requested');
    const project = this.configManager.getProject(projectName);
    this.lifecycle?.transition(projectName, 'analyzed',
      `project validated; mode: ${this.approvalManager?.modeFor(project) ?? 'n/a'}`);

    // Effective progress config: a project may override the global settings
    // (P1). Re-init the loop breaker with the merged threshold.
    this.progressConfig = { ...this.globalProgressConfig, ...(project.progress ?? {}) };
    this.loopBreaker = new LoopBreaker({ config: this.progressConfig, logger: this.logger });

    // Phase 9: the driver is now resolved PER TASK from the routed agent
    // (see the loop below). Before touching any session state, fail fast if
    // the DEFAULT agent's engine is absent — this preserves the existing
    // upfront installation guarantee for the common single-agent case. Other
    // agents (mission mode) are verified lazily on first use.
    const defaultAgent = this.agentRegistry.defaultFor(project);
    const defaultDriver = this.agentRegistry.driverFor(defaultAgent);
    const installation = await this.agentHealth.check(
      defaultAgent, defaultDriver, this.agentRegistry.effectiveProject(project, defaultAgent)
    );
    if (!installation.ok) {
      // Environment problem with a stated remedy, not a bug: the CLI
      // renders it without a stack trace (see fail() in cli/index.js).
      throw userFacingError({
        cause: `Cannot start "${projectName}" — its engine is not available: ${installation.error}`,
        fix: 'run "ai-orchestrator doctor" to check every project\'s engine at once.',
      });
    }
    this.logger.info('Engine verified', {
      agent: defaultAgent.id,
      driver: defaultDriver.id,
      version: installation.version,
    });

    // Resume an interrupted session when one exists; otherwise start fresh.
    let session = this.sessionManager.getResumableSession(projectName);
    const resumedExisting = Boolean(session);
    if (session) {
      this.logger.info('Resuming interrupted session', {
        project: projectName,
        sessionId: session.id,
        previousState: session.state,
        engineSessionId: session.engineSessionId,
      });
      this.emit('session:recovered', {
        project: projectName,
        session,
        after: recoveredAfter ?? `previous state: ${session.state}`,
      });
    } else {
      session = this.sessionManager.createSession(projectName, project.driver);
    }

    this.statusManager.set({ orchestrator: { state: 'supervising' } });
    this.statusManager.syncSession(session);

    // Baseline the workspace BEFORE the first launch so that a first run which
    // changes nothing counts as no-progress immediately (rather than getting a
    // free "progress" pass for merely establishing a baseline). Only when the
    // session has no prior signature — a resumed session keeps its own.
    if (this.progressConfig.enabled && session.lastSignature == null) {
      const baselineHash = this.progressEngine.baseline(project);
      if (baselineHash !== null) {
        this.sessionManager.update(session, { lastSignature: baselineHash });
      }
    }

    // Phase P2: mission mode. A project with `tasks` walks an ordered plan;
    // a project without one behaves exactly as v1/P0/P1 (isLegacyMission).
    // Phase P3: OR a persisted queue whose current task is still PENDING/
    // ACTIVE already exists — e.g. tasks queued via the `tasks add` CLI on
    // an otherwise-legacy project, which never touches the static config
    // file at all. A BLOCKED/FAILED/fully-complete queue does NOT count —
    // only genuinely resumable work switches on mission mode by itself.
    const existingQueue = this.taskQueueStore.load(project.name);
    this.missionMode = !isLegacyMission(project)
      || Boolean(existingQueue && this.taskQueueStore.currentIsResumable(existingQueue));
    this.taskQueueState = this.missionMode
      ? this.taskQueueStore.getOrInitialize(project.name, project.tasks, session.id)
      : null;
    this.statusManager.syncTaskQueue(this.taskQueueState);
    this.lifecycle?.transition(project.name, 'planned', this.missionMode
      ? `plan loaded: ${this.taskQueueState.tasks.length} task(s)`
      : 'single-prompt mission');

    // Defensive: a fully-advanced queue with a still-open session means the
    // mission finished but the session was never closed out (e.g. a crash
    // between the last task's completion and session close). Treat it as
    // complete rather than looping with no current task.
    if (this.missionMode && this.taskQueueStore.isComplete(this.taskQueueState)) {
      this.sessionManager.closeSession(session, SessionState.COMPLETED);
      this.statusManager.syncSession(session);
      this.statusManager.set({ orchestrator: { state: 'mission-complete' } });
      const reason = 'all tasks already completed';
      this.emit('mission:complete', {
        project: project.name, session, summary: 'All tasks were already complete.',
        card: buildMissionCard({
          project: project.name, session, queue: this.taskQueueState,
          status: 'complete', reason, workingDirectory: project.workingDirectory,
          simulated: isSimulatedProject(project),
        }),
      });
      return { complete: true, session, reason };
    }

    // Crash counting is per-process-lifetime: a reboot or manual restart
    // grants a fresh set of attempts (the human/scheduler chose to retry).
    let consecutiveCrashes = 0;
    let lastActivity = resumedExisting ? 'resumed after interruption' : 'starting mission';

    // Phase 9: agents whose engine we've verified this process-lifetime (the
    // default was checked upfront) — so a mid-mission agent is probed once,
    // not on every launch.
    const verifiedAgents = new Set([defaultAgent.id]);

    while (!this.stopRequested) {
      // Safety valve: bounded number of launches when the project asks for it.
      const { maxRuns } = project.mission;
      if (maxRuns > 0 && session.runs >= maxRuns) {
        return this.giveUp(
          project,
          session,
          `Reached the configured maximum of ${maxRuns} runs before mission completion.`
        ).result;
      }

      // ── Phase 9: route this launch to an agent ──────────────────────────
      // Mission mode routes per the CURRENT task's hints (agent/role/
      // capabilities); legacy mode always uses the project's default agent.
      // For an agent-less project both resolve to the implicit default that
      // wraps project.driver, so nothing changes for existing projects.
      const currentTask = this.missionMode
        ? this.taskQueueStore.current(this.taskQueueState)
        : null;
      const { agent, reason: routeReason } = this.missionMode
        ? selectAgent(currentTask, this.agentRegistry, project)
        : { agent: defaultAgent, reason: 'default' };
      const driver = this.agentRegistry.driverFor(agent);
      const effProject = this.agentRegistry.effectiveProject(project, agent);
      this.currentDriver = driver;

      // Verify a newly-introduced agent's engine before its first use. A
      // missing engine blocks clearly rather than crash-looping on launch.
      if (!verifiedAgents.has(agent.id)) {
        // eslint-disable-next-line no-await-in-loop
        const health = await this.agentHealth.check(agent, driver, effProject);
        verifiedAgents.add(agent.id);
        if (!health.ok) {
          return this.block(project, session, {
            reason: `Agent "${agent.id}" engine unavailable: ${health.error}`,
            category: 'agent-unavailable',
            hint: `Check this agent's driver/command. ${health.error}`,
            taskId: currentTask?.id ?? null,
          }).result;
        }
      }

      // ── Phase 10A: approval gate before a task's FIRST launch ──────────
      // A task carrying an `approval` category asks the Approval Manager
      // before it ever runs; owner-gated categories pause here until the
      // owner decides. Absent manager / no category ⇒ nothing changes.
      if (this.missionMode && currentTask) {
        // eslint-disable-next-line no-await-in-loop
        const gate = await this.gateTaskApproval({ project, session, taskEntry: currentTask });
        if (!gate.proceed) return gate.result;
      }

      // ── Phase 10H: cross-mission resource locks ─────────────────────────
      // A task declaring `resources` waits (abortably) until every one is
      // free — this is what keeps two parallel missions out of the same
      // shared resource.
      if (this.missionMode && currentTask?.resources?.length) {
        // eslint-disable-next-line no-await-in-loop
        const locked = await this.acquireTaskResources({ project, session, task: currentTask });
        if (!locked) break; // operator stop while waiting; loop exit handles it
      }

      // Agent switch: never resume a DIFFERENT agent's engine conversation.
      // Record the current agent on the session (and drop the stale engine id
      // when switching) so the new agent starts a fresh conversation.
      const agentChanged = Boolean(session.currentAgentId) && session.currentAgentId !== agent.id;
      if (agentChanged || !session.currentAgentId) {
        this.sessionManager.update(session, {
          currentAgentId: agent.id,
          ...(agentChanged ? { engineSessionId: null } : {}),
        });
      }
      const engineSessionId = agentChanged ? null : session.engineSessionId;

      // Fresh sessions get the mission prompt; resumed conversations get the
      // continue prompt (the engine already holds the full history). In
      // mission mode, "fresh" is decided per TASK (attempts === 0), not per
      // session — a later task's first launch still resumes the same engine
      // conversation (unless the agent changed), but introduces ITS OWN prompt.
      const engineIsFresh = !engineSessionId;
      // Phase 10H: unread cross-agent messages for the routed agent are
      // folded into whatever prompt this launch uses, then marked consumed.
      const inbox = this.messageBus
        ? this.messageBus.unreadFor(project.name, { agentId: agent.id, role: agent.role })
        : [];
      let prompt;
      let activeTaskId = null;
      if (this.missionMode) {
        // The queue entry IS the task's full definition + runtime state —
        // no lookup against static config, so a CLI-enqueued task (never
        // declared in project.tasks) works with no special-casing.
        const taskEntry = currentTask;
        activeTaskId = taskEntry.id;
        taskEntry.assignedAgentId = agent.id; // recorded on the queue entry
        const taskIsFresh = taskEntry.attempts === 0;
        prompt = taskIsFresh
          ? fs.readFileSync(taskEntry.resolvedPromptFile, 'utf8')
            + freshPromptAppendix({ messages: inbox, approvalNote: taskEntry.approvalNote })
          : this.buildContinuationPrompt({
            project, task: taskEntry, reason: lastActivity, agentMessages: inbox,
          });
        this.taskQueueStore.recordAttempt(this.taskQueueState);
        this.statusManager.syncTaskQueue(this.taskQueueState);
      } else {
        prompt = engineIsFresh
          ? fs.readFileSync(project.resolvedPromptFile, 'utf8')
            + freshPromptAppendix({ messages: inbox })
          : this.buildContinuationPrompt({ project, reason: lastActivity });
      }
      if (inbox.length) {
        this.messageBus.markRead(project.name, inbox.map((m) => m.id), agent.id);
      }

      this.agentHealth.markUsed(agent.id);
      this.statusManager.set({ mission: { currentAgent: agent.id, currentAgentRole: agent.role } });
      this.emit('agent:assigned', {
        project: project.name, session, taskId: activeTaskId,
        agentId: agent.id, role: agent.role, reason: routeReason,
      });
      this.lifecycle?.transition(project.name, 'agents-assigned',
        `${agent.id} (${agent.role}) ← ${routeReason}`);

      this.sessionManager.update(session, {
        state: SessionState.RUNNING,
        runs: session.runs + 1,
        resumeAt: null,
        lastActivity,
      });
      this.statusManager.syncSession(session);

      let run;
      try {
        run = await driver.launch({
          project: effProject,
          prompt,
          engineSessionId,
        });
      } catch (error) {
        return this.giveUp(project, session, `Engine launch failed: ${error.message}`).result;
      }

      this.observeRun(run, project, session);
      this.emit('session:launched', {
        project: project.name,
        session,
        pid: run.pid,
        resumed: !engineIsFresh,
        taskId: activeTaskId,
      });
      this.lifecycle?.transition(project.name, 'executing',
        activeTaskId ? `task "${activeTaskId}" running on ${agent.id}` : `running on ${agent.id}`);

      // ── The heart of the safety rules ─────────────────────────────────
      // The agent is alive: we wait. No timeouts, no health-kills, no
      // nudging. Hours of silence are its business, not ours.
      const exitInfo = await run.waitForExit();
      // ──────────────────────────────────────────────────────────────────

      this.activeRun = null;
      this.supervisor.unwatch();
      this.agentHealth.recordRun(agent.id, exitInfo.durationMs); // Phase 10H utilization
      lastActivity = this.statusManager.get().activity.currentTask ?? lastActivity;

      const verdict = classifyExit(exitInfo, driver.exitPatterns);
      this.logger.info('Agent exited — classified', {
        project: project.name,
        cause: verdict.cause,
        detail: verdict.detail,
        code: exitInfo.code,
        signal: exitInfo.signal,
        runtime: formatDuration(exitInfo.durationMs),
      });

      // Measure objective progress and record the run — for EVERY exit, so
      // the ledger is a complete audit trail and the loop breaker has data.
      // Runs first so lastExit can carry the standardized outcome.
      const finalText = `${exitInfo.resultText ?? ''}\n${exitInfo.outputTail ?? ''}`;
      const progress = this.assessProgress({ project, session, verdict, exitInfo, finalText });

      this.sessionManager.update(session, {
        lastExit: {
          at: new Date().toISOString(),
          cause: verdict.cause,
          exitReason: progress.exitReason,
          detail: verdict.detail,
          code: exitInfo.code,
          signal: exitInfo.signal,
          durationMs: exitInfo.durationMs,
          progressed: progress.progressed,
          confidence: progress.confidence.level,
        },
      });
      this.statusManager.set({ agent: { state: 'exited', pid: null, childPids: [] } });
      this.emit('session:exit', {
        project: project.name, session, verdict, exitInfo, exitReason: progress.exitReason,
      });

      // Operator stop wins over every recovery strategy; the session record
      // keeps its resumable state so the mission continues next start.
      if (this.stopRequested) break;

      const outcome = await this.applyRecoveryStrategy({
        project,
        session,
        driver,
        verdict,
        exitInfo,
        finalText,
        progress,
        consecutiveCrashes,
      });

      if (outcome.done) return outcome.result;
      consecutiveCrashes = outcome.consecutiveCrashes;
      lastActivity = outcome.lastActivity ?? lastActivity;
    }

    // Stopped by the operator: leave the session resumable and say so.
    this.logger.info('Supervision stopped by request; session preserved', {
      project: project.name,
      sessionId: session.id,
      state: session.state,
    });
    this.lifecycle?.transition(project.name, 'cancelled',
      'stopped by operator (session preserved — the next start resumes)');
    return { complete: false, session, reason: 'stopped by operator' };
  }

  /**
   * Apply the recovery strategy for one classified exit.
   * Returns { done, result? } when supervision should end, otherwise the
   * updated crash counter (and the loop launches again).
   */
  async applyRecoveryStrategy({
    project, session, driver, verdict, exitInfo, finalText, progress, consecutiveCrashes,
  }) {
    const signal = this.stopController.signal;

    switch (verdict.cause) {
      case ExitCause.COMPLETED: {
        // Mission mode: completion is per-TASK (verified, not marker-only)
        // and finishing a task advances the plan rather than ending the run.
        if (this.missionMode) {
          return this.handleTaskCompletion({ project, session, exitInfo, finalText, progress, signal });
        }

        // Phase 10A (legacy missions get the same protections as tasks): a
        // presented plan pauses for review; a human-action situation pauses
        // for the owner instead of terminally blocking.
        const plan = await this.maybeReviewPlan({
          project, session, finalText, taskId: null, signal,
        });
        if (plan.handled) return plan.outcome;

        // Did the agent declare the whole MISSION finished (not just this
        // run)? Checked BEFORE the human-action pause: the explicit
        // completion contract outranks fuzzy blocked-pattern matching — a
        // final message like "captcha cleared — MISSION COMPLETE" must end
        // the mission, not page the owner on every relaunch forever (the
        // livelock found live in the Phase 10.5 failure simulations).
        const marker = project.mission.completionMarker;
        if (marker && finalText.includes(marker)) {
          this.sessionManager.closeSession(session, SessionState.COMPLETED);
          this.statusManager.syncSession(session);
          this.statusManager.set({ orchestrator: { state: 'mission-complete' } });
          const summary = exitInfo.resultText ?? 'Mission complete.';
          this.logger.info('Mission complete', { project: project.name });
          this.lifecycle?.transition(project.name, 'completed', 'completion marker found');
          this.emit('mission:complete', {
            project: project.name, session, summary,
            // Legacy (no-tasks) mode has no per-task queue to summarize —
            // the card still carries duration/commit/reason, just no
            // files/tests aggregation (there's nothing to aggregate from).
            card: buildMissionCard({
              project: project.name, session, status: 'complete',
              reason: 'completion marker found', workingDirectory: project.workingDirectory,
              simulated: isSimulatedProject(project),
            }),
          });
          return {
            done: true,
            result: { complete: true, session, reason: 'completion marker found' },
          };
        }

        // No completion marker: a human-action situation (login, CAPTCHA,
        // browser prompt, ...) pauses for the owner instead of terminally
        // blocking.
        const human = await this.maybePauseForHumanAction({
          project, session, blocked: progress.blocked, taskId: null, signal,
        });
        if (human.handled) return human.outcome;

        // Run ended cleanly but the mission is unfinished. Before relaunching,
        // the loop breaker decides whether continuing is worthwhile — this is
        // the guard that makes an unbounded no-progress loop impossible.
        if (this.progressConfig.enabled) {
          if (!progress.progressed) {
            this.sessionManager.update(session, {
              consecutiveNoProgress: session.consecutiveNoProgress + 1,
            });
          }
          const decision = this.loopBreaker.decide({
            progressed: progress.progressed,
            consecutiveNoProgress: session.consecutiveNoProgress,
            blocked: progress.blocked,
          });
          if (decision.action === BreakerAction.TRIP) {
            // Return the { done, result } shape applyRecoveryStrategy owes its
            // caller — NOT .result, or runProject won't see done and will loop.
            return this.block(project, session, {
              reason: decision.reason,
              category: decision.category,
              hint: decision.hint ?? progress.blocked?.hint,
              evidence: progress.blocked?.evidence,
            });
          }
        }

        // Cleared the breaker: pause (inter-run delay), then continue the
        // same conversation. The delay is abortable by an operator stop.
        await this.interRunDelay(signal);
        if (this.stopRequested) return this.stoppedMidWait(session);

        this.resumeSession(
          session,
          progress.progressed
            ? 'progress made; continuing mission'
            : 'run finished; mission not complete — continuing'
        );
        return { done: false, consecutiveCrashes: 0, lastActivity: 'continuing mission' };
      }

      case ExitCause.USAGE_LIMIT: {
        const { resumeAt, waitMs } = this.rateLimitEngine.computeWait({
          driver,
          outputTail: `${exitInfo.outputTail ?? ''}\n${exitInfo.resultText ?? ''}`,
        });
        this.sessionManager.update(session, {
          state: SessionState.WAITING_RATE_LIMIT,
          rateLimits: session.rateLimits + 1,
          resumeAt: resumeAt.toISOString(),
          lastActivity: `waiting out usage limit (${formatDuration(waitMs)})`,
        });
        this.statusManager.syncSession(session);
        this.emit('session:rate-limited', {
          project: project.name,
          session,
          resumeAt,
          waitMs,
        });

        const waitResult = await this.rateLimitEngine.waitUntil(resumeAt, { signal });
        if (waitResult === 'aborted') return this.stoppedMidWait(session);

        this.resumeSession(session, 'usage limit reset; resuming');
        return { done: false, consecutiveCrashes, lastActivity: 'resumed after usage limit' };
      }

      case ExitCause.NETWORK: {
        this.sessionManager.update(session, {
          state: SessionState.WAITING_RETRY,
          lastActivity: `network problem; retrying in ${formatDuration(this.networkRetryDelayMs)}`,
        });
        this.statusManager.syncSession(session);
        this.emit('session:network-error', {
          project: project.name,
          session,
          retryInMs: this.networkRetryDelayMs,
        });

        await sleep(this.networkRetryDelayMs, signal);
        if (this.stopRequested) return this.stoppedMidWait(session);

        this.resumeSession(session, 'retrying after network problem');
        return { done: false, consecutiveCrashes, lastActivity: 'retrying after network problem' };
      }

      case ExitCause.SPAWN_FAILURE:
        return this.giveUp(project, session, verdict.detail);

      case ExitCause.INTERRUPTED: // external kill (not our operator) → crash path
      case ExitCause.CRASH:
      default: {
        const crashes = consecutiveCrashes + 1;
        this.sessionManager.update(session, { crashes: session.crashes + 1 });

        const decision = this.crashRecovery.decide({ consecutiveCrashes: crashes });
        if (decision.action === 'give-up') {
          return this.giveUp(project, session, decision.reason);
        }

        this.sessionManager.update(session, {
          state: SessionState.WAITING_RETRY,
          lastActivity: `crashed; restarting in ${formatDuration(decision.delayMs)}`,
        });
        this.statusManager.syncSession(session);
        this.emit('session:crashed', {
          project: project.name,
          session,
          consecutiveCrashes: crashes,
          restartInMs: decision.delayMs,
        });

        await sleep(decision.delayMs, signal);
        if (this.stopRequested) return this.stoppedMidWait(session);

        this.resumeSession(session, 'restarting after crash');
        return { done: false, consecutiveCrashes: crashes, lastActivity: 'restarting after crash' };
      }
    }
  }

  /**
   * Phase P2: handle a COMPLETED exit while in mission mode. The current
   * task's verifiers — not the agent's say-so — decide whether the task is
   * done. A task with no verifiers falls back to the mission completion
   * marker as a lightweight per-task signal (documented, not accidental).
   *
   * Passing verification advances to the next task (or ends the mission,
   * mirroring the legacy marker-hit ending, once every task is done).
   * Failing verification retries the SAME task up to its own `maxRuns`
   * budget; exhausting it — like a detected stagnation loop — routes to
   * `block()` rather than silently skipping unverified work.
   */
  async handleTaskCompletion({ project, session, exitInfo, finalText, progress, signal }) {
    const queue = this.taskQueueState;
    // The queue entry carries the full task definition (see
    // TaskQueue#toQueueEntry) — taskEntry and "the task" are the same thing.
    const taskEntry = this.taskQueueStore.current(queue);
    const taskDef = taskEntry;

    // Phase 10A: a run that PRESENTED AN IMPLEMENTATION PLAN is reviewed,
    // not verified — the plan marker explicitly means "nothing implemented
    // yet; here is what I intend to do".
    const plan = await this.maybeReviewPlan({
      project, session, finalText, taskId: taskDef.id, signal,
    });
    if (plan.handled) return plan.outcome;

    this.lifecycle?.transition(project.name, 'verifying', `task "${taskDef.id}" run finished`);

    const verifyResult = taskDef.verify.length > 0
      ? runVerifiers(taskDef.verify, {
        workingDirectory: project.workingDirectory,
        resultText: exitInfo.resultText,
        outputTail: exitInfo.outputTail,
        changes: progress.changes,
      })
      : markerFallbackVerify(project.mission.completionMarker, finalText);

    // Phase P4: record on EVERY outcome (pass, retry, or exhausted) so the
    // Continuation Builder can tell the agent exactly why its last attempt
    // on THIS task wasn't accepted, even mid-retry.
    this.taskQueueStore.recordVerifyResult(queue, verifyResult);

    // Phase 10A: a human-action situation (login, CAPTCHA, browser prompt,
    // ...) pauses gracefully — notify the owner, wait for DONE, continue —
    // instead of the terminal block those categories used to hit. Checked
    // only for runs that FAILED verification: verified work is done no
    // matter what the output mentioned — explicit verification outranks
    // fuzzy pattern-matching (the livelock found in the Phase 10.5 sims).
    if (!verifyResult.passed) {
      const human = await this.maybePauseForHumanAction({
        project, session, blocked: progress.blocked, taskId: taskDef.id, signal,
      });
      if (human.handled) return human.outcome;
    }

    // Phase 10F: verification failures are notifiable events (severity:
    // warning), computed once here for the event, the exhausted-path block
    // reason, and the logs. (A run that instead paused as a human-action
    // above already notified the owner with the actionable message.)
    const failedChecks = verifyResult.passed ? '' : verifyResult.results
      .filter((r) => !r.passed).map((r) => `${r.type}: ${r.detail}`).join('; ');
    if (!verifyResult.passed) {
      this.emit('task:verification-failed', {
        project: project.name, session, taskId: taskDef.id,
        attempt: taskEntry.attempts, maxRuns: taskDef.maxRuns, failedChecks,
      });
    }

    if (verifyResult.passed) {
      const checkpoint = buildCheckpoint({
        task: taskDef, attempts: taskEntry.attempts, changes: progress.changes,
        verifyResult, resultText: exitInfo.resultText, outcome: 'done',
      });
      checkpoint.agentId = session.currentAgentId; // Phase 9: who did it
      this.taskQueueStore.markDone(queue, checkpoint);
      this.agentHealth.recordOutcome(session.currentAgentId, 'done', taskEntry.attempts);
      this.logger.info('Task completed and verified', {
        project: project.name, taskId: taskDef.id, attempts: taskEntry.attempts,
        agent: session.currentAgentId,
      });
      this.emit('task:done', { project: project.name, session, taskId: taskDef.id, checkpoint });

      // Phase 10H: release this task's resource locks the moment it is done.
      this.resourceLocks?.releaseAll({ project: project.name, taskId: taskDef.id });

      this.taskQueueStore.advance(queue);
      this.statusManager.syncTaskQueue(queue);

      if (this.taskQueueStore.isComplete(queue)) {
        this.sessionManager.closeSession(session, SessionState.COMPLETED);
        this.statusManager.syncSession(session);
        this.statusManager.set({ orchestrator: { state: 'mission-complete' } });
        const summary = exitInfo.resultText ?? 'Mission complete.';
        const reason = 'all tasks completed and verified';
        this.logger.info('Mission complete (all tasks done)', { project: project.name });
        this.lifecycle?.transition(project.name, 'completed', reason);
        this.emit('mission:complete', {
          project: project.name, session, summary,
          card: buildMissionCard({
            project: project.name, session, queue, status: 'complete',
            reason, workingDirectory: project.workingDirectory,
            simulated: isSimulatedProject(project),
          }),
        });
        return { done: true, result: { complete: true, session, reason } };
      }

      await this.interRunDelay(signal);
      if (this.stopRequested) return this.stoppedMidWait(session);

      const nextTask = this.taskQueueStore.current(queue);
      // Phase 10H: when the next task routes to a DIFFERENT agent, leave it
      // an explicit handoff note (folded into that agent's first briefing).
      if (this.messageBus && session.currentAgentId) {
        const { agent: nextAgent } = selectAgent(nextTask, this.agentRegistry, project);
        if (nextAgent.id !== session.currentAgentId) {
          this.messageBus.post(project.name, {
            from: session.currentAgentId,
            to: nextAgent.id,
            topic: 'handoff',
            text: `Task "${taskDef.id}" is done after ${taskEntry.attempts} attempt(s). ` +
              `${checkpoint.summary || 'No summary was produced.'}`,
          });
        }
      }
      this.resumeSession(session, `task "${taskDef.id}" done; starting task "${nextTask.id}"`);
      return { done: false, consecutiveCrashes: 0, lastActivity: `starting task ${nextTask.id}` };
    }

    // Verification failed. The workspace-stagnation breaker still applies
    // as an extra safety net (task-agnostic; see assessProgress()) —
    // repeatedly failing verification with zero workspace change is exactly
    // the "spinning, not working" pattern P0 was built to catch.
    if (this.progressConfig.enabled) {
      if (!progress.progressed) {
        this.sessionManager.update(session, {
          consecutiveNoProgress: session.consecutiveNoProgress + 1,
        });
      }
      const decision = this.loopBreaker.decide({
        progressed: progress.progressed,
        consecutiveNoProgress: session.consecutiveNoProgress,
        blocked: progress.blocked,
      });
      if (decision.action === BreakerAction.TRIP) {
        const checkpoint = buildCheckpoint({
          task: taskDef, attempts: taskEntry.attempts, changes: progress.changes,
          verifyResult, resultText: exitInfo.resultText, outcome: 'blocked',
        });
        checkpoint.agentId = session.currentAgentId; // Phase 9
        this.taskQueueStore.markBlocked(queue, checkpoint);
        this.agentHealth.recordOutcome(session.currentAgentId, 'blocked', taskEntry.attempts);
        this.statusManager.syncTaskQueue(queue);
        return this.block(project, session, {
          reason: decision.reason,
          category: decision.category,
          hint: decision.hint ?? progress.blocked?.hint,
          evidence: progress.blocked?.evidence,
          taskId: taskDef.id,
        });
      }
    }

    if (taskEntry.attempts < taskDef.maxRuns) {
      await this.interRunDelay(signal);
      if (this.stopRequested) return this.stoppedMidWait(session);

      this.lifecycle?.transition(project.name, 'fixing',
        `task "${taskDef.id}" attempt ${taskEntry.attempts}/${taskDef.maxRuns} failed verification`);
      this.resumeSession(
        session,
        `task "${taskDef.id}" verification failed ` +
        `(attempt ${taskEntry.attempts}/${taskDef.maxRuns}); retrying`
      );
      return { done: false, consecutiveCrashes: 0, lastActivity: `retrying task ${taskDef.id}` };
    }

    // Retries exhausted: never silently move on from unverified work.
    const checkpoint = buildCheckpoint({
      task: taskDef, attempts: taskEntry.attempts, changes: progress.changes,
      verifyResult, resultText: exitInfo.resultText, outcome: 'failed',
    });
    checkpoint.agentId = session.currentAgentId; // Phase 9
    this.taskQueueStore.markFailed(queue, checkpoint);
    this.agentHealth.recordOutcome(session.currentAgentId, 'failed', taskEntry.attempts);
    this.statusManager.syncTaskQueue(queue);
    return this.block(project, session, {
      reason: `Task "${taskDef.id}" failed verification after ${taskEntry.attempts} ` +
        `attempts (max ${taskDef.maxRuns}).`,
      category: 'verification-failed',
      hint: `Review the task's objective and verifiers. Failed checks: ${failedChecks}`,
      evidence: failedChecks,
      taskId: taskDef.id,
    });
  }

  /**
   * Measure whether this run advanced the workspace, update the session's
   * progress counters, detect blocked states, classify the run's outcome
   * (exitReason) with a confidence score, and record it all in the ledger.
   * Runs once per exit, for every cause.
   *
   * @returns {{progressed, signature, method, blocked, confidence, exitReason}}
   */
  assessProgress({ project, session, verdict, exitInfo, finalText }) {
    const blocked = this.progressConfig.blockedDetection
      ? detectBlockedState(finalText, this.blockedPatternsFor(project))
      : { blocked: false };

    let progressed = true;
    let report = { hash: session.lastSignature, method: 'skipped', changes: null,
      confidence: { level: 'medium', score: 0.5, signals: [] } };

    if (this.progressConfig.enabled) {
      report = this.progressEngine.analyze(project);
      // FAIL CLOSED: a workspace we cannot measure counts as "no progress",
      // so an environment problem pauses for review instead of looping.
      progressed = report.hash !== null && report.hash !== session.lastSignature;

      const patch = {};
      if (report.hash !== null) patch.lastSignature = report.hash;
      if (progressed) patch.consecutiveNoProgress = 0; // any progress resets the streak
      if (Object.keys(patch).length) this.sessionManager.update(session, patch);
    }

    const confidence = report.confidence;
    const marker = project.mission.completionMarker;
    const exitReason = deriveExitReason({
      cause: verdict.cause,
      markerHit: Boolean(marker && finalText.includes(marker)),
      progressed,
      blocked,
      stopRequested: this.stopRequested,
    });

    this.progressLedger.record({
      project: project.name,
      sessionId: session.id,
      run: session.runs,
      cause: verdict.cause,
      exitReason,
      // Phase 10: run duration + handling agent, for utilization stats,
      // duration estimates (implementation summaries), and self-improvement
      // analysis (slow agents, verification bottlenecks).
      durationMs: exitInfo.durationMs,
      agentId: session.currentAgentId ?? null,
      progressed,
      confidence: confidence.level,
      confidenceScore: confidence.score,
      confidenceSignals: confidence.signals,
      changes: report.changes ? report.changes.counts : undefined,
      // Sampled for compact, human-readable ledger records — verification
      // (files-changed) reads the COMPLETE lists from `report.changes`
      // directly, never this truncated copy.
      changedFiles: report.changes ? sampleChanges(report.changes) : undefined,
      signature: report.hash,
      signatureMethod: report.method,
      consecutiveNoProgress: session.consecutiveNoProgress,
      resultText: exitInfo.resultText ?? '',
      blocked: blocked.blocked ? { category: blocked.category } : undefined,
    });

    this.logger.info('Run progress assessed', {
      project: project.name,
      run: session.runs,
      cause: verdict.cause,
      exitReason,
      progressed,
      confidence: confidence.level,
      method: report.method,
      changes: report.changes ? report.changes.counts : undefined,
      consecutiveNoProgress: session.consecutiveNoProgress,
      blocked: blocked.blocked ? blocked.category : false,
    });
    this.emit('session:progress', {
      project: project.name,
      session,
      progressed,
      method: report.method,
      confidence: confidence.level,
      changes: report.changes,
      exitReason,
    });

    return {
      progressed, signature: report.hash, method: report.method,
      changes: report.changes, blocked, confidence, exitReason,
    };
  }

  /**
   * Phase P4: build the prompt for a continuation (resume/retry), replacing
   * the static continuePrompt with a structured briefing when enabled.
   * Phase P5: folds in cross-session memory — operator notes, unresolved
   * failures, and (task-scoped) any archived history for this task id from
   * an earlier, now-superseded plan.
   */
  buildContinuationPrompt({ project, task, reason, agentMessages = [] }) {
    if (!this.briefingConfig.enabled) {
      return task
        ? (task.continuePrompt ?? project.mission.continuePrompt)
        : project.mission.continuePrompt;
    }
    const recentRuns = this.progressLedger.recent(project.name, this.briefingConfig.recentRunCount ?? 3);
    const memoryNotes = this.memoryStore.recentNotes(project.name);
    const activeFailures = this.memoryStore.activeFailures(project.name);
    if (task) {
      const priorAttempts = this.memoryStore.taskHistoryFor(project.name, task.id);
      return buildTaskContinuation({
        project, queue: this.taskQueueState, task, reason, recentRuns,
        memoryNotes, activeFailures, priorAttempts, agentMessages,
      });
    }
    return buildLegacyContinuation({ project, reason, recentRuns, memoryNotes, activeFailures });
  }

  // ── Phase 10A/10H helpers ─────────────────────────────────────────────

  /**
   * Phase 10A: gate a task's FIRST launch behind its `approval` category.
   * No manager / no category / already granted ⇒ proceed untouched.
   *
   * @returns {Promise<{proceed: boolean, result?: object}>} `result` is the
   *   supervision outcome when the mission must end here (rejection/stop).
   */
  async gateTaskApproval({ project, session, taskEntry }) {
    if (!this.approvalManager || !taskEntry?.approval) return { proceed: true };
    if (taskEntry.approvalGranted || taskEntry.attempts > 0) return { proceed: true };

    const { approved, request } = await this.approvalManager.requestApproval({
      project: project.name,
      category: taskEntry.approval,
      title: `Approval required — task "${taskEntry.id}" (${project.name})`,
      summary:
        `Task "${taskEntry.id}"${taskEntry.objective && taskEntry.objective !== taskEntry.id
          ? ` — ${taskEntry.objective}` : ''}\n` +
        `Category: ${taskEntry.approval}\n` +
        'This task will not run until you decide.',
      taskId: taskEntry.id,
      projectConfig: project,
    });
    if (approved) {
      taskEntry.approvalGranted = true;
      this.taskQueueStore.save(this.taskQueueState);
      return { proceed: true };
    }

    this.statusManager.set({ orchestrator: { state: 'awaiting-approval' } });
    const final = await this.approvalManager.waitForDecision(request, {
      signal: this.stopController.signal,
      projectConfig: project,
    });
    this.statusManager.set({ orchestrator: { state: 'supervising' } });

    if (this.stopRequested || final.status === 'pending') {
      return { proceed: false, result: this.stoppedMidWait(session).result };
    }
    if (final.status === 'approved' || final.status === 'modified') {
      taskEntry.approvalGranted = true;
      if (final.decisionNote) taskEntry.approvalNote = final.decisionNote;
      this.taskQueueStore.save(this.taskQueueState);
      this.logger.info('Task approved by owner', {
        project: project.name, taskId: taskEntry.id, decision: final.status, via: final.via,
      });
      return { proceed: true };
    }
    // Rejected / expired / cancelled: mark the task blocked (so the P7
    // approve/skip operator overrides apply to it) and end the mission.
    this.taskQueueStore.markBlocked(this.taskQueueState, {
      at: new Date().toISOString(),
      taskId: taskEntry.id,
      objective: taskEntry.objective,
      outcome: 'blocked',
      attempts: taskEntry.attempts,
      filesTouched: [],
      filesDeleted: [],
      verify: null,
      summary: `Approval ${request.id} was ${final.status}` +
        (final.decisionNote ? `: ${final.decisionNote}` : '.'),
    });
    this.statusManager.syncTaskQueue(this.taskQueueState);
    return {
      proceed: false,
      result: this.block(project, session, {
        reason: `Task "${taskEntry.id}" approval ${request.id} was ${final.status}` +
          (final.decisionNote ? `: ${final.decisionNote}` : '.'),
        category: 'approval-rejected',
        hint: 'Adjust the task (or its approval category) and use "tasks approve" to retry, ' +
          'or "tasks skip" to advance past it.',
        taskId: taskEntry.id,
      }).result,
    };
  }

  /**
   * Phase 10H: wait (abortably) until every resource the task declares is
   * lockable, then lock them. Returns false only on an operator stop.
   */
  async acquireTaskResources({ project, session, task }) {
    if (!this.resourceLocks || !task?.resources?.length) return true;
    for (;;) {
      const result = this.resourceLocks.acquireAll(task.resources, {
        project: project.name, taskId: task.id, sessionId: session.id, pid: process.pid,
      });
      if (result.ok) return true;

      const holders = result.conflicts
        .map((c) => `${c.resource} (held by ${c.heldBy?.project ?? 'unknown'})`).join(', ');
      this.logger.info('Waiting for locked resources', {
        project: project.name, taskId: task.id, waitingOn: holders,
      });
      this.statusManager.set({ activity: { currentTask: `waiting for resources: ${holders}` } });
      // eslint-disable-next-line no-await-in-loop
      await sleep(this.coordinationConfig.lockPollMs ?? 10_000, this.stopController.signal);
      if (this.stopRequested) return false;
    }
  }

  /**
   * Phase 10A: when a run's final output carries the plan marker, publish
   * an implementation summary for review and pause until the owner
   * decides. Returns `{handled: false}` when no plan was presented (or the
   * approval system is absent/off) — the caller continues as before.
   */
  async maybeReviewPlan({ project, session, finalText, taskId, signal }) {
    const effective = effectiveApprovalConfig(this.approvalsConfig, project);
    if (!this.approvalManager || effective.enabled === false) return { handled: false };
    const marker = effective.planMarker;
    if (!marker || !finalText.includes(marker)) return { handled: false };

    const summary = buildImplementationSummary({
      project: project.name,
      planText: finalText,
      queue: this.taskQueueState,
      averageRunMs: this.averageRunMs(project.name),
      simulated: isSimulatedProject(project),
    });
    const { approved, request } = await this.approvalManager.requestImplementationReview({
      project: project.name, summary, taskId, projectConfig: project,
    });
    if (approved) {
      // Autonomous mode (or policy) let it through — continue immediately.
      this.resumeSession(session, 'implementation plan auto-approved by policy; proceeding');
      return {
        handled: true,
        outcome: { done: false, consecutiveCrashes: 0, lastActivity: 'plan approved — implement it now' },
      };
    }

    this.statusManager.set({ orchestrator: { state: 'awaiting-approval' } });
    const final = await this.approvalManager.waitForDecision(request, { signal, projectConfig: project });
    this.statusManager.set({ orchestrator: { state: 'supervising' } });

    if (this.stopRequested || final.status === 'pending') {
      return { handled: true, outcome: this.stoppedMidWait(session) };
    }
    if (final.status === 'approved' || final.status === 'modified') {
      const note = final.status === 'modified' && final.decisionNote
        ? ` — apply these owner modifications: ${final.decisionNote}`
        : '';
      this.resumeSession(session, `implementation plan ${final.status} (${request.id})${note}`);
      return {
        handled: true,
        outcome: {
          done: false,
          consecutiveCrashes: 0,
          lastActivity: `plan ${final.status} by owner${note}; proceed with the implementation`,
        },
      };
    }
    return {
      handled: true,
      outcome: this.block(project, session, {
        reason: `Implementation plan ${request.id} was ${final.status}` +
          (final.decisionNote ? `: ${final.decisionNote}` : '.'),
        category: 'plan-rejected',
        hint: 'Revise the mission/task prompts per the owner’s feedback, then approve a retry.',
        taskId,
      }),
    };
  }

  /**
   * Phase 10A: when a run is blocked on something only a human can do
   * (login, CAPTCHA, browser prompt, ...), pause gracefully: tell the
   * owner what happened, why it stopped, what to do, and where — then
   * continue the mission once they reply DONE. Categories are matched
   * against `approvals.humanActionCategories`; everything else keeps the
   * original terminal-block behavior.
   */
  async maybePauseForHumanAction({ project, session, blocked, taskId, signal }) {
    const effective = effectiveApprovalConfig(this.approvalsConfig, project);
    if (!this.approvalManager || effective.enabled === false) return { handled: false };
    if (!blocked?.blocked) return { handled: false };
    if (!(effective.humanActionCategories ?? []).includes(blocked.category)) {
      return { handled: false };
    }

    const { approved, request } = await this.approvalManager.requestHumanAction({
      project: project.name,
      category: blocked.category,
      what: `The agent cannot continue: ${blocked.category}.`,
      why: blocked.evidence ?? 'See the run output for the agent’s own explanation.',
      actionRequired: blocked.hint ?? 'Resolve the blocker manually.',
      where: project.workingDirectory,
      taskId,
      projectConfig: project,
    });
    if (approved) return { handled: false }; // policy misconfigured to auto — fall through

    this.statusManager.set({ orchestrator: { state: 'awaiting-human-action' } });
    const final = await this.approvalManager.waitForDecision(request, { signal, projectConfig: project });
    this.statusManager.set({ orchestrator: { state: 'supervising' } });

    if (this.stopRequested || final.status === 'pending') {
      return { handled: true, outcome: this.stoppedMidWait(session) };
    }
    if (final.status === 'done' || final.status === 'approved') {
      // The human cleared the blocker — this pause was never "no progress".
      this.sessionManager.update(session, { consecutiveNoProgress: 0 });
      this.resumeSession(session, `human action ${request.id} completed; continuing`);
      return {
        handled: true,
        outcome: {
          done: false,
          consecutiveCrashes: 0,
          lastActivity: `the owner completed the required action (${blocked.category}); continue`,
        },
      };
    }
    return {
      handled: true,
      outcome: this.block(project, session, {
        reason: `Human action ${request.id} was ${final.status} — the mission cannot continue.`,
        category: blocked.category,
        hint: blocked.hint,
        evidence: blocked.evidence,
        taskId,
      }),
    };
  }

  /** Average run duration from recent ledger entries (null when unknown). */
  averageRunMs(projectName) {
    const durations = this.progressLedger.recent(projectName, 10)
      .map((r) => r.durationMs)
      .filter((d) => Number.isFinite(d) && d > 0);
    if (!durations.length) return null;
    return Math.round(durations.reduce((sum, d) => sum + d, 0) / durations.length);
  }

  /**
   * Optional engine-specific blocked-state patterns supplied by the driver.
   * Phase 9: prefer the driver of the agent that handled the current run
   * (set in the loop); fall back to the project's default driver.
   */
  blockedPatternsFor(project) {
    try {
      const driver = this.currentDriver ?? this.driverRegistry.getDriver(project.driver);
      return driver.blockedPatterns ?? [];
    } catch {
      return [];
    }
  }

  /** Pause between continue-relaunches (abortable by an operator stop). */
  async interRunDelay(signal) {
    const ms = this.progressConfig.interRunDelayMs ?? 0;
    if (ms > 0) {
      this.logger.info('Inter-run delay before relaunch', { ms });
      await sleep(ms, signal);
    }
  }

  /**
   * Stop the mission because it cannot make progress (a detected loop or an
   * explicit blocked state). Unlike {@link giveUp}, BLOCKED is terminal and
   * NOT auto-resumable: continuing would re-enter the same futile loop.
   * The session is archived and a diagnostic report is written so the
   * operator can fix the blocker and start a clean run. This is precisely
   * what turns a 13-hour overnight quota fire into a one-minute stop.
   */
  block(project, session, { reason, category, hint, evidence, taskId }) {
    const recentRuns = this.progressLedger.recent(project.name, 8);
    const reportPath = writeDiagnosticReport({
      diagnosticsDir: this.paths.diagnosticsDir,
      project,
      session,
      reason,
      category,
      hint,
      evidence,
      recentRuns,
      logger: this.logger,
    });
    // Phase P5: outlives this session/queue — a catalog of "what has gone
    // wrong on this project and why", independent of ledger/queue lifetime.
    this.memoryStore.recordFailure(project.name, { category, reason, hint, taskId });

    this.sessionManager.update(session, { lastActivity: `blocked: ${reason}` });
    this.sessionManager.closeSession(session, SessionState.BLOCKED);
    this.statusManager.syncSession(session);
    this.statusManager.set({ orchestrator: { state: 'blocked' } });
    this.lifecycle?.transition(project.name, 'blocked', reason);
    this.logger.error('Mission blocked — stopping to avoid wasting usage', {
      project: project.name,
      reason,
      category,
      reportPath,
    });
    this.emit('mission:blocked', {
      project: project.name, session, reason, category, reportPath,
      card: buildMissionCard({
        project: project.name, session,
        queue: this.missionMode ? this.taskQueueState : undefined,
        status: 'blocked', reason, operatorAction: hint,
        workingDirectory: project.workingDirectory,
        simulated: isSimulatedProject(project),
      }),
    });
    return {
      done: true,
      result: { complete: false, session, reason, blocked: true, reportPath },
    };
  }

  /** Mark a session as resumed and refresh counters/status. */
  resumeSession(session, note) {
    this.sessionManager.update(session, {
      state: SessionState.RUNNING,
      resumes: session.resumes + 1,
      resumeAt: null,
      lastActivity: note,
    });
    this.statusManager.set({ activity: { lastResumeAt: new Date().toISOString() } });
    this.statusManager.syncSession(session);
    this.emit('session:resumed', { project: session.project, session, note });
    this.logger.info('Session resumed', { project: session.project, note });
  }

  /** Shared ending for "operator stopped us while we were waiting". */
  stoppedMidWait(session) {
    return {
      done: true,
      result: {
        complete: false,
        session,
        reason: 'stopped by operator while waiting',
      },
    };
  }

  /**
   * Stop trying (for now) without abandoning the mission: the session stays
   * on disk in a resumable state, so the next start — manual, or automatic
   * after a reboot — picks the conversation back up.
   */
  giveUp(project, session, reason) {
    this.sessionManager.update(session, {
      state: SessionState.GAVE_UP,
      lastActivity: reason,
    });
    this.statusManager.syncSession(session);
    this.statusManager.set({ orchestrator: { state: 'gave-up' } });
    this.lifecycle?.transition(project.name, 'failed', reason);
    this.logger.error('Giving up (session preserved for next start)', {
      project: project.name,
      reason,
    });
    this.emit('session:gave-up', { project: project.name, session, reason });
    return { done: true, result: { complete: false, session, reason } };
  }

  /** Wire passive observation of a live run into status.json. */
  observeRun(run, project, session) {
    this.activeRun = run;

    run.on('engine-session-id', (engineSessionId) => {
      if (engineSessionId !== session.engineSessionId) {
        // Resuming forks a new engine conversation id; always track the latest.
        this.sessionManager.update(session, { engineSessionId });
        this.statusManager.syncSession(session);
      }
    });

    run.on('activity', (activity) => {
      this.statusManager.set({ activity: { currentTask: activity } });
    });

    this.supervisor.watch(run, {
      onOutput: (timestampMs) => {
        this.statusManager.set({
          activity: { lastOutputAt: new Date(timestampMs).toISOString() },
        });
      },
      onChildren: (childPids) => {
        this.statusManager.set({ agent: { childPids } });
      },
    });

    this.statusManager.set({
      agent: { driver: session.driver, pid: run.pid, state: 'running' },
      activity: { lastRestartAt: new Date().toISOString() },
    });
  }

  /**
   * Operator-initiated stop: abort any recovery wait and (only here, never
   * from supervision logic) ask the live agent process to shut down.
   */
  async stop(reason = 'operator request') {
    if (this.stopRequested) return;
    this.stopRequested = true;
    this.logger.info('Stop requested', { reason });
    this.stopController.abort();
    if (this.activeRun) {
      await this.activeRun.requestStop(reason);
    }
  }
}

/**
 * Phase 10: extra sections appended to a FRESH prompt (first launch of a
 * task/mission) — unread cross-agent messages and any owner note attached
 * during approval. Continuation prompts carry these through the briefing
 * instead; a fresh prompt is read straight from the prompt file, so the
 * appendix is how this context reaches a first launch. Empty inputs return
 * an empty string (the prompt is byte-for-byte unchanged — the pre-P10
 * guarantee).
 */
function freshPromptAppendix({ messages = [], approvalNote } = {}) {
  const lines = [];
  if (approvalNote) {
    lines.push('', '## Owner note (from the approval decision)', '', approvalNote);
  }
  if (messages.length) {
    lines.push('', '## Messages from other agents on this mission', '');
    for (const m of messages) {
      const topic = m.topic ? ` [${m.topic}]` : '';
      lines.push(`- from ${m.from}${topic}: ${m.text}`);
    }
  }
  return lines.length ? `\n${lines.join('\n')}\n` : '';
}

/**
 * A task with no `verify` entries falls back to the mission completion
 * marker as a lightweight per-task signal, in the same shape a real
 * verifier result takes (so callers never need to special-case it).
 */
function markerFallbackVerify(marker, finalText) {
  const markerHit = Boolean(marker && finalText.includes(marker));
  return {
    passed: markerHit,
    results: [{
      type: 'marker',
      passed: markerHit,
      detail: markerHit ? 'Completion marker found' : 'Completion marker not found',
    }],
  };
}

export default Orchestrator;
