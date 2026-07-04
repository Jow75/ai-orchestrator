/**
 * processSupervisor.js — Passive Process Supervisor & Child Process Monitor.
 *
 * THE PRIME DIRECTIVE of AI-Orchestrator lives here:
 *
 *     While the agent process is alive, DO NOTHING to it.
 *
 * The agent may legitimately sit silent for hours — waiting on Python
 * training runs, large builds, downloads, git operations, tests. Silence is
 * not failure. This supervisor therefore only OBSERVES:
 *
 *  - It records when output last arrived (for status.json).
 *  - It periodically enumerates the agent's child processes, so a human
 *    reading status.json can see "quiet, but a `python train.py` child is
 *    alive and well" — evidence of healthy long-running work.
 *
 * It never kills, restarts, or times anything out. Recovery decisions
 * happen elsewhere, and only after the process has actually exited.
 */

import { execFile } from 'node:child_process';

/** Upper bound on how long one child-process scan may take. */
const SCAN_TIMEOUT_MS = 20_000;

export class ProcessSupervisor {
  /**
   * @param {object} options
   * @param {object} options.logger - Module logger.
   * @param {number} [options.childScanIntervalMs] - Child enumeration cadence.
   */
  constructor({ logger, childScanIntervalMs = 60_000 }) {
    this.logger = logger;
    this.childScanIntervalMs = childScanIntervalMs;
    this.scanTimer = null;
    this.lastObservation = null;
  }

  /**
   * Begin passively observing a run.
   *
   * @param {import('../drivers/aiDriver.js').AgentRun} run - The live run.
   * @param {object} callbacks
   * @param {function} [callbacks.onOutput] - Called with (timestampMs) when output arrives.
   * @param {function} [callbacks.onChildren] - Called with (pids: number[]) after each scan.
   */
  watch(run, { onOutput, onChildren } = {}) {
    this.unwatch();

    run.on('output', () => {
      this.lastObservation = Date.now();
      onOutput?.(this.lastObservation);
    });

    if (run.pid && this.childScanIntervalMs > 0) {
      const scan = async () => {
        const pids = await listChildProcessIds(run.pid);
        this.logger.debug('Child process scan', { parent: run.pid, children: pids });
        onChildren?.(pids);
      };
      this.scanTimer = setInterval(scan, this.childScanIntervalMs);
      this.scanTimer.unref(); // observation must never keep the process alive
      // First scan soon after launch so status.json fills in quickly.
      setTimeout(scan, Math.min(this.childScanIntervalMs, 5_000)).unref();
    }
  }

  /** Stop observing (the run exited). */
  unwatch() {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
  }
}

/**
 * Enumerate direct child process ids of a PID. Best-effort, read-only.
 *
 * @param {number} parentPid
 * @returns {Promise<number[]>}
 */
export function listChildProcessIds(parentPid) {
  return new Promise((resolve) => {
    const finish = (stdout) => {
      const pids = `${stdout}`
        .split(/\s+/)
        .map((token) => Number.parseInt(token, 10))
        .filter((pid) => Number.isInteger(pid) && pid > 0);
      resolve(pids);
    };

    if (process.platform === 'win32') {
      execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Get-CimInstance Win32_Process -Filter "ParentProcessId=${Number(parentPid)}" | Select-Object -ExpandProperty ProcessId`,
        ],
        { timeout: SCAN_TIMEOUT_MS, windowsHide: true },
        (error, stdout) => (error ? resolve([]) : finish(stdout))
      );
    } else {
      execFile(
        'ps',
        ['-o', 'pid=', '--ppid', String(parentPid)],
        { timeout: SCAN_TIMEOUT_MS },
        (error, stdout) => (error ? resolve([]) : finish(stdout))
      );
    }
  });
}

export default ProcessSupervisor;
