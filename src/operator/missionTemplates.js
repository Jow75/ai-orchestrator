/**
 * missionTemplates.js — Phase 14 M6: fixed, reviewed mission-prompt
 * objectives for `/review`, `/architecture`, `/docgen`, and `/refactor`.
 *
 * Per docs/PHASE_14_PLAN.md §1, these are the "Class B" capability — AI has
 * to actually reason about the code, so there is no deterministic shortcut.
 * But that does NOT mean a new execution path: each function here returns
 * plain objective text, and `commandRouter.js`'s `submitMissionTemplate()`
 * hands it to `MissionRequestStore.create()` — the exact same gate-1
 * proposal `handleFreeText()` raises for an owner-typed message. Every
 * existing guarantee (two-gate approval, event logging, checkpoint/artifact
 * reporting, Safe Mode) applies automatically, because nothing about mission
 * execution changes. Nothing in this module touches a file, runs an agent,
 * or reads a diff itself — nothing here has any authority at all.
 *
 * `buildReviewObjective()` is the one function that reads anything: it calls
 * M1's `gitVisibility.gitReport()` purely to choose which of three FIXED
 * template variants applies (no repo / clean repo / dirty repo) — it never
 * invents or embeds a diff of its own. The mission that eventually runs has
 * full read access to the project and is instructed to run `git diff`/
 * `git log` itself.
 */

import { gitReport } from './gitVisibility.js';

/** Appended to every review variant below. */
const REVIEW_GROUND_RULES = [
  'Identify real bugs, correctness issues, security concerns, and',
  'code-quality problems. Do not pad the review with a restatement of what',
  'the code obviously already does.',
  '',
  'Do NOT modify any files. This is a review only, not a fix.',
].join('\n');

/**
 * `/review [project]` — Phase 14 M6. Picks a scope variant from the
 * project's real git state (M1's `gitReport()`), not from anything typed.
 *
 * @param {string} workingDirectory - The target project's real root.
 * @returns {string} The mission objective.
 */
export function buildReviewObjective(workingDirectory) {
  const report = gitReport(workingDirectory);
  let scope;
  if (!report) {
    scope = 'This is not a git repository, so there is no diff to scope the ' +
      'review to — review the project\'s source code as a whole.';
  } else if (report.status?.dirty) {
    scope = 'Review the current uncommitted changes (run `git status` / ' +
      '`git diff` yourself to see them).';
  } else {
    scope = 'There are no uncommitted changes right now, so review the most ' +
      'recent commit(s) instead (run `git log -p -3` or similar yourself).';
  }
  return `Perform a code review of this project.\n\n${scope}\n\n${REVIEW_GROUND_RULES}`;
}

/**
 * `/architecture [project]` — Phase 14 M6. One fixed template; nothing to
 * branch on.
 *
 * @returns {string} The mission objective.
 */
export function buildArchitectureObjective() {
  return [
    'Produce a summary of this project\'s architecture: its major',
    'components/modules, how they relate to each other, the key entry',
    'points, and the overall structure of the codebase. Write it for someone',
    'who has never seen this project before.',
    '',
    'Do NOT modify any files. This is a summary only.',
  ].join('\n');
}

/**
 * `/docgen <path>` — Phase 14 M6. `target` has already been validated (via
 * `fileAccess.js`'s `resolveWithinProject()`, same guard `/file` uses) to
 * exist inside the active project before this is called — see M6's own
 * section of docs/PHASE_14_PLAN.md for why this command has no `[project]`
 * argument.
 *
 * @param {string} target - A path relative to the project root.
 * @returns {string} The mission objective.
 */
export function buildDocgenObjective(target) {
  return [
    `Draft documentation for: ${target}`,
    '',
    'Explain what it does, how it fits into the rest of the project, its',
    'public interface (functions/classes/endpoints, as applicable), and any',
    'non-obvious behavior a future reader would need to know.',
    '',
    'Propose where the documentation should live (a new file, an existing',
    'doc, or inline comments) as part of your plan, before writing it.',
  ].join('\n');
}

/**
 * `/refactor <description>` — Phase 14 M6. A PROPOSAL only, for the
 * first-pass version of this command (see docs/PHASE_14_PLAN.md M6): the
 * mission's own plan-approval gate already stops it before any file is
 * touched, but the objective says so explicitly anyway, because "propose,
 * don't implement" is the entire point of this command, not an incidental
 * side effect of the plan gate existing.
 *
 * @param {string} description - What the owner typed, verbatim.
 * @returns {string} The mission objective.
 */
export function buildRefactorObjective(description) {
  return [
    `Produce a refactor PROPOSAL for: ${description}`,
    '',
    'This mission\'s deliverable is the proposal itself. Do NOT implement',
    'any part of it — not even after your plan is approved at the plan',
    'gate. Cover: the approach, which files would be affected, the risks,',
    'and anything you are unsure about.',
    '',
    'If the owner wants this refactor actually built, they will raise that',
    'as a separate, later mission request. Approval of this plan is not',
    'authorization to write any code.',
  ].join('\n');
}

export default {
  buildReviewObjective, buildArchitectureObjective, buildDocgenObjective, buildRefactorObjective,
};
