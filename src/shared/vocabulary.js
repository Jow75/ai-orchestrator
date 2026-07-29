/**
 * shared/vocabulary.js — Phase 11 M4: one canonical icon/label per concept,
 * shared by every surface that renders one (CLI stdout, notification titles,
 * Mission Cards, doctor).
 *
 * A terminology audit across CLI/notificationEngine/missionCard found real
 * drift: the same "mission succeeded" outcome rendered as a plain checkmark
 * in the CLI, a party emoji in a notification title, and a green check emoji
 * in a Mission Card — three icons for one concept, purely because each
 * surface had its own inline literal. This module is the single source; the
 * three surfaces now import from here instead of hand-rolling their own.
 *
 * Every lookup degrades gracefully (falls back to the raw key) so an
 * unlisted status never throws — this is presentation only, never a source
 * of truth for what a status *means* (missionLifecycle.js/approvalStore.js
 * own that).
 */

/** Mission-outcome icon + label, keyed by the status Mission Cards/CLI use. */
export const OUTCOME = Object.freeze({
  complete: { icon: '✅', label: 'Complete' },
  blocked: { icon: '⛔', label: 'Blocked' },
  cancelled: { icon: '⚠️', label: 'Cancelled' },
  failed: { icon: '✖', label: 'Failed' },
  /** The CLI's own coarse case: it only knows complete-or-not, never which
   * of blocked/cancelled/failed ended a non-complete run. */
  incomplete: { icon: '■', label: 'Supervision ended' },
});

export function outcomeIcon(status) {
  return OUTCOME[status]?.icon ?? 'ℹ️';
}

export function outcomeLabel(status) {
  return OUTCOME[status]?.label ?? status;
}

/** Approval/human-action decision verbs — one wording everywhere a decision is reported. */
export const DECISION_LABEL = Object.freeze({
  pending: 'Pending',
  approved: 'Approved',
  'auto-approved': 'Auto-approved',
  rejected: 'Rejected',
  modified: 'Modified',
  done: 'Done',
  expired: 'Expired',
  cancelled: 'Cancelled',
});

export function decisionLabel(status) {
  return DECISION_LABEL[status] ?? status;
}

/** Verification confidence — reused wherever a Mission Card reports it. */
export const CONFIDENCE_LABEL = Object.freeze({
  verified: 'Verified ✔',
  partial: 'Partially verified ⚠️',
  unverified: 'Unverified (no checks ran)',
});

export function confidenceLabel(confidence) {
  return CONFIDENCE_LABEL[confidence] ?? confidence;
}

/** Pass/fail marks for an individual check or action (doctor, `notify test`). */
export const CHECK_MARK = Object.freeze({ ok: '✔', warn: '⚠', fail: '✘' });

export function checkMark(status) {
  return CHECK_MARK[status] ?? '?';
}

/**
 * Phase 12 M2 — project status as the operator interface reports it (see
 * operator/projectRegistry.js PROJECT_STATUSES). Here rather than inline in
 * the renderer for exactly the reason this module exists: the desktop (M3) is
 * about to render the same registry, and two surfaces disagreeing about what
 * "blocked" looks like is the drift Phase 11 M4 spent a milestone removing.
 */
export const PROJECT_STATUS = Object.freeze({
  running: { icon: '▶️', label: 'Running' },
  'waiting-approval': { icon: '⏸️', label: 'Waiting for you' },
  blocked: { icon: '⛔', label: 'Blocked' },
  queued: { icon: '🕘', label: 'Queued' },
  idle: { icon: '💤', label: 'Idle' },
  misconfigured: { icon: '⚠️', label: 'Misconfigured' },
  missing: { icon: '❌', label: 'Folder missing' },
});

export function projectStatusIcon(status) {
  return PROJECT_STATUS[status]?.icon ?? 'ℹ️';
}

export function projectStatusLabel(status) {
  return PROJECT_STATUS[status]?.label ?? status;
}

/**
 * Phase 12 M2 — the operator-facing name for each mission lifecycle state
 * (missionLifecycle.js LIFECYCLE_STATES). The lifecycle owns what a state
 * MEANS; this is only what the owner is told it is called.
 *
 * Deliberately NOT a bigger vocabulary than the lifecycle actually has. The
 * Phase 12 directive mentions "Packaging" as a phase it would like to see —
 * there is no packaging state in the mission lifecycle today, so none is
 * reported. Inventing a phase to satisfy a wish list would be the exact
 * "simulate work" this project refuses to do.
 */
export const MISSION_PHASE = Object.freeze({
  received: { icon: '📥', label: 'Received' },
  analyzed: { icon: '🔍', label: 'Analyzing' },
  planned: { icon: '📋', label: 'Planning' },
  'approval-pending': { icon: '⏸️', label: 'Waiting for approval' },
  approved: { icon: '👍', label: 'Approved' },
  'agents-assigned': { icon: '🧭', label: 'Assigning work' },
  executing: { icon: '⌨️', label: 'Coding' },
  verifying: { icon: '🧪', label: 'Testing' },
  fixing: { icon: '🔧', label: 'Fixing' },
  completed: { icon: '✅', label: 'Finished' },
  blocked: { icon: '⛔', label: 'Blocked' },
  cancelled: { icon: '⚠️', label: 'Cancelled' },
  failed: { icon: '✖', label: 'Failed' },
});

export function phaseIcon(state) {
  return MISSION_PHASE[state]?.icon ?? 'ℹ️';
}

export function phaseLabel(state) {
  return MISSION_PHASE[state]?.label ?? state;
}

/** Project health levels (Phase 10E ProjectIntelligence). */
export const HEALTH_LABEL = Object.freeze({
  healthy: 'Healthy',
  attention: 'Needs attention',
  unhealthy: 'Unhealthy',
});

export function healthLabel(level) {
  return HEALTH_LABEL[level] ?? level;
}

/** Severity — one-line description used by `notify tune` and docs. */
export const SEVERITY_LABEL = Object.freeze({
  info: 'Info — every notifiable event',
  warning: 'Warning — problems that may need attention soon',
  critical: 'Critical — needs you now (approvals, blocked missions)',
});

export function severityLabel(severity) {
  return SEVERITY_LABEL[severity] ?? severity;
}

export default {
  OUTCOME, outcomeIcon, outcomeLabel,
  DECISION_LABEL, decisionLabel,
  CONFIDENCE_LABEL, confidenceLabel,
  CHECK_MARK, checkMark,
  SEVERITY_LABEL, severityLabel,
};
