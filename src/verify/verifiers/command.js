/**
 * verifiers/command.js — Does a shell command exit with the expected code?
 *
 * Config: `{ type: "command", run: "npm test", expectExit: 0, timeoutMs: 60000 }`
 * The command is trusted config (same trust model as the mission prompt and
 * driver executables) — never sourced from agent output.
 */

import { execSync } from 'node:child_process';

export const type = 'command';

/** Upper bound so a hung verification command can never block forever. */
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 2_000;

/**
 * @param {{run: string, expectExit?: number, timeoutMs?: number}} config
 * @param {{workingDirectory: string}} context
 * @returns {{passed: boolean, detail: string}}
 */
export function run(config, context) {
  if (!config.run) {
    return { passed: false, detail: 'command verifier is missing "run"' };
  }
  const expectExit = config.expectExit ?? 0;

  try {
    const output = execSync(config.run, {
      cwd: context.workingDirectory,
      timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    const passed = expectExit === 0;
    return {
      passed,
      detail: passed
        ? `"${config.run}" exited 0`
        : `"${config.run}" exited 0, expected ${expectExit}. Output: ${truncate(output)}`,
    };
  } catch (error) {
    // execSync throws on non-zero exit or timeout; both are legitimate
    // verification outcomes, not orchestrator-level failures.
    const actualExit = error.status ?? (error.signal ? `signal ${error.signal}` : 'unknown');
    const passed = actualExit === expectExit;
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    return {
      passed,
      detail: passed
        ? `"${config.run}" exited ${actualExit}`
        : `"${config.run}" exited ${actualExit}, expected ${expectExit}. Output: ${truncate(output)}`,
    };
  }
}

function truncate(text) {
  const str = String(text ?? '').trim();
  return str.length > MAX_OUTPUT_CHARS ? `${str.slice(0, MAX_OUTPUT_CHARS - 1)}…` : str;
}

export default { type, run };
