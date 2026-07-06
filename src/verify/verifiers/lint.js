/**
 * verifiers/lint.js — Phase P6: does a lint command report zero problems?
 *
 * Config: `{ type: "lint", run: "npx eslint . -f json", expectExit: 0 }`
 * Same trust model and execution shape as the `command` verifier (the
 * command is trusted config, never agent output) — what's different is the
 * failure detail. ESLint's `-f json` output (an array of
 * `{filePath, messages: [{ruleId, severity, message, line, column}]}`) is
 * parsed, when present, into a specific "file:line [rule] message" list
 * instead of a wall of raw stdout — this is what lets a Continuation
 * Builder retry say exactly which lint rule failed and where, rather than
 * "the lint command exited 1, output: <2000 chars>". Any other linter's
 * output (or ESLint without `-f json`) falls back to the same
 * exit-code-and-truncated-output behavior as `command`.
 */

import { execSync } from 'node:child_process';

export const type = 'lint';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 2_000;
const MAX_ISSUES_SHOWN = 5;

/**
 * @param {{run: string, expectExit?: number, timeoutMs?: number}} config
 * @param {{workingDirectory: string}} context
 * @returns {{passed: boolean, detail: string}}
 */
export function run(config, context) {
  if (!config.run) {
    return { passed: false, detail: 'lint verifier is missing "run"' };
  }
  const expectExit = config.expectExit ?? 0;

  let actualExit = 0;
  let stdout = '';
  let stderr = '';
  try {
    stdout = execSync(config.run, {
      cwd: context.workingDirectory,
      timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
  } catch (error) {
    actualExit = error.status ?? (error.signal ? `signal ${error.signal}` : 'unknown');
    stdout = error.stdout ?? '';
    stderr = error.stderr ?? '';
  }

  const passed = actualExit === expectExit;
  if (passed) {
    return { passed, detail: `"${config.run}" exited ${actualExit} — lint clean` };
  }

  const issueSummary = summarizeEslintJson(stdout);
  if (issueSummary) {
    return { passed, detail: `"${config.run}" reported problems: ${issueSummary}` };
  }
  const output = truncate(`${stdout}${stderr}`);
  return {
    passed,
    detail: `"${config.run}" exited ${actualExit}, expected ${expectExit}. Output: ${output}`,
  };
}

/**
 * Parse ESLint's `-f json` output into a concise, ranked failure summary.
 * Returns null (triggering the generic fallback) for anything that isn't
 * that exact shape — this is a best-effort enhancement, not a requirement.
 */
function summarizeEslintJson(stdout) {
  let files;
  try {
    files = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(files)) return null;

  const issues = [];
  for (const file of files) {
    if (!file?.filePath || !Array.isArray(file.messages)) return null; // not the expected shape
    for (const m of file.messages) {
      issues.push(`${relativeish(file.filePath)}:${m.line ?? '?'} [${m.ruleId ?? 'parse-error'}] ${m.message}`);
    }
  }
  if (!issues.length) return null;

  const shown = issues.slice(0, MAX_ISSUES_SHOWN);
  const more = issues.length > shown.length ? ` (+${issues.length - shown.length} more)` : '';
  return `${issues.length} problem(s) — ${shown.join('; ')}${more}`;
}

/** Best-effort trim of a possibly-absolute ESLint file path for readability. */
function relativeish(filePath) {
  const parts = filePath.split(/[\\/]/);
  return parts.slice(-2).join('/');
}

function truncate(text) {
  const str = String(text ?? '').trim();
  return str.length > MAX_OUTPUT_CHARS ? `${str.slice(0, MAX_OUTPUT_CHARS - 1)}…` : str;
}

export default { type, run };
