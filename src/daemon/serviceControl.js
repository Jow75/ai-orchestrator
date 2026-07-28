/**
 * serviceControl.js — Phase 12 M2.1: keeping the Core Service resident.
 *
 * Phase 12 M1 made the daemon startable and gave it an install script. The
 * 2026-07-28 live validation then found the gap that leaves: after a Windows
 * reboot, nothing answered a phone at all. `/projects` went into a void until
 * someone walked to the machine and typed `serve` by hand.
 *
 * Nothing was broken. `daemon install` existed and had simply never been run,
 * `doctor` never checked for it, and no surface could have told the owner that
 * the reason their console was silent was a missing scheduled task. A service
 * that must be started by hand is not a service.
 *
 * This module owns the four questions that answer:
 *
 *   serviceState()      Running / Starting / Stopped — one definition, every surface
 *   ensureRunning()     if it is not up, bring it up (and never start a second one)
 *   autostartState()    is it registered to come back at logon?
 *   describeService()   the whole picture, as an operator would ask for it
 *
 * WHY "STARTING" IS A REAL STATE, NOT A COSMETIC ONE. Between the moment the
 * process claims `state/daemon.json` and the moment its HTTP API answers, the
 * service is neither stopped nor usable. Collapsing that window into "running"
 * makes a launcher look broken (the first command after it fails); collapsing
 * it into "stopped" makes a caller start a SECOND daemon on top of the first,
 * which is precisely the thing the exclusive inbound channel cannot survive.
 * So it is named, and `ensureRunning` waits it out instead of racing it.
 */

import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { ROOT_DIR } from '../infra/paths.js';

/** The scheduled task `install-daemon-task.ps1` registers. Must match it exactly. */
export const CORE_SERVICE_TASK_NAME = 'AI-Orchestrator Core Service';

/** How long `ensureRunning` waits for a service it started to answer. */
export const START_TIMEOUT_MS = 30_000;

/** Gap between readiness probes while waiting. */
export const POLL_INTERVAL_MS = 500;

/** Operator-facing wording. One phrasing, wherever the state is rendered. */
export const SERVICE_STATE_LABEL = Object.freeze({
  running: 'Running',
  starting: 'Starting',
  stopped: 'Stopped',
});

export const SERVICE_STATE_ICON = Object.freeze({
  running: '🟢',
  starting: '🟡',
  stopped: '🔴',
});

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Running / Starting / Stopped, decided from evidence rather than hope.
 *
 * The record is the fast path (a file read plus a PID probe). The API probe
 * only runs when the record claims the service is alive, because that is the
 * only case where the two can disagree — and their disagreement is exactly
 * what "starting" means.
 *
 * @param {import('./daemonClient.js').DaemonClient} client
 * @returns {Promise<{state: 'running'|'starting'|'stopped', pid: number|null,
 *   port: number|null, stale: boolean, since: string|null, detail: string}>}
 */
export async function serviceState(client) {
  const found = client.discover();

  if (!found.running) {
    return {
      state: 'stopped',
      pid: null,
      port: null,
      stale: found.stale,
      since: null,
      detail: found.stale
        // A stale record is a DIFFERENT problem from a clean stop, and the
        // remedy is the same but the diagnosis is not — an owner who is told
        // "stopped" after a crash learns nothing about why it stopped.
        ? `The service died without shutting down cleanly (its record still points at pid ${found.record?.pid}).`
        : 'The service is not running.',
    };
  }

  const probe = await client.call('/api/daemon');
  const base = {
    pid: found.record.pid ?? null,
    port: found.record.port ?? null,
    stale: false,
    since: found.record.startedAt ?? found.record.timestamp ?? null,
  };

  if (probe.ok) {
    return { ...base, state: 'running', detail: 'The service is up and answering.' };
  }
  return {
    ...base,
    state: 'starting',
    detail:
      `The service process is alive (pid ${base.pid}) but its API is not answering yet. ` +
      'It is still coming up, or its port is blocked.',
  };
}

/**
 * Is the Core Service registered to start at logon?
 *
 * Windows-only in substance. Every other platform returns `supported:false`
 * rather than a guess: this project does not report a fact it has not checked,
 * and a Linux user being told their scheduled task is missing would be noise.
 *
 * @param {object} [options]
 * @param {string} [options.platform]
 * @param {(name: string) => {installed: boolean}} [options.query] - Injectable (tests).
 * @returns {{supported: boolean, installed: boolean}}
 */
export function autostartState({ platform = process.platform, query = queryScheduledTask } = {}) {
  if (platform !== 'win32') return { supported: false, installed: false };
  return { supported: true, installed: query(CORE_SERVICE_TASK_NAME).installed };
}

/** Real Task Scheduler probe. Separated so tests never shell out. */
export function queryScheduledTask(taskName) {
  const result = spawnSync('schtasks', ['/Query', '/TN', taskName], {
    encoding: 'utf8', windowsHide: true,
  });
  return { installed: result.status === 0 };
}

/**
 * Start the Core Service if — and only if — it is not already up.
 *
 * This is the "detect an existing instance; start one if there is none" the
 * validation report asked for, and the safety property matters more than the
 * convenience: two daemons on one machine both claim the Telegram long-poll,
 * and `getUpdates` gives each message to exactly one caller. The result is an
 * operator console that answers every other message. So a service that is
 * running OR starting is left strictly alone.
 *
 * The child is spawned DETACHED with stdio ignored. On Windows a child sharing
 * its parent's console dies with the parent, which would make "ensure" produce
 * a service that vanishes when the CLI that started it exits — the failure mode
 * Phase 12 M1 already paid for once.
 *
 * @param {object} options
 * @param {import('./daemonClient.js').DaemonClient} options.client
 * @param {boolean} [options.wait] - Wait for readiness (default true).
 * @param {number} [options.timeoutMs]
 * @param {string} [options.root] - Installation root (tests override).
 * @param {typeof spawn} [options.spawnImpl] - Injectable (tests).
 * @param {object} [options.logger]
 * @returns {Promise<{ok: boolean, started: boolean, state: string, pid: number|null, reason?: string}>}
 */
export async function ensureRunning({
  client, wait = true, timeoutMs = START_TIMEOUT_MS, root = ROOT_DIR,
  spawnImpl = spawn, logger,
} = {}) {
  const before = await serviceState(client);
  if (before.state === 'running') {
    return { ok: true, started: false, state: 'running', pid: before.pid };
  }
  if (before.state === 'starting') {
    // Already on its way up. Joining the wait is right; starting a second one
    // would be the bug this function exists to prevent.
    if (!wait) return { ok: true, started: false, state: 'starting', pid: before.pid };
    return waitForReady({ client, timeoutMs, started: false });
  }

  const entry = path.join(root, 'bin', 'ai-orchestrator.js');
  if (!fs.existsSync(entry)) {
    return {
      ok: false, started: false, state: 'stopped', pid: null,
      reason: `Cannot find ${entry}. Is the installation root correct?`,
    };
  }

  let child;
  try {
    child = spawnImpl(process.execPath, [entry, 'serve'], {
      cwd: root,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch (error) {
    return {
      ok: false, started: false, state: 'stopped', pid: null,
      reason: `Could not start the Core Service: ${error.message}`,
    };
  }

  logger?.info?.('Started the Core Service', { pid: child.pid });
  if (!wait) {
    return { ok: true, started: true, state: 'starting', pid: child.pid ?? null };
  }
  return waitForReady({ client, timeoutMs, started: true });
}

/**
 * Poll until the service answers, or the deadline passes.
 *
 * A timeout is reported as a failure with the state it actually reached, not
 * as a success — a caller that assumes readiness it never observed will make
 * its next call into a void and blame the network.
 */
async function waitForReady({ client, timeoutMs, started }) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    last = await serviceState(client);
    if (last.state === 'running') {
      return { ok: true, started, state: 'running', pid: last.pid };
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(POLL_INTERVAL_MS);
  }
  return {
    ok: false,
    started,
    state: last?.state ?? 'stopped',
    pid: last?.pid ?? null,
    reason:
      `The Core Service did not become ready within ${Math.round(timeoutMs / 1000)}s. ` +
      'Check logs/orchestrator-<date>.log for why it could not finish starting.',
  };
}

/**
 * Everything an operator asks when they ask "is it running?" — the live state,
 * whether it survives a reboot, and what to do about it if not.
 *
 * @param {object} options
 * @param {import('./daemonClient.js').DaemonClient} options.client
 * @param {string} [options.platform]
 * @param {(name: string) => {installed: boolean}} [options.query]
 * @returns {Promise<object>}
 */
export async function describeService({ client, platform, query } = {}) {
  const state = await serviceState(client);
  const autostart = autostartState({ platform, query });
  return {
    ...state,
    label: SERVICE_STATE_LABEL[state.state],
    icon: SERVICE_STATE_ICON[state.state],
    autostart,
    // Stated here rather than at each call site so the CLI, the phone and the
    // desktop all give the same instruction for the same situation.
    remedy: remedyFor(state, autostart),
  };
}

/** The single next action worth taking, or null when nothing is wrong. */
function remedyFor(state, autostart) {
  if (state.state === 'stopped') {
    return autostart.supported && !autostart.installed
      ? 'Start it with "ai-orchestrator daemon ensure", then run "ai-orchestrator daemon install" so it comes back on its own after a reboot.'
      : 'Start it with "ai-orchestrator daemon ensure".';
  }
  if (state.state === 'starting') return 'Wait a few seconds and check again.';
  if (autostart.supported && !autostart.installed) {
    // Running, but one reboot from silence. This is the exact condition the
    // machine was in on 2026-07-28, and nothing reported it.
    return 'It is running, but it will NOT come back after a reboot. Fix that with "ai-orchestrator daemon install".';
  }
  return null;
}

export default {
  CORE_SERVICE_TASK_NAME, SERVICE_STATE_LABEL, SERVICE_STATE_ICON,
  serviceState, autostartState, ensureRunning, describeService, queryScheduledTask,
};
