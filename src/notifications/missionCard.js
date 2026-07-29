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
import { outcomeIcon, outcomeLabel, confidenceLabel } from '../shared/vocabulary.js';
import { SIMULATION_NOTICE_PAST } from '../drivers/simulation.js';

/**
 * Verifier result types that are NOT evidence.
 *
 * `marker` is the completion-marker fallback a task gets when it declares no
 * verifiers of its own (orchestrator.js `markerFallbackVerify`). It records
 * one fact: the agent emitted the string "MISSION COMPLETE". That is the agent
 * grading its own homework, and counting it as a passing test is how a mission
 * that wrote zero files came back to an owner as "Tests: 1/1 passed ·
 * Confidence: Verified" during the 2026-07-28 live validation.
 *
 * The marker still has a job — it is how the orchestrator knows a task ended —
 * so it stays in `verify.results`. It is simply not allowed to be counted as
 * verification here, which restores this file's own stated rule: never dress
 * an unchecked task up as a verified one.
 */
const NON_EVIDENCE_VERIFIERS = Object.freeze(['marker']);

/**
 * Is this verifier result actual evidence about the work?
 *
 * Exported because more than one surface aggregates verifier results into a
 * number an owner will trust — the Mission Card's "Tests: n/m" and the
 * operator console's "Verifier pass rate: n%". Both were counting markers, and
 * a rule enforced in one place and not the other is not a rule.
 *
 * @param {{type?: string}} result - One entry of a checkpoint's `verify.results`.
 * @returns {boolean}
 */
export function isEvidenceVerifier(result) {
  return !NON_EVIDENCE_VERIFIERS.includes(result?.type);
}

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
 * @param {boolean} [params.simulated] - True when the engine behind this
 *   mission was a fixture rather than a real one (see drivers/simulation.js).
 *   Surfaces at the TOP of the rendered card, because a reader who stops after
 *   one line must still learn the most important thing about it.
 * @returns {object} The card. Every field beyond `project`/`status` is optional.
 */
export function buildMissionCard({
  project, session, queue, status = 'complete', reason,
  workingDirectory, nextRecommendation, operatorAction, simulated = false,
}) {
  const card = { project, status };
  if (simulated) card.simulated = true;

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
    const filesCreated = new Set();
    const filesModified = new Set();
    // Phase 13 M7: a checkpoint written before this milestone has only the
    // merged `filesTouched` — never guess which bucket those belong in (see
    // renderArtifactSummary's "Changed:" fallback). `sawSplit` is only true
    // once at least one checkpoint actually supplies the new fields.
    let sawSplit = false;
    let verifiersTotal = 0;
    let verifiersPassed = 0;
    for (const t of tasks) {
      const cp = t.checkpoint;
      if (!cp) continue;
      for (const f of cp.filesTouched ?? []) filesTouched.add(f);
      for (const f of cp.filesDeleted ?? []) filesDeleted.add(f);
      if (cp.filesCreated || cp.filesModified) {
        sawSplit = true;
        for (const f of cp.filesCreated ?? []) filesCreated.add(f);
        for (const f of cp.filesModified ?? []) filesModified.add(f);
      }
      // Only real checks count. A completion marker is the agent's own claim
      // about itself, not a check of it (see NON_EVIDENCE_VERIFIERS).
      const evidence = (cp.verify?.results ?? []).filter(
        (r) => !NON_EVIDENCE_VERIFIERS.includes(r.type)
      );
      verifiersTotal += evidence.length;
      verifiersPassed += evidence.filter((r) => r.passed).length;
    }
    if (filesTouched.size || filesDeleted.size) {
      card.filesChanged = [...filesTouched, ...[...filesDeleted].map((f) => `${f} (deleted)`)];
    }
    if (sawSplit) {
      if (filesCreated.size) card.filesCreated = [...filesCreated];
      if (filesModified.size) card.filesModified = [...filesModified];
    }
    if (filesDeleted.size) card.filesDeleted = [...filesDeleted];
    if (verifiersTotal > 0) {
      card.tests = { passed: verifiersPassed, total: verifiersTotal };
      card.confidence = verifiersPassed === verifiersTotal ? 'verified' : 'partial';
    } else {
      // Real, honest gap: tasks completed but nothing automated checked
      // them — never dress this up as "verified" when it wasn't. Reached both
      // by a task that declared no verifiers and by one whose only "result"
      // was the completion marker; those are the same situation.
      card.confidence = 'unverified';
    }
    // A completed mission that touched no file is worth saying out loud. It is
    // the signature of both failure modes this card has actually produced: a
    // simulated engine, and a real engine that answered without write
    // permission (the 2026-07-04 incident). Neither is visible from
    // "Tasks: 1/1 done".
    if (status === 'complete' && !filesTouched.size && !filesDeleted.size) {
      card.noFilesChanged = true;
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
  const statusLabel = `${outcomeIcon(card.status)} ${outcomeLabel(card.status)}`;
  // The simulation notice goes ABOVE the status line, not below the fold. A
  // phone notification preview shows the first line or two, and "Mission
  // complete" is precisely the line that must not travel alone.
  const lines = card.simulated ? [`🧪 ${simulationNoticeFor(card)}`, ''] : [];
  lines.push(`Mission: ${card.project}`, `Status: ${statusLabel}`);

  if (card.duration) lines.push(`Duration: ${card.duration}`);
  if (card.tasksTotal) lines.push(`Tasks: ${card.tasksDone}/${card.tasksTotal} done`);
  if (card.tests) lines.push(`Tests: ${card.tests.passed}/${card.tests.total} passed`);
  if (card.confidence) {
    lines.push(`Confidence: ${confidenceLabel(card.confidence)}`);
  }
  if (card.noFilesChanged) {
    lines.push('Files changed: none — this mission completed without writing anything.');
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

/**
 * Phase 13 M7: a real bug found via this milestone's own live validation.
 * `SIMULATION_NOTICE_PAST` blanket-claims "no code was written" — true for
 * `validation-sandbox` (its origin story) but NOT true in general: the mock
 * driver has always supported scripted `writeFile`/`appendFile` so the
 * progress engine can be exercised end-to-end (see mockDriver.js), and a
 * project can legitimately be `simulated: true` while still writing real
 * files by design. Live-validating M7 against exactly such a fixture
 * produced a message that said "no code was written" directly above a real
 * "Created: src/calculator.js" line — the opposite failure mode from the
 * M2.2 incident this module's own history is built on (there, a mission
 * hid real emptiness behind "Verified"; here, a notice would have hidden
 * real content behind "nothing happened"). Only the completed-mission
 * rendering can check this (a card carries real filesChanged data); the
 * pre-run `SIMULATION_NOTICE` stays untouched — before anything has run,
 * "no code is written yet" is still an accurate forward-looking statement.
 */
function simulationNoticeFor(card) {
  const wroteFiles = card.filesChanged?.length || card.filesCreated?.length
    || card.filesModified?.length || card.filesDeleted?.length;
  if (!wroteFiles) return SIMULATION_NOTICE_PAST;
  return 'Simulated project — this mission was a rehearsal. The engine was a ' +
    'scripted fixture, not real reasoning; any files listed below were part ' +
    'of that script, not independent judgment.';
}

/**
 * Render the FULL, real-path breakdown of what a mission actually did to the
 * filesystem — Phase 13 M7. Deliberately separate from
 * {@link renderMissionCardText}, which stays capped at 8 entries for the
 * compact card body: this is the uncapped, "no important information
 * silently dropped" view, meant for the one-time mission-complete
 * notification, not a repeating status check.
 *
 * When no checkpoint in this mission ever recorded the created/modified
 * split (a checkpoint written before this milestone existed), the files are
 * listed under a neutral "Changed" heading instead — never asserting a file
 * was "created" or "modified" when that was never actually recorded.
 *
 * @param {object} card - From {@link buildMissionCard}.
 * @returns {string} Empty string when there is nothing to report.
 */
export function renderArtifactSummary(card) {
  const sections = [];
  if (card.filesCreated?.length) sections.push(bulletBlock('Created', card.filesCreated));
  if (card.filesModified?.length) sections.push(bulletBlock('Modified', card.filesModified));
  if (card.filesDeleted?.length) sections.push(bulletBlock('Deleted', card.filesDeleted));
  if (!sections.length && card.filesChanged?.length) {
    sections.push(bulletBlock('Changed', card.filesChanged));
  }
  return sections.join('\n\n');
}

function bulletBlock(label, files) {
  return [`${label}:`, ...files.map((f) => `• ${f}`)].join('\n');
}

export default { buildMissionCard, renderMissionCardText, renderArtifactSummary, isEvidenceVerifier };
