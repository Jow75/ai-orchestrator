/**
 * agyDriver.js — Antigravity CLI driver (Gemini, Claude, GPT-OSS).
 *
 * Runs the Antigravity CLI (`agy.exe`) in print mode (`-p`) with direct model
 * specification (`--model <id>`). Supports Gemini 3.8 Flash High natively, as
 * well as Claude Sonnet 4.6, Claude Opus 4.6, and GPT-OSS 120B.
 *
 * Implements the standard AIDriver / AgentRun contract matching ClaudeDriver
 * and CliDriver.
 */

import { spawn, exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { AIDriver, AgentRun } from './aiDriver.js';

const OUTPUT_TAIL_CHARS = 32_000;
const ACTIVITY_MAX_CHARS = 140;
const STOP_GRACE_MS = 10_000;
const VERSION_PROBE_TIMEOUT_MS = 30_000;

export const AGY_DEFAULT_EXECUTABLE = 'C:\\Users\\Admin\\.gemini\\bin\\agy.exe';
export const AGY_DEFAULT_MODEL = 'gemini-3.8-flash-high';

export const AGY_SUPPORTED_MODELS = Object.freeze([
  'gemini-3.8-flash-high',
  'gemini-3.8-flash-medium',
  'gemini-3.8-flash-low',
  'claude-sonnet-4-6',
  'claude-opus-4-6-thinking',
  'gpt-oss-120b-medium',
]);

function quoteForCmd(arg) {
  if (typeof arg !== 'string') return '""';
  if (/^[a-zA-Z0-9_\-\.\/\\:=]+$/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

export class AgyRun extends AgentRun {
  constructor({ logger, proc, prompt }) {
    super({ logger });
    this.proc = proc;
    this.prompt = prompt;
    this.outputTail = '';
    this.stopped = false;

    proc.stdout?.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      this.appendTail(text);
      const lastLine = text.trim().split('\n').pop() || '';
      if (lastLine) {
        this.emit('activity', lastLine.slice(0, ACTIVITY_MAX_CHARS));
      }
    });

    proc.stderr?.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      this.appendTail(text);
      const lastLine = text.trim().split('\n').pop() || '';
      if (lastLine) {
        this.emit('activity', `[stderr] ${lastLine.slice(0, ACTIVITY_MAX_CHARS)}`);
      }
    });

    proc.on('close', (code, signal) => {
      const exitCode = typeof code === 'number' ? code : 1;
      const isError = exitCode !== 0;
      this.emit('result', {
        text: this.outputTail.trim() || (isError ? `Process exited with code ${exitCode}` : 'Success'),
        isError,
      });
      this.emit('exit', exitCode, signal);
    });

    proc.on('error', (err) => {
      this.emit('result', {
        text: `Failed to spawn agy: ${err.message}`,
        isError: true,
      });
      this.emit('exit', 1, null);
    });
  }

  appendTail(text) {
    this.outputTail += text;
    if (this.outputTail.length > OUTPUT_TAIL_CHARS) {
      this.outputTail = this.outputTail.slice(-OUTPUT_TAIL_CHARS);
    }
  }

  getOutputTail() {
    return this.outputTail;
  }

  async requestStop() {
    if (this.stopped || !this.proc || this.proc.killed) return;
    this.stopped = true;
    try {
      this.proc.kill('SIGTERM');
    } catch {
      // Ignored
    }
    setTimeout(() => {
      try {
        if (!this.proc.killed) this.proc.kill('SIGKILL');
      } catch {
        // Ignored
      }
    }, STOP_GRACE_MS).unref();
  }
}

export class AgyDriver extends AIDriver {
  /**
   * @param {object} options
   * @param {object} options.logger
   * @param {() => string} [options.defaultModelProvider]
   * @param {() => boolean} [options.safeModeProvider]
   */
  constructor({ logger, defaultModelProvider, safeModeProvider } = {}) {
    super({ logger });
    this.id = 'agy';
    this.name = 'Antigravity CLI (Gemini 3.8 Flash High / Claude / GPT-OSS)';
    this.defaultModelProvider = defaultModelProvider ?? (() => '');
    this.safeModeProvider = safeModeProvider ?? (() => false);

    this.exitPatterns = {
      usageLimit: [
        /\b429\b/,
        /quota exceeded/i,
        /rate limit/i,
        /resource exhausted/i,
        /capacity unavailable/i,
      ],
      network: [
        /ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/,
        /fetch failed/i,
        /network error/i,
        /connection (?:refused|reset|closed|failed)/i,
      ],
    };
  }

  /**
   * Resolve effective agy executable path.
   */
  resolveExecutable(project = {}) {
    return (
      project?.agy?.executable
      || process.env.ANTIGRAVITY_AGENTAPI_EXE
      || AGY_DEFAULT_EXECUTABLE
    );
  }

  /**
   * Resolve effective model identifier.
   */
  resolveModel(project = {}) {
    const fromProject = project?.agy?.model;
    const fromDefault = this.defaultModelProvider();
    if (fromProject && AGY_SUPPORTED_MODELS.includes(fromProject)) return fromProject;
    if (fromDefault && AGY_SUPPORTED_MODELS.includes(fromDefault)) return fromDefault;
    return AGY_DEFAULT_MODEL;
  }

  /** @inheritdoc */
  async checkInstallation(executable) {
    const target = executable || this.resolveExecutable();
    if (fs.existsSync(target)) {
      return { ok: true, version: 'Antigravity CLI (agy.exe)' };
    }
    return new Promise((resolve) => {
      exec(
        `${quoteForCmd(target)} --help`,
        { timeout: VERSION_PROBE_TIMEOUT_MS, windowsHide: true },
        (error) => {
          if (error) {
            resolve({
              ok: false,
              error: `Cannot find or run agy CLI at "${target}": ${error.message}. Is Antigravity installed?`,
            });
          } else {
            resolve({ ok: true, version: 'Antigravity CLI' });
          }
        }
      );
    });
  }

  /** @inheritdoc */
  async launch({ project, prompt }) {
    const executable = this.resolveExecutable(project);
    const model = this.resolveModel(project);
    const isSafe = this.safeModeProvider();
    const mode = isSafe ? 'plan' : (project?.agy?.mode || 'accept-edits');
    const effort = project?.agy?.effort || 'high';

    const args = [
      '--model',
      model,
      '--mode',
      mode,
      '--effort',
      effort,
      '--dangerously-skip-permissions',
      '--disable-slash-commands',
      '-p',
      prompt,
    ];

    this.logger?.info('Launching Antigravity CLI engine', {
      project: project?.name,
      executable,
      model,
      mode,
    });

    const cwd = project?.workingDirectory && fs.existsSync(project.workingDirectory)
      ? project.workingDirectory
      : process.cwd();

    const proc = spawn(executable, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    return new AgyRun({ logger: this.logger, proc, prompt });
  }
}

export default AgyDriver;

