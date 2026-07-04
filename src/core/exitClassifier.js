/**
 * exitClassifier.js — Exit-Cause Classifier.
 *
 * The orchestrator only ever acts when the agent process has actually
 * exited. This module answers the next question: WHY did it exit? Every
 * cause maps to a distinct recovery strategy in the orchestrator:
 *
 *   COMPLETED      The engine finished its run normally.
 *   USAGE_LIMIT    The engine hit its usage/rate limit → wait, then resume.
 *   NETWORK        A network failure ended the run → short delay, retry.
 *   INTERRUPTED    Somebody sent SIGINT/SIGTERM → operator stop or external kill.
 *   SPAWN_FAILURE  The engine never started (not installed / bad path).
 *   CRASH          Anything else → crash recovery with backoff.
 *
 * Pure logic, no I/O: engine-specific knowledge arrives via the driver's
 * `exitPatterns`, which keeps this classifier engine-agnostic.
 */

/** @enum {string} */
export const ExitCause = Object.freeze({
  COMPLETED: 'completed',
  USAGE_LIMIT: 'usage-limit',
  NETWORK: 'network',
  INTERRUPTED: 'interrupted',
  SPAWN_FAILURE: 'spawn-failure',
  CRASH: 'crash',
});

/** Exit codes conventionally produced by SIGINT / SIGTERM termination. */
const INTERRUPT_EXIT_CODES = [130, 143];
const INTERRUPT_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGKILL', 'SIGBREAK'];

/**
 * Classify why an agent run ended.
 *
 * @param {object} exitInfo - ExitInfo from AgentRun#waitForExit().
 * @param {{usageLimit: RegExp[], network: RegExp[]}} exitPatterns -
 *   Engine-specific output patterns supplied by the driver.
 * @returns {{cause: string, detail: string}}
 */
export function classifyExit(exitInfo, exitPatterns) {
  const { code, signal, outputTail = '', spawnError, resultText, resultIsError } = exitInfo;

  // 1. The process never started at all — nothing to recover, only to report.
  if (spawnError) {
    return {
      cause: ExitCause.SPAWN_FAILURE,
      detail: `Engine failed to start: ${spawnError.message}`,
    };
  }

  // Search both the raw output tail and the engine's structured result:
  // limit messages can appear in either, and can accompany ANY exit code.
  const haystack = `${outputTail}\n${resultText ?? ''}`;

  // 2. Usage limit beats everything else — even a zero exit code, because
  //    engines commonly exit "cleanly" after printing the limit message.
  if (matchesAny(haystack, exitPatterns.usageLimit)) {
    return {
      cause: ExitCause.USAGE_LIMIT,
      detail: 'Engine reported its usage/rate limit was reached',
    };
  }

  // 3. Signals / interrupt-style exit codes: someone terminated the process.
  if (INTERRUPT_SIGNALS.includes(signal) || INTERRUPT_EXIT_CODES.includes(code)) {
    return {
      cause: ExitCause.INTERRUPTED,
      detail: `Process terminated (${signal ?? `exit code ${code}`})`,
    };
  }

  // 4. Clean exit. An engine-flagged error result with a clean exit code
  //    still means "the run ended in a controlled way" (e.g. max turns
  //    reached) — the orchestrator's continue logic handles unfinished work.
  if (code === 0) {
    return {
      cause: ExitCause.COMPLETED,
      detail: resultIsError
        ? 'Run ended cleanly but the engine flagged the result as an error'
        : 'Run completed normally',
    };
  }

  // 5. Network trouble is transient by nature — retried on a short delay.
  if (matchesAny(haystack, exitPatterns.network)) {
    return {
      cause: ExitCause.NETWORK,
      detail: 'Run failed due to an apparent network problem',
    };
  }

  // 6. Everything else is a crash.
  return {
    cause: ExitCause.CRASH,
    detail: `Unexpected exit (code ${code}${signal ? `, signal ${signal}` : ''})`,
  };
}

function matchesAny(text, patterns = []) {
  return patterns.some((pattern) => pattern.test(text));
}

export default { ExitCause, classifyExit };
