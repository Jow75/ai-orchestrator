/**
 * projectClassification.js — Phase 13 M3: an owner-set label for what a
 * project IS (production, a demo, archived, …), distinct from
 * `ProjectRegistry`'s computed STATUS (what it's doing right now).
 *
 * Named "classification," deliberately not "lifecycle" —
 * `src/mission/missionLifecycle.js` already owns that word for a
 * mission-RUN state machine (blocked/approval-pending/executing/…).
 * Reusing it here, for an unrelated, owner-set, per-PROJECT concept, is
 * exactly the naming collision to avoid.
 */

export const PROJECT_CLASSIFICATIONS = Object.freeze([
  'production', 'development', 'validation', 'demo', 'archived', 'hidden',
]);

/** What a project is until the owner says otherwise. */
export const DEFAULT_CLASSIFICATION = 'development';

/** Whether `value` is one of the known classifications. */
export function isKnownClassification(value) {
  return PROJECT_CLASSIFICATIONS.includes(value);
}

export default { PROJECT_CLASSIFICATIONS, DEFAULT_CLASSIFICATION, isKnownClassification };
