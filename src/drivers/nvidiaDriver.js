/**
 * nvidiaDriver.js — NVIDIA NIM driver (optional fallback engine).
 *
 * Talks to NVIDIA's OpenAI-compatible chat-completions endpoint over HTTP
 * instead of spawning a CLI process — the rest of the orchestrator (mission
 * loop, checkpointing, Safe Mode, event log) needs no changes to supervise
 * it, because it still implements the same AIDriver/AgentRun contract
 * claudeDriver.js and cliDriver.js do.
 *
 * Capability boundary, stated plainly up front (the honesty invariant this
 * codebase holds every driver to): this driver has NO file-system or shell
 * tool access. It is a single request/response text completion, not an
 * agent that can edit a workspace. `simulated` stays false — a response is a
 * genuine model output, not a scripted fixture — but a mission run against
 * `nvidia` can only ever produce a text result (review, analysis, plan),
 * never a file change. Use `claude` or `cli` for anything that must write
 * to disk; use `nvidia` for read-only reasoning, or as a text-only fallback
 * when `claude` is unavailable.
 *
 * No conversation resume: like cliDriver.js, every launch is a fresh,
 * single-turn request — NVIDIA's chat-completions endpoint keeps no
 * server-side session, and building real multi-turn history threading is
 * unnecessary for a fallback driver's first version.
 */

import { AIDriver, AgentRun } from './aiDriver.js';

const DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1';
const DEFAULT_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b';
const DEFAULT_TIMEOUT_MS = 120_000;

export class NvidiaDriver extends AIDriver {
  /**
   * @param {object} options
   * @param {object} options.logger
   * @param {() => object} [options.nvidiaConfigProvider] - Closure returning
   *   the live `nvidia` config block ({apiKey, baseUrl, model, timeoutMs}).
   *   Optional, same collaborator shape as ClaudeDriver's
   *   `defaultModelProvider` — a registry that doesn't pass one just gets a
   *   driver with nothing configured (checkInstallation() reports that).
   * @param {typeof fetch} [options.fetchFn] - Injected HTTP client, same
   *   testability pattern `notifications/channels/telegram.js` already uses
   *   (a real fetch call in a unit test would be a live network dependency).
   *   Defaults to the global `fetch` Node >=18 already provides.
   */
  constructor({ logger, nvidiaConfigProvider, fetchFn }) {
    super({ logger });
    this.id = 'nvidia';
    this.name = 'NVIDIA NIM';
    this.simulated = false;
    this.nvidiaConfigProvider = nvidiaConfigProvider ?? (() => ({}));
    this.fetchFn = fetchFn ?? fetch;

    this.exitPatterns = {
      usageLimit: [/\b429\b/, /rate.?limit/i, /quota exceeded/i],
      network: [/ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/, /fetch failed/i],
    };
  }

  /** Resolve the effective request settings — a project's own `nvidia.model` wins. */
  resolveConfig(project) {
    const global = this.nvidiaConfigProvider() ?? {};
    const perProject = project?.nvidia ?? {};
    return {
      apiKey: global.apiKey || '',
      baseUrl: global.baseUrl || DEFAULT_BASE_URL,
      model: perProject.model || global.model || DEFAULT_MODEL,
      timeoutMs: global.timeoutMs || DEFAULT_TIMEOUT_MS,
    };
  }

  /** @inheritdoc */
  async checkInstallation() {
    const { apiKey } = this.resolveConfig({});
    if (!apiKey) {
      return {
        ok: false,
        error:
          'No NVIDIA API key configured. Add one to config/local.json under ' +
          '"nvidia": { "apiKey": "..." } — never to a tracked file.',
      };
    }
    return { ok: true, version: 'nvidia-nim (OpenAI-compatible chat completions)' };
  }

  /** @inheritdoc */
  async launch({ project, prompt }) {
    const config = this.resolveConfig(project);
    if (!config.apiKey) {
      throw new Error(
        'The "nvidia" driver needs an API key: set config/local.json → nvidia.apiKey.'
      );
    }

    this.logger.info('Requesting NVIDIA completion', {
      project: project?.name,
      model: config.model,
    });

    const run = new NvidiaRun({ logger: this.logger, fetchFn: this.fetchFn });
    run.begin({ prompt, config });
    return run;
  }
}

/** One live NVIDIA chat-completion request, exposed through the AgentRun contract. */
class NvidiaRun extends AgentRun {
  constructor({ logger, fetchFn }) {
    super();
    this.logger = logger;
    this.fetchFn = fetchFn;
    this.controller = new AbortController();
    this.stopped = false;
  }

  async begin({ prompt, config }) {
    this.emit('activity', `Requesting completion from ${config.model}`);
    const timeoutTimer = setTimeout(() => this.controller.abort(), config.timeoutMs);

    let response;
    try {
      response = await this.fetchFn(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: this.controller.signal,
      });
    } catch (error) {
      clearTimeout(timeoutTimer);
      if (this.stopped) return;
      this.finish({ code: null, signal: null, outputTail: error.message, spawnError: error });
      return;
    }
    clearTimeout(timeoutTimer);
    if (this.stopped) return;

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const outputTail = `NVIDIA API error ${response.status}: ${body.slice(0, 2000)}`;
      this.emit('output', outputTail);
      this.finish({
        code: 1,
        signal: null,
        outputTail,
        resultText: null,
        resultIsError: true,
      });
      return;
    }

    const payload = await response.json();
    const text = payload?.choices?.[0]?.message?.content ?? '';
    this.emit('output', text);
    this.emit('result', { text, isError: false });
    this.finish({
      code: 0,
      signal: null,
      outputTail: text.slice(-32_000),
      resultText: text,
      resultIsError: false,
    });
  }

  /** @inheritdoc */
  async requestStop(reason) {
    if (this.stopped) return;
    this.stopped = true;
    this.logger.info('Stopping NVIDIA request (operator request)', { reason });
    this.controller.abort();
    this.finish({ code: null, signal: 'SIGTERM', outputTail: '', resultText: null, resultIsError: false });
  }
}

export default NvidiaDriver;
