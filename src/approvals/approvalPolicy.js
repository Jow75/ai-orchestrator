/**
 * approvalPolicy.js — Phase 10A/10B: approval classification & operating modes.
 *
 * Pure logic, no I/O. Given an approval *category* (a free-form string such
 * as 'tests', 'production-deployment', or 'implementation-plan') and the
 * effective configuration, this module answers two questions:
 *
 *   1. Which approval CLASS does this category belong to?
 *        - 'automatic'             routine development work
 *        - 'implementation-review' an AI-presented plan awaiting review
 *        - 'owner-gate'            actions that always need the owner
 *        - 'human-action'          the AI physically cannot continue
 *   2. Under the current OPERATING MODE, does that class proceed
 *      automatically or pause for a decision?
 *
 * The category lists are configurable (`approvals.automaticCategories`,
 * `approvals.ownerGateCategories`, `approvals.humanActionCategories`); a
 * category found in none of them FAILS CLOSED — it is treated as an owner
 * gate, matching the codebase's fail-closed philosophy (P0's unmeasurable
 * workspace counts as no-progress for the same reason).
 */

/** The three operating modes (Phase 10B). */
export const MODES = Object.freeze(['conservative', 'balanced', 'autonomous']);

/** The four approval classes (Phase 10A). */
export const APPROVAL_CLASSES = Object.freeze([
  'automatic',
  'implementation-review',
  'owner-gate',
  'human-action',
]);

/** The category the plan-marker detection uses (see approvalManager). */
export const PLAN_CATEGORY = 'implementation-plan';

/** True if `mode` is one of the known {@link MODES}. */
export function isKnownMode(mode) {
  return MODES.includes(mode);
}

/**
 * The effective approvals config for a project: the project's own
 * `approvals` block merged over the global one. Mirrors how per-project
 * `progress` overrides work (P1) — flat merge, project wins per key.
 *
 * @param {object} globalConfig - The global `approvals` config block.
 * @param {object} [project] - Validated project config (optional).
 * @returns {object}
 */
export function effectiveApprovalConfig(globalConfig, project) {
  return { ...(globalConfig ?? {}), ...(project?.approvals ?? {}) };
}

/**
 * Classify a category into an approval class.
 *
 * @param {string} category - Free-form category string.
 * @param {object} config - Effective approvals config (category lists).
 * @returns {string} One of {@link APPROVAL_CLASSES}.
 */
export function classifyCategory(category, config = {}) {
  if ((config.humanActionCategories ?? []).includes(category)) return 'human-action';
  if ((config.ownerGateCategories ?? []).includes(category)) return 'owner-gate';
  if (category === PLAN_CATEGORY) return 'implementation-review';
  if ((config.automaticCategories ?? []).includes(category)) return 'automatic';
  // Unknown category: fail closed — require the owner.
  return 'owner-gate';
}

/**
 * Decide whether an approval class proceeds automatically under a mode.
 *
 *   class \ mode           conservative   balanced   autonomous
 *   automatic              pause          proceed    proceed
 *   implementation-review  pause          pause      proceed
 *   owner-gate             pause          pause      pause
 *   human-action           pause          pause      pause
 *
 * Human-action always pauses by nature: it exists precisely because the AI
 * cannot continue without a human doing something in the physical world.
 *
 * @param {object} params
 * @param {string} params.approvalClass - One of {@link APPROVAL_CLASSES}.
 * @param {string} params.mode - One of {@link MODES} (unknown ⇒ 'balanced').
 * @returns {{requiresApproval: boolean, reason: string}}
 */
export function decide({ approvalClass, mode }) {
  const effectiveMode = isKnownMode(mode) ? mode : 'balanced';

  if (approvalClass === 'owner-gate') {
    return { requiresApproval: true, reason: 'owner gate — always requires the owner' };
  }
  if (approvalClass === 'human-action') {
    return { requiresApproval: true, reason: 'human action required — the AI cannot continue alone' };
  }
  if (effectiveMode === 'conservative') {
    return { requiresApproval: true, reason: 'conservative mode — everything requires approval' };
  }
  if (approvalClass === 'implementation-review') {
    return effectiveMode === 'autonomous'
      ? { requiresApproval: false, reason: 'autonomous mode — implementation review auto-approved' }
      : { requiresApproval: true, reason: 'implementation review — awaiting owner decision' };
  }
  // 'automatic' in balanced/autonomous.
  return { requiresApproval: false, reason: `${effectiveMode} mode — routine work proceeds automatically` };
}

export default {
  MODES, APPROVAL_CLASSES, PLAN_CATEGORY, isKnownMode,
  effectiveApprovalConfig, classifyCategory, decide,
};
