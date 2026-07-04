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
import { SessionState } from '../state/sessionManager.js';
import { sleep, formatDuration } from '../infra/time.js';

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
  'mission:complete', //  { project, session, summary }
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
   * @param {object} deps.logger - Module logger.
   */
  constructor({ configManager, driverRegistry, sessionManager, statusManager, logger }) {
    super();
    this.configManager = configManager;
    this.driverRegistry = driverRegistry;
    this.sessionManager = sessionManager;
    this.statusManager = statusManager;
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
      // continue prompt (the engine already holds the full history).
      const isFresh = !session.engineSessionId;
      const prompt = isFresh
        ? fs.readFileSync(project.resolvedPromptFile, 'utf8')
        : project.mission.continuePrompt;

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
        resumed: !isFresh,
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

      this.sessionManager.update(session, {
        lastExit: {
          at: new Date().toISOString(),
          cause: verdict.cause,
          detail: verdict.detail,
          code: exitInfo.code,
          signal: exitInfo.signal,
          durationMs: exitInfo.durationMs,
        },
      });
      this.statusManager.set({ agent: { state: 'exited', pid: null, childPids: [] } });
      this.emit('session:exit', { project: project.name, session, verdict, exitInfo });

      // Operator stop wins over every recovery strategy; the session record
      // keeps its resumable state so the mission continues next start.
      if (this.stopRequested) break;

      const outcome = await this.applyRecoveryStrategy({
        project,
        session,
        driver,
        verdict,
        exitInfo,
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
  async applyRecoveryStrategy({ project, session, driver, verdict, exitInfo, consecutiveCrashes }) {
    const signal = this.stopController.signal;

    switch (verdict.cause) {
      case ExitCause.COMPLETED: {
        // Did the agent declare the whole MISSION finished (not just this run)?
        const marker = project.mission.completionMarker;
        const finalText = `${exitInfo.resultText ?? ''}\n${exitInfo.outputTail ?? ''}`;
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

        // Run ended cleanly but the mission is unfinished → continue it.
        this.resumeSession(session, 'run finished; mission not complete — continuing');
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
    this.emit('session:resumed', { project: session.project, session });
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

export default Orchestrator;
