/**
 * checkpoint.js — Structured record of "what happened on this task."
 *
 * Every task transition (done, failed, blocked) produces a checkpoint: a
 * plain data snapshot of the objective, the files touched, the verification
 * outcome, and a short summary — persisted alongside the task in the task
 * queue (`state/tasks/<project>.json`).
 *
 * Scope note: this module captures *data*, nothing more. Turning that data
 * into a Claude-facing briefing prompt ("Mission: ... Completed tasks: ...
 * Continue ONLY from here.") is explicitly **Phase P4 — the Continuation
 * Builder** (see ROADMAP.md). Building that here would be scope creep on a
 * phase not yet reached; this module exists so P4 has real, structured
 * history to consume rather than needing to invent it retroactively.
 */

/**
 * Build a checkpoint for a task that just finished being assessed.
 *
 * @param {object} params
 * @param {object} params.task - The normalized task (id, objective, ...).
 * @param {number} params.attempts - Launches spent on this task so far.
 * @param {{created: string[], modified: string[], deleted: string[]}|null} [params.changes]
 *   Full (untruncated) change facts from `progressEngine.analyze()`.
 * @param {{passed: boolean, results: object[]}|null} [params.verifyResult] - Verification outcome.
 * @param {string} [params.resultText] - The agent's final response text.
 * @param {string} params.outcome - 'done' | 'failed' | 'blocked'.
 * @returns {object} A plain, JSON-serializable checkpoint.
 */
export function buildCheckpoint({ task, attempts, changes, verifyResult, resultText, outcome }) {
  return {
    at: new Date().toISOString(),
    taskId: task.id,
    objective: task.objective,
    outcome, // 'done' | 'failed' | 'blocked'
    attempts,
    filesTouched: changes ? [...changes.created, ...changes.modified] : [],
    filesDeleted: changes ? changes.deleted : [],
    verify: verifyResult
      ? { passed: verifyResult.passed, results: verifyResult.results }
      : null,
    summary: truncate(resultText ?? '', 500),
  };
}

function truncate(text, maxChars) {
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

export default { buildCheckpoint };
