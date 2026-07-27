/**
 * daemonClient.js — Phase 12 M1: how everything else talks to the Core Service.
 *
 * The CLI uses this today; the desktop (M3) and the Telegram router (M2) use
 * the same class rather than each inventing their own discovery and auth. It
 * deliberately mirrors the shape the desktop bridge already proved out
 * (desktop/main/orchestratorBridge.js): never throw on a network problem —
 * return `{ok:false, reason}` so callers can print something useful or fall
 * back to the idle path.
 *
 * Discovery is a file read, not a network probe: `state/daemon.json` records
 * the pid and port, and a PID probe distinguishes "not running" from "died
 * without cleaning up" — which are different problems with different fixes,
 * and the operator deserves to be told which one they have.
 */

import { readDaemon } from './daemonRecord.js';
import { loadOrCreateToken } from '../api/apiAuth.js';

/** How long any single daemon call may take before it is abandoned. */
export const DEFAULT_TIMEOUT_MS = 5_000;

export class DaemonClient {
  /**
   * @param {object} options
   * @param {object} options.paths - Resolved runtime paths.
   * @param {object} [options.config] - Global config (for api host/port).
   * @param {typeof fetch} [options.fetchImpl] - Injectable (tests).
   * @param {object} [options.logger]
   */
  constructor({ paths, config, fetchImpl, logger } = {}) {
    this.paths = paths;
    this.config = config ?? {};
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
    this.logger = logger;
  }

  /**
   * Is the Core Service running, and where?
   *
   * @returns {{running: boolean, record: object|null, stale: boolean}}
   */
  discover() {
    return readDaemon(this.paths.daemonFile, { logger: this.logger });
  }

  /** Convenience: just the boolean. */
  isRunning() {
    return this.discover().running;
  }

  /** Base URL, preferring the port the daemon actually recorded. */
  baseUrl() {
    const api = this.config.api ?? {};
    const { record } = this.discover();
    const port = record?.port ?? api.port ?? 4711;
    return `http://${api.host ?? '127.0.0.1'}:${port}`;
  }

  token() {
    return loadOrCreateToken(this.paths.apiTokenFile);
  }

  /**
   * Call the daemon. Never throws.
   *
   * @returns {Promise<{ok: boolean, status: number, data?: *, reason?: string}>}
   */
  async call(pathSuffix, { method = 'GET', body, auth = false, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!this.fetchImpl) {
      return { ok: false, status: 0, reason: 'fetch is not available in this runtime.' };
    }
    const headers = { 'content-type': 'application/json' };
    if (auth) headers.authorization = `Bearer ${this.token()}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl()}${pathSuffix}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => null);
      return { ok: response.ok, status: response.status, data };
    } catch (error) {
      return { ok: false, status: 0, reason: error.message };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Full service report, or a clear reason why not. */
  async status() {
    const found = this.discover();
    if (!found.running) {
      return {
        ok: false,
        running: false,
        stale: found.stale,
        reason: found.stale
          ? `The Core Service record points at pid ${found.record?.pid}, which is no longer running ` +
            '(it crashed or the machine lost power). Start it again with "ai-orchestrator serve".'
          : 'The Core Service is not running. Start it with "ai-orchestrator serve".',
      };
    }
    const result = await this.call('/api/daemon');
    if (!result.ok) {
      return {
        ok: false,
        running: true,
        reason:
          `The Core Service is running (pid ${found.record.pid}) but its API did not answer: ` +
          `${result.reason ?? `HTTP ${result.status}`}.`,
      };
    }
    return { ok: true, running: true, report: result.data };
  }

  /** Start a mission as a supervised worker. */
  async startMission(project, { fresh = false } = {}) {
    const result = await this.call('/api/daemon/missions/start', {
      method: 'POST', auth: true, body: { project, fresh },
    });
    return result.data ?? { ok: false, reason: result.reason ?? 'Request failed.' };
  }

  /** Stop one supervised mission. */
  async stopMission(project, reason) {
    const result = await this.call('/api/daemon/missions/stop', {
      method: 'POST', auth: true, body: { project, reason },
    });
    return result.data ?? { ok: false, reason: result.reason ?? 'Request failed.' };
  }

  /** Every supervised worker. */
  async workers() {
    const result = await this.call('/api/daemon/workers');
    return result.ok ? result.data : [];
  }
}

export default DaemonClient;
