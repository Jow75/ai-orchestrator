/**
 * missionCard.js — Phase 11 M2: executive Mission Cards.
 *
 * Assembles a structured, phone-readable summary from data the orchestrator
 * ALREADY has at mission-complete/blocked time — no new tracking, nothing
 * invented. Every field is optional and simply omitted when the underlying
 * data isn't available (e.g. a legacy no-tasks mission has no per-task
 * verification to summarize) — a card degrades to what's actually known,
 * exactly like every other Phase 10/11 optional-collaborator.
 *
 * Channels render the SAME card object their own way (Telegram as
 * formatted text today; a channel that supports rich cards later can do
 * more) — assembly is centralized here so every surface reads identically.
 */

import { formatDuration } from '../infra/time.js';
import { gitHead } from '../progress/progressEngine.js';

/**
 * Build a Mission Card.
 *
 * @param {object} params
 * @param {string} params.project
 * @param {object} [params.session] - Session record (createdAt, runs, resumes, crashes).
 * @param {object} [params.queue] - Task queue state (mission mode only) —
 *   `{tasks: [{state, checkpoint: {filesTouched, filesDeleted, verify}}]}`.
 * @param {string} [params.status] - 'complete' | 'blocked' | 'cancelled' | ...
 * @param {string} [params.reason] - Why supervision ended.
 * @param {string} [params.workingDirectory] - Resolves the real git commit
 *   the mission ended on (never invented — null when not a git repo).
 * @param {string} [params.nextRecommendation] - From projectIntelligence's
 *   next-work-item, when the caller has it. Omitted if not supplied.
 * @param {string} [params.operatorAction] - The remedy hint, when the
 *   mission is blocked/needs the owner (e.g. block()'s own hint text).
 * @returns {object} The card. Every field beyond `project`/`status` is optional.
 */
export function buildMissionCard({
  project, session, queue, status = 'complete', reason,
  workingDirectory, nextRecommendation, operatorAction,
}) {
  const card = { project, status };

  if (session?.createdAt) {
    const elapsedMs = Date.now() - Date.parse(session.createdAt);
    if (Number.isFinite(elapsedMs) && elapsedMs >= 0) card.duration = formatDuration(elapsedMs);
  }
  if (session) {
    if (session.runs != null) card.runs = session.runs;
    if (session.resumes) card.resumes = session.resumes; // only when non-zero — real friction worth noting
    if (session.crashes) card.crashes = session.crashes;
  }

  const tasks = queue?.tasks ?? [];
  if (tasks.length) {
    card.tasksDone = tasks.filter((t) => t.state === 'done').length;
    card.tasksTotal = tasks.length;

    const filesTouched = new Set();
    const filesDeleted = new Set();
    let verifiersTotal = 0;
    let verifiersPassed = 0;
    for (const t of tasks) {
      const cp = t.checkpoint;
      if (!cp) continue;
      for (const f of cp.filesTouched ?? []) filesTouched.add(f);
      for (const f of cp.filesDeleted ?? []) filesDeleted.add(f);
      if (cp.verify?.results) {
        verifiersTotal += cp.verify.results.length;
        verifiersPassed += cp.verify.results.filter((r) => r.passed).length;
      }
    }
    if (filesTouched.size || filesDeleted.size) {
      card.filesChanged = [...filesTouched, ...[...filesDeleted].map((f) => `${f} (deleted)`)];
    }
    if (verifiersTotal > 0) {
      card.tests = { passed: verifiersPassed, total: verifiersTotal };
      card.confidence = verifiersPassed === verifiersTotal ? 'verified' : 'partial';
    } else {
      // Real, honest gap: tasks completed but nothing automated checked
      // them — never dress this up as "verified" when it wasn't.
      card.confidence = 'unverified';
    }
  }

  if (reason) card.reason = reason;
  if (operatorAction) card.operatorAction = operatorAction;
  if (nextRecommendation) card.nextRecommendation = nextRecommendation;

  if (workingDirectory) {
    const commit = gitHead(workingDirectory);
    if (commit) card.commit = commit.slice(0, 12);
  }

  return card;
}

/**
 * Render a Mission Card as compact, phone-friendly plain text — used as the
 * message body wherever a rich native card isn't available (every channel
 * today).
 *
 * @param {object} card - From {@link buildMissionCard}.
 * @returns {string}
 */
export function renderMissionCardText(card) {
  const statusLabel = { complete: '✅ Complete', blocked: '⛔ Blocked', cancelled: '⚠️ Cancelled' }[card.status]
    ?? card.status;
  const lines = [`Mission: ${card.project}`, `Status: ${statusLabel}`];

  if (card.duration) lines.push(`Duration: ${card.duration}`);
  if (card.tasksTotal) lines.push(`Tasks: ${card.tasksDone}/${card.tasksTotal} done`);
  if (card.tests) lines.push(`Tests: ${card.tests.passed}/${card.tests.total} passed`);
  if (card.confidence) {
    const label = { verified: 'Verified ✔', partial: 'Partially verified ⚠️', unverified: 'Unverified (no checks ran)' }[card.confidence]
      ?? card.confidence;
    lines.push(`Confidence: ${label}`);
  }
  if (card.filesChanged?.length) {
    lines.push(`Files changed (${card.filesChanged.length}): ${card.filesChanged.slice(0, 8).join(', ')}` +
      (card.filesChanged.length > 8 ? `, +${card.filesChanged.length - 8} more` : ''));
  }
  if (card.commit) lines.push(`Commit: ${card.commit}`);
  if (card.resumes) lines.push(`Resumes: ${card.resumes}`);
  if (card.crashes) lines.push(`Crashes recovered: ${card.crashes}`);
  if (card.reason) lines.push(`Reason: ${card.reason}`);
  if (card.operatorAction) lines.push(`Action needed: ${card.operatorAction}`);
  if (card.nextRecommendation) lines.push(`Next: ${card.nextRecommendation}`);

  return lines.join('\n');
}

export default { buildMissionCard, renderMissionCardText };
