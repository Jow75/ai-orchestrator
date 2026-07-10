/**
 * cliDriver.js — Phase 9: generic, config-driven CLI engine driver.
 *
 * One driver (`id: 'cli'`) that can run ANY command-line AI engine — Gemini
 * CLI, Codex, OpenCode, a local LLM wrapper — without a bespoke class per
 * engine. Everything engine-specific comes from the agent/project `cli`
 * config block, so adding an engine is a config change, not a code change.
 *
 * Modeled directly on `claudeDriver.js` (spawn → prompt on stdin or as an
 * arg → stream output as activity → finish on close), minus Claude's
 * stream-json parsing. It does not implement engine resume (most simple CLIs
 * have no conversation id); every launch is fresh and the orchestrator's
 * continuation prompt + the shared workspace carry context across runs.
 *
 * Config (`project.cli`, or an agent's `config.cli` merged over it):
 *   command            {string}   required — the executable
 *   args               {string[]} static args passed before the prompt
 *   promptArg          {string}   flag the prompt follows (e.g. "-p"); when
 *                                 absent the prompt goes to stdin
 *   promptViaStdin     {boolean}  force stdin even with promptArg (default:
 *                                 stdin when no promptArg, arg otherwise)
 *   versionArgs        {string[]} for the install probe (default ["--version"])
 *   usageLimitPatterns {string[]} regex sources → "usage limit" classification
 *   networkPatterns    {string[]} regex sources → "network problem"
 *   launchTimeoutMs    {number}   silence-after-launch warning (0 disables)
 */

import { spawn, exec } from 'node:child_process';
import { AIDriver, AgentRun } from './aiDriver.js';

const OUTPUT_TAIL_CHARS = 32_000;
const ACTIVITY_MAX_CHARS = 140;
const STOP_GRACE_MS = 10_000;
const VERSION_PROBE_TIMEOUT_MS = 30_000;

const DEFAULT_USAGE_LIMIT_PATTERNS = [
  'usage limit', 'rate limit', 'quota exceeded', 'too many requests', 'resource exhausted',
];
const DEFAULT_NETWORK_PATTERNS = [
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN',
  'fetch failed', 'network error', 'connection refused',
];

/** Compile an array of string sources into case-insensitive RegExps. */
function compile(patterns, fallback) {
  const sources = Array.isArray(patterns) && patterns.length ? patterns : fallback;
  return sources
    .map((src) => {
      try {
        return new RegExp(src, 'i');
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export class CliDriver extends AIDriver {
  constructor({ logger }) {
    super({ logger });
    this.id = 'cli';
    this.name = 'Generic CLI Engine';
    // exitPatterns are per-project/agent, so they are resolved at launch from
    // config; these defaults let a bare `cli` agent still classify sensibly.
    this.exitPatterns = {
      usageLimit: compile(null, DEFAULT_USAGE_LIMIT_PATTERNS),
      network: compile(null, DEFAULT_NETWORK_PATTERNS),
    };
  }

  /** Resolve the effective cli config for a project/agent. */
  cliConfig(project) {
    return project.cli ?? {};
  }

  /** @inheritdoc */
  async checkInstallation(executable) {
    // `executable` is passed by the orchestrator from project[driver.id].executable
    // — for the cli driver that's project.cli.executable, but the real command
    // lives in `command`. Accept either; command wins.
    const command = executable || 'cli';
    const versionArgs = ['--version'];
    return new Promise((resolve) => {
      exec(
        [command, ...versionArgs].map(quoteForCmd).join(' '),
        { timeout: VERSION_PROBE_TIMEOUT_MS, windowsHide: true },
        (error, stdout, stderr) => {
          if (error) {
            resolve({
              ok: false,
              error: `Cannot run "${command} --version": ${error.message}. ` +
                'Check the agent\'s cli.command and that the engine is installed and on PATH.',
            });
          } else {
            resolve({ ok: true, version: `${stdout}`.trim() || `${stderr}`.trim() || 'unknown' });
          }
        }
      );
    });
  }

  /** @inheritdoc */
  // eslint-disable-next-line no-unused-vars
  async launch({ project, prompt, engineSessionId }) {
    const cli = this.cliConfig(project);
    if (!cli.command) {
      throw new Error(
        `The "cli" driver needs a "command" (set project.cli.command or the agent's config.cli.command).`
      );
    }

    // Per-launch exit patterns from config (fall back to the sensible defaults).
    const exitPatterns = {
      usageLimit: compile(cli.usageLimitPatterns, DEFAULT_USAGE_LIMIT_PATTERNS),
      network: compile(cli.networkPatterns, DEFAULT_NETWORK_PATTERNS),
    };
    this.exitPatterns = exitPatterns;

    const useStdin = cli.promptViaStdin ?? !cli.promptArg;
    const args = [...(Array.isArray(cli.args) ? cli.args : [])];
    if (!useStdin) {
      if (cli.promptArg) args.push(cli.promptArg);
      args.push(prompt);
    }

    this.logger.info('Launching CLI engine', {
      project: project.name, command: cli.command, cwd: project.workingDirectory,
      promptVia: useStdin ? 'stdin' : (cli.promptArg || 'arg'),
    });

    const run = new CliRun({ logger: this.logger });
    run.spawn({
      command: cli.command,
      args,
      cwd: project.workingDirectory,
      prompt: useStdin ? prompt : null,
      launchWarningMs: cli.launchTimeoutMs ?? 120_000,
    });
    return run;
  }
}

/** One live generic-CLI process, exposed through the AgentRun contract. */
class CliRun extends AgentRun {
  constructor({ logger }) {
    super();
    this.logger = logger;
    this.process = null;
    this.outputTail = '';
    this.launchWarningTimer = null;
    this.sawOutput = false;
  }

  spawn({ command, args, cwd, prompt, launchWarningMs }) {
    const options = { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true };
    this.process =
      process.platform === 'win32'
        ? spawn([command, ...args].map(quoteForCmd).join(' '), { ...options, shell: true })
        : spawn(command, args, options);
    this.pid = this.process.pid ?? null;

    this.process.stdin.on('error', (error) => {
      this.logger.debug('stdin error', { error: error.message });
    });
    if (prompt != null) this.process.stdin.write(prompt);
    this.process.stdin.end();

    const onChunk = (chunk) => {
      const text = chunk.toString();
      this.recordOutput(text);
      this.emit('output', text);
      // A generic CLI has no structured events — surface the latest non-empty
      // line as "activity" so status.json shows *something* useful.
      const line = text.split('\n').map((l) => l.trim()).filter(Boolean).pop();
      if (line) this.emit('activity', truncate(line, ACTIVITY_MAX_CHARS));
    };
    this.process.stdout.on('data', onChunk);
    this.process.stderr.on('data', onChunk);

    this.process.on('error', (error) => {
      this.clearLaunchWarning();
      this.finish({ code: null, signal: null, outputTail: this.outputTail, spawnError: error });
    });
    this.process.on('close', (code, signal) => {
      this.clearLaunchWarning();
      this.finish({
        code, signal, outputTail: this.outputTail,
        // No structured result payload from a generic CLI; the exit code and
        // output tail drive classification (and any verifiers on the task).
        resultText: this.outputTail.slice(-2_000),
        resultIsError: code !== 0 && code !== null,
      });
    });

    if (launchWarningMs > 0) {
      this.launchWarningTimer = setTimeout(() => {
        if (!this.sawOutput) {
          this.logger.warn('CLI engine produced no output since launch — still waiting (will not interrupt)', {
            pid: this.pid, sinceMs: launchWarningMs,
          });
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

  recordOutput(text) {
    this.sawOutput = true;
    this.outputTail = (this.outputTail + text).slice(-OUTPUT_TAIL_CHARS);
  }

  /** @inheritdoc */
  async requestStop(reason) {
    if (!this.process || this.process.exitCode !== null) return;
    this.logger.info('Stopping CLI engine (operator request)', { pid: this.pid, reason });
    this.process.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, STOP_GRACE_MS));
    if (this.process.exitCode === null && this.pid) {
      if (process.platform === 'win32') {
        await new Promise((resolve) => {
          exec(`taskkill /pid ${this.pid} /T /F`, () => resolve());
        });
      } else {
        this.process.kill('SIGKILL');
      }
    }
  }
}

function truncate(text, maxChars) {
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

/** Quote a single argument for the Windows cmd shell when needed. */
function quoteForCmd(arg) {
  if (!/[\s"&|<>^()%!]/.test(arg)) return arg;
  return `"${arg.replaceAll('"', '""')}"`;
}

export default CliDriver;
