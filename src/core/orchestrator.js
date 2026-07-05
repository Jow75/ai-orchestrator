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
import { isLegacyMission, getTaskById } from '../mission/missionPlan.js';
import { TaskQueue } from '../mission/taskQueue.js';
import { buildCheckpoint } from '../mission/checkpoint.js';
import { runVerifiers } from '../verify/verifierRegistry.js';

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
   */
  constructor({ configManager, driverRegistry, sessionManager, statusManager, paths, logger }) {
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

    // Phase P2: mission mode (ordered tasks). Unused (missionMode stays
    // false, taskQueueState stays null) for legacy single-prompt projects.
    this.taskQueueStore = new TaskQueue({ tasksDir: this.paths.tasksDir, logger });
    this.missionMode = false;
    this.taskQueueState = null;

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
  async runProject(projectName, { recoveredAfter } = {}) {
    const project = this.configManager.getProject(projectName);
    const driver = this.driverRegistry.getDriver(project.driver);

    // Effective progress config: a project may override the global settings
    // (P1). Re-init the loop breaker with the merged threshold.
    this.progressConfig = { ...this.globalProgressConfig, ...(project.progress ?? {}) };
    this.loopBreaker = new LoopBreaker({ config: this.progressConfig, logger: this.logger });

    // Fail fast, before touching any session state, if the engine is absent.
    const installation = await driver.checkInstallation(
      project[project.driver]?.executable
    );
    if (!installation.ok) {
      throw new Error(installation.error);
    }
    this.logger.info('Engine verified', {
      driver: driver.id,
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
    this.missionMode = !isLegacyMission(project);
    this.taskQueueState = this.missionMode
      ? this.taskQueueStore.getOrInitialize(project.name, project.tasks, session.id)
      : null;
    this.statusManager.syncTaskQueue(this.taskQueueState);

    // Defensive: a fully-advanced queue with a still-open session means the
    // mission finished but the session was never closed out (e.g. a crash
    // between the last task's completion and session close). Treat it as
    // complete rather than looping with no current task.
    if (this.missionMode && this.taskQueueStore.isComplete(this.taskQueueState)) {
      this.sessionManager.closeSession(session, SessionState.COMPLETED);
      this.statusManager.syncSession(session);
      this.statusManager.set({ orchestrator: { state: 'mission-complete' } });
      this.emit('mission:complete', {
        project: project.name, session, summary: 'All tasks were already complete.',
      });
      return { complete: true, session, reason: 'all tasks already completed' };
    }

    // Crash counting is per-process-lifetime: a reboot or manual restart
    // grants a fresh set of attempts (the human/scheduler chose to retry).
    let consecutiveCrashes = 0;
    let lastActivity = resumedExisting ? 'resumed after interruption' : 'starting mission';

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

      // Fresh sessions get the mission prompt; resumed conversations get the
      // continue prompt (the engine already holds the full history). In
      // mission mode, "fresh" is decided per TASK (attempts === 0), not per
      // session — a later task's first launch still resumes the same engine
      // conversation, but introduces ITS OWN prompt rather than "continue".
      const engineIsFresh = !session.engineSessionId;
      let prompt;
      let activeTaskId = null;
      if (this.missionMode) {
        const taskEntry = this.taskQueueStore.current(this.taskQueueState);
        const taskDef = getTaskById(project, taskEntry.id);
        activeTaskId = taskDef.id;
        const taskIsFresh = taskEntry.attempts === 0;
        prompt = taskIsFresh
          ? fs.readFileSync(taskDef.resolvedPromptFile, 'utf8')
          : (taskDef.continuePrompt ?? project.mission.continuePrompt);
        this.taskQueueStore.recordAttempt(this.taskQueueState);
        this.statusManager.syncTaskQueue(this.taskQueueState);
      } else {
        prompt = engineIsFresh
          ? fs.readFileSync(project.resolvedPromptFile, 'utf8')
          : project.mission.continuePrompt;
      }

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
          project,
          prompt,
          engineSessionId: session.engineSessionId,
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

      // ── The heart of the safety rules ─────────────────────────────────
      // The agent is alive: we wait. No timeouts, no health-kills, no
      // nudging. Hours of silence are its business, not ours.
      const exitInfo = await run.waitForExit();
      // ──────────────────────────────────────────────────────────────────

      this.activeRun = null;
      this.supervisor.unwatch();
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

        // Did the agent declare the whole MISSION finished (not just this run)?
        const marker = project.mission.completionMarker;
        if (marker && finalText.includes(marker)) {
          this.sessionManager.closeSession(session, SessionState.COMPLETED);
          this.statusManager.syncSession(session);
          this.statusManager.set({ orchestrator: { state: 'mission-complete' } });
          const summary = exitInfo.resultText ?? 'Mission complete.';
          this.logger.info('Mission complete', { project: project.name });
          this.emit('mission:complete', { project: project.name, session, summary });
          return {
            done: true,
            result: { complete: true, session, reason: 'completion marker found' },
          };
        }

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
    const taskEntry = this.taskQueueStore.current(queue);
    const taskDef = getTaskById(project, taskEntry.id);

    const verifyResult = taskDef.verify.length > 0
      ? runVerifiers(taskDef.verify, {
        workingDirectory: project.workingDirectory,
        resultText: exitInfo.resultText,
        outputTail: exitInfo.outputTail,
        changes: progress.changes,
      })
      : markerFallbackVerify(project.mission.completionMarker, finalText);

    if (verifyResult.passed) {
      const checkpoint = buildCheckpoint({
        task: taskDef, attempts: taskEntry.attempts, changes: progress.changes,
        verifyResult, resultText: exitInfo.resultText, outcome: 'done',
      });
      this.taskQueueStore.markDone(queue, checkpoint);
      this.logger.info('Task completed and verified', {
        project: project.name, taskId: taskDef.id, attempts: taskEntry.attempts,
      });
      this.emit('task:done', { project: project.name, session, taskId: taskDef.id, checkpoint });

      this.taskQueueStore.advance(queue);
      this.statusManager.syncTaskQueue(queue);

      if (this.taskQueueStore.isComplete(queue)) {
        this.sessionManager.closeSession(session, SessionState.COMPLETED);
        this.statusManager.syncSession(session);
        this.statusManager.set({ orchestrator: { state: 'mission-complete' } });
        const summary = exitInfo.resultText ?? 'Mission complete.';
        this.logger.info('Mission complete (all tasks done)', { project: project.name });
        this.emit('mission:complete', { project: project.name, session, summary });
        return {
          done: true,
          result: { complete: true, session, reason: 'all tasks completed and verified' },
        };
      }

      await this.interRunDelay(signal);
      if (this.stopRequested) return this.stoppedMidWait(session);

      const nextTask = this.taskQueueStore.current(queue);
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
        this.taskQueueStore.markBlocked(queue, checkpoint);
        this.statusManager.syncTaskQueue(queue);
        return this.block(project, session, {
          reason: decision.reason,
          category: decision.category,
          hint: decision.hint ?? progress.blocked?.hint,
          evidence: progress.blocked?.evidence,
        });
      }
    }

    if (taskEntry.attempts < taskDef.maxRuns) {
      await this.interRunDelay(signal);
      if (this.stopRequested) return this.stoppedMidWait(session);

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
    this.taskQueueStore.markFailed(queue, checkpoint);
    this.statusManager.syncTaskQueue(queue);
    const failedChecks = verifyResult.results.filter((r) => !r.passed)
      .map((r) => `${r.type}: ${r.detail}`).join('; ');
    return this.block(project, session, {
      reason: `Task "${taskDef.id}" failed verification after ${taskEntry.attempts} ` +
        `attempts (max ${taskDef.maxRuns}).`,
      category: 'verification-failed',
      hint: `Review the task's objective and verifiers. Failed checks: ${failedChecks}`,
      evidence: failedChecks,
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

  /** Optional engine-specific blocked-state patterns supplied by the driver. */
  blockedPatternsFor(project) {
    try {
      return this.driverRegistry.getDriver(project.driver).blockedPatterns ?? [];
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
  block(project, session, { reason, category, hint, evidence }) {
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

    this.sessionManager.update(session, { lastActivity: `blocked: ${reason}` });
    this.sessionManager.closeSession(session, SessionState.BLOCKED);
    this.statusManager.syncSession(session);
    this.statusManager.set({ orchestrator: { state: 'blocked' } });
    this.logger.error('Mission blocked — stopping to avoid wasting usage', {
      project: project.name,
      reason,
      category,
      reportPath,
    });
    this.emit('mission:blocked', {
      project: project.name, session, reason, category, reportPath,
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
