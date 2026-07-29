/**
 * claudeDriver.js — Claude Code driver.
 *
 * Runs Claude Code headless (`claude -p --output-format stream-json`) so the
 * orchestrator can observe structured events: the engine session id (needed
 * for `--resume`), activity for status.json, and the final result payload.
 *
 * Notes on Windows: the `claude` command is a `.cmd` shim, so the process is
 * spawned through the shell. The prompt is always delivered via stdin —
 * never on the command line — so prompt size and quoting are non-issues.
 */

import { spawn, exec, execFile } from 'node:child_process';
import { AIDriver, AgentRun } from './aiDriver.js';

/** How much combined output to retain for exit-cause classification. */
const OUTPUT_TAIL_CHARS = 32_000;

/** Max length of the activity strings shown in status.json. */
const ACTIVITY_MAX_CHARS = 140;

/** Grace period between SIGTERM and force-kill in requestStop(). */
const STOP_GRACE_MS = 10_000;

/** Timeout for the `claude --version` installation probe. */
const VERSION_PROBE_TIMEOUT_MS = 30_000;

export class ClaudeDriver extends AIDriver {
  /**
   * @param {object} options
   * @param {object} options.logger
   * @param {() => string} [options.defaultModelProvider] - Phase 13 M5: the
   *   machine-wide default model (`operator.defaultModel`), consulted only
   *   when a project's own `claude.model` is unset. Optional — every
   *   existing caller/test that doesn't pass it gets identical behaviour to
   *   before this milestone (the same optional-collaborator contract every
   *   Phase 10 surface already uses). Deliberately a closure, not a value:
   *   for a worker process this reads that process's OWN config snapshot
   *   (loaded once at App construction, same as everything else a worker
   *   reads), so an in-flight mission's args are already fixed by the time
   *   any later `/model` change lands — no extra "don't disrupt a running
   *   mission" logic is needed, because none is possible by construction.
   * @param {() => boolean} [options.safeModeProvider] - Reconciliation pass,
   *   2026-07-30 (`operator.safeMode`, `/safemode on|off`): same closure
   *   shape and same isolation guarantee as `defaultModelProvider` above —
   *   read fresh at each `buildArgs()` call, so a worker already spawned is
   *   never affected by a later toggle.
   */
  constructor({ logger, defaultModelProvider, safeModeProvider }) {
    super({ logger });
    this.id = 'claude';
    this.name = 'Claude Code';
    this.defaultModelProvider = defaultModelProvider ?? (() => '');
    this.safeModeProvider = safeModeProvider ?? (() => false);

    // Engine-specific knowledge consumed by the core exit classifier.
    this.exitPatterns = {
      usageLimit: [
        /usage limit reached/i,
        /you(?:'| ha)?ve (?:hit|reached) your (?:usage|rate|session) limit/i,
        /\b5-hour limit reached/i,
        /(?:usage|rate) limit.{0,40}resets/i,
        /too many requests/i,
        /\bquota exceeded\b/i,
      ],
      network: [
        /ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/,
        /fetch failed/i,
        /network (?:error|failure|problem)/i,
        /connection (?:error|refused|reset|closed|failed)/i,
        /getaddrinfo/i,
      ],
    };
  }

  /** @inheritdoc */
  async checkInstallation(executable = 'claude') {
    return new Promise((resolve) => {
      // exec() takes a full command line, which runs .cmd shims on Windows
      // without the deprecated shell+args spawn combination.
      exec(
        `${quoteForCmd(executable)} --version`,
        {
          timeout: VERSION_PROBE_TIMEOUT_MS,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error) {
            resolve({
              ok: false,
              error:
                `Cannot run "${executable} --version": ${error.message}. ` +
                'Is Claude Code installed and on PATH? (npm install -g @anthropic-ai/claude-code)',
            });
          } else {
            resolve({ ok: true, version: `${stdout}`.trim() || `${stderr}`.trim() });
          }
        }
      );
    });
  }

  /**
   * Build the CLI argument list for one run.
   * The prompt itself is NOT included — it is written to stdin.
   *
   * @param {object} claudeConfig - The project's `claude` settings block.
   * @param {string|null} engineSessionId - Resume target, if any.
   * @returns {string[]}
   */
  buildArgs(claudeConfig, engineSessionId) {
    // --verbose is required by the CLI when combining -p with stream-json.
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];

    if (engineSessionId) args.push('--resume', engineSessionId);
    // Phase 13 M5: fall back to the machine-wide default only when this
    // project has never set its own model — an explicit per-project choice
    // always wins.
    const model = claudeConfig.model || this.defaultModelProvider();
    if (model) args.push('--model', model);
    // Reconciliation pass, 2026-07-30: Safe Mode overrides EVERY project's
    // own permission settings, not just the ones that happen to be unset —
    // that is the entire point of a machine-wide "look before you trust"
    // switch. Omitting both flags is enough: headless Claude with neither
    // set already auto-denies writes (the existing, pre-Safe-Mode behaviour
    // any project with no permissionMode configured already has).
    const safeMode = this.safeModeProvider();
    if (!safeMode) {
      if (claudeConfig.permissionMode) {
        args.push('--permission-mode', claudeConfig.permissionMode);
      }
      if (claudeConfig.dangerouslySkipPermissions) {
        args.push('--dangerously-skip-permissions');
      }
    }
    if (claudeConfig.maxTurns > 0) {
      args.push('--max-turns', String(claudeConfig.maxTurns));
    }
    if (claudeConfig.allowedTools?.length) {
      args.push('--allowedTools', claudeConfig.allowedTools.join(','));
    }
    if (claudeConfig.disallowedTools?.length) {
      args.push('--disallowedTools', claudeConfig.disallowedTools.join(','));
    }
    if (claudeConfig.extraArgs?.length) {
      args.push(...claudeConfig.extraArgs);
    }

    return args;
  }

  /** @inheritdoc */
  async launch({ project, prompt, engineSessionId }) {
    const claudeConfig = project.claude;
    const args = this.buildArgs(claudeConfig, engineSessionId);
    const run = new ClaudeRun({ logger: this.logger });

    this.logger.info('Launching Claude Code', {
      project: project.name,
      resume: Boolean(engineSessionId),
      engineSessionId,
      cwd: project.workingDirectory,
      safeMode: this.safeModeProvider(),
    });

    run.spawn({
      executable: claudeConfig.executable,
      args,
      cwd: project.workingDirectory,
      prompt,
      launchWarningMs: claudeConfig.launchTimeoutMs,
    });

    return run;
  }

  /** @inheritdoc */
  extractLimitResetTime(outputTail) {
    // Form 1: "Claude AI usage limit reached|1751234567" (epoch seconds or ms).
    const epoch = outputTail.match(/usage limit reached\|(\d{10,13})/i);
    if (epoch) {
      const value = Number(epoch[1]);
      const ms = epoch[1].length >= 13 ? value : value * 1000;
      const date = new Date(ms);
      if (!Number.isNaN(date.getTime())) return date;
    }

    // Form 2: "... resets at 3am" / "resets 11:30pm" (local time, next occurrence).
    const ampm = outputTail.match(/resets?\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
    if (ampm) {
      let hours = Number(ampm[1]) % 12;
      if (ampm[3].toLowerCase() === 'pm') hours += 12;
      return nextLocalOccurrence(hours, Number(ampm[2] ?? 0));
    }

    // Form 3: "... resets at 19:30" (24-hour clock).
    const h24 = outputTail.match(/resets?\s*(?:at\s*)?(\d{1,2}):(\d{2})(?!\s*[ap]m)/i);
    if (h24 && Number(h24[1]) < 24 && Number(h24[2]) < 60) {
      return nextLocalOccurrence(Number(h24[1]), Number(h24[2]));
    }

    return null;
  }
}

/**
 * The soonest future Date with the given local wall-clock time.
 * (If that time already passed today, it means tomorrow.)
 */
function nextLocalOccurrence(hours, minutes) {
  const candidate = new Date();
  candidate.setHours(hours, minutes, 0, 0);
  if (candidate.getTime() <= Date.now()) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
}

/**
 * One live Claude Code process, exposed through the AgentRun contract.
 */
class ClaudeRun extends AgentRun {
  constructor({ logger }) {
    super();
    this.logger = logger;
    this.process = null;
    this.outputTail = '';
    this.lineBuffer = '';
    this.resultText = null;
    this.resultIsError = false;
    this.launchWarningTimer = null;
    this.sawOutput = false;
  }

  /**
   * Start the child process and wire up stream-json parsing.
   * All parameters come from the driver; see ClaudeDriver#launch.
   */
  spawn({ executable, args, cwd, prompt, launchWarningMs }) {
    // Windows: `claude` is a .cmd shim, runnable only through the shell.
    // We build the full command line ourselves (quoting each token) and let
    // spawn(command, {shell:true}) hand it to cmd — the supported pattern
    // that avoids the deprecated shell+args combination (DEP0190).
    const options = {
      cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    };
    this.process =
      process.platform === 'win32'
        ? spawn([executable, ...args].map(quoteForCmd).join(' '), { ...options, shell: true })
        : spawn(executable, args, options);
    this.pid = this.process.pid ?? null;

    // Deliver the prompt on stdin — immune to length limits and quoting.
    this.process.stdin.on('error', (error) => {
      // EPIPE here just means the process died first; 'close' will handle it.
      this.logger.debug('stdin error', { error: error.message });
    });
    this.process.stdin.write(prompt);
    this.process.stdin.end();

    this.process.stdout.on('data', (chunk) => this.onStdout(chunk.toString()));
    this.process.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      this.recordOutput(text);
      this.emit('output', text);
    });

    this.process.on('error', (error) => {
      // Spawn failure (e.g. executable missing): the run ends immediately.
      this.clearLaunchWarning();
      this.finish({
        code: null,
        signal: null,
        outputTail: this.outputTail,
        spawnError: error,
      });
    });

    this.process.on('close', (code, signal) => {
      this.clearLaunchWarning();
      this.finish({
        code,
        signal,
        outputTail: this.outputTail,
        resultText: this.resultText,
        resultIsError: this.resultIsError,
      });
    });

    // Startup watchdog: total silence after launch is worth flagging to the
    // user — but per the safety rules we only WARN, we never kill.
    if (launchWarningMs > 0) {
      this.launchWarningTimer = setTimeout(() => {
        if (!this.sawOutput) {
          this.logger.warn(
            'Claude has produced no output since launch — still waiting (will not interrupt)',
            { pid: this.pid, sinceMs: launchWarningMs }
          );
        }
      }, launchWarningMs);
      this.launchWarningTimer.unref();
    }
  }

  clearLaunchWarning() {
    if (this.launchWarningTimer) {
      clearTimeout(this.launchWarningTimer);
      this.launchWarningTimer = null;
    }
  }

  /** Accumulate stdout and split it into NDJSON lines. */
  onStdout(text) {
    this.recordOutput(text);
    this.emit('output', text);

    this.lineBuffer += text;
    let newlineIndex;
    while ((newlineIndex = this.lineBuffer.indexOf('\n')) >= 0) {
      const line = this.lineBuffer.slice(0, newlineIndex).trim();
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      if (line) this.handleEventLine(line);
    }
  }

  /** Interpret one stream-json event from Claude Code. */
  handleEventLine(line) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return; // Non-JSON noise (warnings, banners) — already in outputTail.
    }

    // Every event carries the conversation's session id; resuming creates a
    // NEW id, so always report the latest one for the session record.
    if (event.session_id) {
      this.emit('engine-session-id', event.session_id);
    }

    switch (event.type) {
      case 'assistant': {
        const activity = describeAssistantEvent(event);
        if (activity) this.emit('activity', activity);
        break;
      }
      case 'result': {
        this.resultText = typeof event.result === 'string' ? event.result : null;
        this.resultIsError = Boolean(event.is_error) || /^error/.test(event.subtype ?? '');
        this.emit('result', { text: this.resultText, isError: this.resultIsError });
        break;
      }
      default:
        break;
    }
  }

  /** Keep a bounded tail of combined output for exit classification. */
  recordOutput(text) {
    this.sawOutput = true;
    this.outputTail = (this.outputTail + text).slice(-OUTPUT_TAIL_CHARS);
  }

  /** @inheritdoc */
  async requestStop(reason) {
    if (!this.process || this.process.exitCode !== null) return;

    this.logger.info('Stopping Claude process (operator request)', {
      pid: this.pid,
      reason,
    });

    this.process.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, STOP_GRACE_MS));

    if (this.process.exitCode === null && this.pid) {
      // Force-kill the whole tree; on Windows SIGTERM may not reach
      // grandchildren spawned through the cmd shim.
      if (process.platform === 'win32') {
        await new Promise((resolve) => {
          execFile('taskkill', ['/pid', String(this.pid), '/T', '/F'], () => resolve());
        });
      } else {
        this.process.kill('SIGKILL');
      }
    }
  }
}

/** Produce a short status line from an assistant stream event. */
function describeAssistantEvent(event) {
  const content = event.message?.content;
  if (!Array.isArray(content)) return null;

  // Prefer the most recent tool call — it states what the agent is doing.
  for (let i = content.length - 1; i >= 0; i -= 1) {
    const block = content[i];
    if (block.type === 'tool_use') {
      return truncate(`Using tool: ${block.name}`, ACTIVITY_MAX_CHARS);
    }
    if (block.type === 'text' && block.text?.trim()) {
      return truncate(block.text.trim().replace(/\s+/g, ' '), ACTIVITY_MAX_CHARS);
    }
  }
  return null;
}

function truncate(text, maxChars) {
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

/** Quote a single argument for the Windows cmd shell when needed. */
function quoteForCmd(arg) {
  if (!/[\s"&|<>^()%!]/.test(arg)) return arg;
  return `"${arg.replaceAll('"', '""')}"`;
}

export default ClaudeDriver;
