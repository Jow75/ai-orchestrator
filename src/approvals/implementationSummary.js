/**
 * implementationSummary.js — Phase 10A: turn an AI-presented implementation
 * plan into a compact, owner-facing summary.
 *
 * When a run's final output carries the plan marker (config
 * `approvals.planMarker`), the Approval Manager doesn't just pause — it
 * builds a structured summary the owner can act on from a phone:
 *
 *   objective, estimated duration, estimated files changed, tasks, risks,
 *   affected systems
 *
 * Extraction is honest heuristics, not magic: bullet/numbered lines under
 * headings that mention tasks/steps, risks, files, or systems/components
 * are collected; explicit "Estimated duration:"/"Estimated files:" lines
 * are read directly; anything missing falls back to what the orchestrator
 * itself knows (the task queue's remaining plan, ledger-based average run
 * duration). Pure logic, no I/O.
 */

import { SIMULATION_NOTICE } from '../drivers/simulation.js';

/** Cap list sections so a phone notification stays readable. */
const MAX_ITEMS = 8;

/** Lines that start a recognized section, mapped to summary fields. */
const SECTION_HEADINGS = [
  { field: 'tasks', pattern: /^#+?\s*.*\b(tasks?|steps?|plan)\b|^(tasks?|steps?|plan)\s*:/i },
  { field: 'risks', pattern: /^#+?\s*.*\brisks?\b|^risks?\s*:/i },
  { field: 'files', pattern: /^#+?\s*.*\bfiles?\b|^files?(?: changed| affected)?\s*:/i },
  { field: 'systems', pattern: /^#+?\s*.*\b(systems?|components?|affected areas?)\b|^(systems?|components?)\s*:/i },
];

/** A bullet / numbered-list line, with its text captured. */
const LIST_ITEM = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/;

/**
 * Drop markdown emphasis so a heading can be recognized through it.
 *
 * Found live (2026-07-28, mission M8): a real engine writes plans in markdown,
 * so its headings arrive as `**Tasks (in order):**` and `**Risks:**`. Neither
 * matched SECTION_HEADINGS, so every bullet in the plan — tasks, files and
 * risks alike — accumulated under whichever section had matched last, and the
 * owner's approval showed eight "tasks" with no risks and no files at all.
 *
 * A BULLET MUST SURVIVE THIS. `* item` and `**bold**` both start with an
 * asterisk, and collapsing the first would turn a list item into something that
 * looks like a heading. So a marker is only removed when it is glued to the text
 * it emphasises — `**Risks` — and never when it is followed by a space.
 *
 * Used for MATCHING only. The stripped text is discarded, which is what makes
 * it safe to be slightly over-eager (a line-leading `*.js` loses its asterisk
 * here and nowhere else).
 */
function stripEmphasis(line) {
  return line
    .replace(/(^|\s)[*_]{1,3}(?=[^\s*_])/g, '$1')
    .replace(/(?<=[^\s*_])[*_]{1,3}(?=$|[\s:])/g, '');
}

/**
 * Build the structured summary.
 *
 * @param {object} params
 * @param {string} params.project - Project name.
 * @param {string} params.planText - The agent's final output containing the plan.
 * @param {object} [params.queue] - The persisted task queue (adds remaining plan).
 * @param {number} [params.averageRunMs] - Ledger-derived average run duration.
 * @param {boolean} [params.simulated] - True when the plan came from a scripted
 *   fixture rather than a real engine. The heuristics below cannot tell the
 *   difference — a canned plan parses exactly like an earned one — so the fact
 *   has to be carried in, and disclosed at the gate where it is approved.
 * @returns {object} The summary (see fields below).
 */
export function buildImplementationSummary({
  project, planText, queue, averageRunMs, simulated = false,
}) {
  const text = planText ?? '';
  const lines = text.split('\n');

  const sections = { tasks: [], risks: [], files: [], systems: [] };
  let currentField = null;
  for (const line of lines) {
    const heading = SECTION_HEADINGS.find((s) => s.pattern.test(stripEmphasis(line.trim())));
    if (heading) {
      currentField = heading.field;
      continue;
    }
    const item = line.match(LIST_ITEM);
    if (item && currentField) {
      sections[currentField].push(item[1].trim());
    } else if (line.trim() === '' || /^#/.test(line.trim())) {
      // A blank line or an unrecognized heading ends the current section.
      if (/^#/.test(line.trim())) currentField = null;
    }
  }

  const objective = extractLabeled(text, /objective|goal/i)
    ?? firstMeaningfulLine(lines)
    ?? `Implementation plan for ${project}`;

  const remainingTasks = queue
    ? queue.tasks.slice(queue.currentIndex).map((t) => t.objective ?? t.id)
    : [];
  const tasks = sections.tasks.length ? sections.tasks : remainingTasks;

  const estimatedDuration = extractLabeled(text, /estimated (?:duration|time)/i)
    ?? estimateFromTasks(tasks.length, averageRunMs);

  const estimatedFilesChanged = extractLabeled(text, /estimated files(?: changed)?/i)
    ?? (sections.files.length ? String(sections.files.length) : 'unknown');

  return {
    project,
    simulated,
    objective: truncate(objective, 200),
    estimatedDuration,
    estimatedFilesChanged,
    tasks: tasks.slice(0, MAX_ITEMS).map((t) => truncate(t, 120)),
    risks: sections.risks.slice(0, MAX_ITEMS).map((t) => truncate(t, 120)),
    affectedSystems: sections.systems.slice(0, MAX_ITEMS).map((t) => truncate(t, 120)),
    files: sections.files.slice(0, MAX_ITEMS).map((t) => truncate(t, 120)),
  };
}

/**
 * Render a summary as the owner-facing message body a provider publishes.
 *
 * @param {object} summary - From {@link buildImplementationSummary}.
 * @returns {string}
 */
export function renderImplementationSummary(summary) {
  const parts = [];
  if (summary.simulated) {
    // Above the objective: the estimates below are fiction, and an owner who
    // reads only the first line should learn that rather than the estimates.
    parts.push(`🧪 ${SIMULATION_NOTICE}`, '');
  }
  parts.push(
    `Objective: ${summary.objective}`,
    `Estimated duration: ${summary.estimatedDuration}`,
    `Estimated files changed: ${summary.estimatedFilesChanged}`
  );
  if (summary.tasks.length) {
    parts.push('', 'Tasks:', ...summary.tasks.map((t) => `  • ${t}`));
  }
  if (summary.risks.length) {
    parts.push('', 'Risks:', ...summary.risks.map((t) => `  • ${t}`));
  }
  if (summary.affectedSystems.length) {
    parts.push('', 'Affected systems:', ...summary.affectedSystems.map((t) => `  • ${t}`));
  }
  return parts.join('\n');
}

/**
 * "Label: value" extraction for explicit plan metadata lines.
 *
 * The label is matched through markdown emphasis (a label is never a glob, so
 * stripping is unconditionally safe there). The VALUE is only relieved of a
 * leading emphasis CLOSER — the `**` that `**Objective:** Deliver…` leaves
 * behind, which was being shown to owners verbatim as part of the objective.
 * Nothing else is touched, so a value that legitimately starts with `*` (a
 * glob, a footnote) survives intact.
 */
function extractLabeled(text, labelPattern) {
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(?:[-*•]\s*)?([^:]{2,40}):\s*(.+)$/);
    if (!match || !labelPattern.test(stripEmphasis(match[1]))) continue;
    const value = match[2].replace(/^[*_]{1,3}\s+/, '').trim();
    if (value) return value;
  }
  return null;
}

/** First non-empty, non-heading, non-marker line — a plan's opening statement. */
function firstMeaningfulLine(lines) {
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || /^#/.test(trimmed) || LIST_ITEM.test(line)) continue;
    if (/IMPLEMENTATION PLAN/i.test(trimmed)) continue;
    return trimmed;
  }
  return null;
}

/** Rough duration estimate: tasks × average run time (when known). */
function estimateFromTasks(taskCount, averageRunMs) {
  if (!taskCount || !averageRunMs) return 'unknown';
  const totalMinutes = Math.max(1, Math.round((taskCount * averageRunMs) / 60_000));
  if (totalMinutes < 60) return `~${totalMinutes} min (${taskCount} tasks × avg run)`;
  return `~${(totalMinutes / 60).toFixed(1)} h (${taskCount} tasks × avg run)`;
}

function truncate(text, maxChars) {
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

export default { buildImplementationSummary, renderImplementationSummary };
