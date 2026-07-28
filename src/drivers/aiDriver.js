/**
 * aiDriver.js — AI Driver Interface.
 *
 * A driver is the only piece of AI-Orchestrator that knows anything about a
 * specific AI engine (Claude Code today; Codex, Gemini CLI, Aider, ... later).
 * Supporting a new engine means implementing this interface — nothing in the
 * supervision core changes.
 *
 * A driver's job:
 *  1. Verify the engine is installed.
 *  2. Launch a session (fresh or resumed) and return an {@link AgentRun}.
 *  3. Supply engine-specific knowledge: output patterns that mean
 *     "usage limit" or "network problem", and how to extract the limit
 *     reset time from output.
 *
 * A driver must NEVER kill, restart, or otherwise manage the engine process
 * lifecycle on its own — policy belongs to the orchestrator core.
 */

import { EventEmitter } from 'node:events';

/**
 * Handle for one launched engine process.
 *
 * Events:
 *  - 'output'            (string)  Raw output chunk (stdout+stderr).
 *  - 'engine-session-id' (string)  The engine's conversation/session id,
 *                                  as soon as it is known. Required for resume.
 *  - 'activity'          (string)  Short human-readable "what the agent is
 *                                  doing now" note for status.json.
 *  - 'result'            ({text, isError}) The engine's final result payload,
 *                                  when the engine reports one.
 *
 * @property {number|null} pid       Engine process id (null until spawned).
 * @property {number}      startedAt Epoch ms when the run began.
 */
export class AgentRun extends EventEmitter {
  constructor() {
    super();
    this.pid = null;
    this.startedAt = Date.now();
    this._exitPromise = new Promise((resolve) => {
      this._resolveExit = resolve;
    });
  }

  /**
   * Resolve the run as exited. Called exactly once by the driver.
   *
   * @param {object} exitInfo
   * @param {number|null} exitInfo.code        Process exit code.
   * @param {string|null} exitInfo.signal      Terminating signal, if any.
   * @param {string}      exitInfo.outputTail  Last chunk of combined output
   *                                           (for exit-cause classification).
   * @param {string}      [exitInfo.resultText]    Engine-reported final result.
   * @param {boolean}     [exitInfo.resultIsError] Engine flagged the result as an error.
   * @param {Error}       [exitInfo.spawnError]    Set when the process never started.
   */
  finish(exitInfo) {
    if (this._finished) return; // guard against double 'close'+'error'
    this._finished = true;
    this._resolveExit({
      durationMs: Date.now() - this.startedAt,
      ...exitInfo,
    });
  }

  /**
   * Wait for the engine process to exit — however long that takes.
   * The orchestrator awaits this; it never times out a healthy process.
   *
   * @returns {Promise<object>} ExitInfo (see {@link AgentRun#finish}).
   */
  waitForExit() {
    return this._exitPromise;
  }

  /**
   * Operator-initiated stop (CLI `stop`, orchestrator shutdown). This is the
   * ONLY sanctioned path to ending a live engine process, and it is never
   * called by supervision logic on a healthy session.
   */
  // eslint-disable-next-line no-unused-vars
  async requestStop(reason) {
    throw new Error('requestStop() must be implemented by the driver');
  }
}

/**
 * Abstract base class for AI engine drivers.
 */
export class AIDriver {
  /**
   * @param {object} options
   * @param {object} options.logger - Module logger.
   */
  constructor({ logger }) {
    if (new.target === AIDriver) {
      throw new Error('AIDriver is abstract; instantiate a concrete driver');
    }
    this.logger = logger;
    /** @type {string} Unique driver id, e.g. 'claude'. */
    this.id = 'abstract';
    /** @type {string} Human-readable engine name. */
    this.name = 'Abstract AI Driver';
    /**
     * Does this driver only PRETEND to work? False for every driver that
     * runs a real engine against a real working directory.
     *
     * Declared on the base class so a plugin driver can opt in without
     * editing the built-in list in drivers/simulation.js, and so that every
     * surface has one question to ask. A driver that simulates work and does
     * not say so will be reported to the owner as if it had built something —
     * see simulation.js for the incident that made this a first-class field.
     * @type {boolean}
     */
    this.simulated = false;
    /**
     * Engine-specific output patterns consumed by the exit classifier.
     * @type {{ usageLimit: RegExp[], network: RegExp[] }}
     */
    this.exitPatterns = { usageLimit: [], network: [] };
  }

  /**
   * Verify the engine is installed and runnable.
   *
   * @returns {Promise<{ok: boolean, version?: string, error?: string}>}
   */
  async checkInstallation() {
    throw new Error('checkInstallation() must be implemented by the driver');
  }

  /**
   * Launch the engine for one run.
   *
   * @param {object} params
   * @param {object} params.project   Validated project configuration.
   * @param {string} params.prompt    Prompt text for this run.
   * @param {string|null} params.engineSessionId - When set, resume this
   *   engine conversation instead of starting a new one.
   * @returns {Promise<AgentRun>}
   */
  // eslint-disable-next-line no-unused-vars
  async launch({ project, prompt, engineSessionId }) {
    throw new Error('launch() must be implemented by the driver');
  }

  /**
   * Extract the usage-limit reset time from engine output, if present.
   * Return null when unknown; the rate-limit engine then applies its
   * configured default wait.
   *
   * @param {string} outputTail - Recent combined output.
   * @returns {Date|null}
   */
  // eslint-disable-next-line no-unused-vars
  extractLimitResetTime(outputTail) {
    return null;
  }
}

export default { AIDriver, AgentRun };
