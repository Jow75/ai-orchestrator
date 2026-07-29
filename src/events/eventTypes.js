/**
 * eventTypes.js — Phase 12 M2: the system's event vocabulary.
 *
 * Phase 12 M1 made the daemon the one process that is always there. M2 makes
 * EVENTS the thing every interface reads, so that adding an interface never
 * means touching a worker:
 *
 *     Telegram ─┐
 *     Desktop  ─┼─► Daemon ─► Command Router ─► Event Store ─► Mission Store
 *     CLI      ─┘                                    │
 *     (future) ─┘                                    └─► Workers
 *
 * A worker never learns that Telegram exists. It reads its task queue and
 * writes its state files, exactly as it has since P2 — the daemon derives
 * events from those files (see operator/missionMonitor.js) and from its own
 * actions. That is why M2 adds ZERO lines to the worker path, and why the
 * Phase 12 Invariant survives a second milestone intact.
 *
 * Naming is `domain.past-tense-fact`, dotted — deliberately NOT the colon-
 * separated `mission:complete` used by the in-process orchestrator EventEmitter
 * bus. The two are different things and the difference is worth seeing at a
 * glance: orchestrator events are transient in-process signals between
 * collaborators inside ONE mission; these are durable, ordered, cross-process
 * FACTS about the whole system, persisted and replayable long after the
 * process that produced them exited.
 */

/**
 * Every event type the system may append. A type not in this list is refused
 * by the store (the same typo guard missionLifecycle.js applies to states) —
 * a misspelled event that silently disappears into an append-only log is a
 * bug you find months later, if ever.
 */
export const EVENT_TYPES = Object.freeze([
  // ── the service itself ───────────────────────────────────────────────────
  'daemon.started',
  'daemon.stopped',

  // ── projects ─────────────────────────────────────────────────────────────
  /** The operator switched the active project context (`/project X`). */
  'project.selected',
  /** A `/scan` ran. One event per scan (a count in the payload), never one per candidate. */
  'project.discovered',
  /** A real, discovered folder became a registered project (`/import`). */
  'project.imported',
  /** `/archive` — classification set to 'archived'. */
  'project.archived',
  /** `/restore` — classification returned to the default. */
  'project.restored',
  /** `/hide` — classification set to 'hidden'. */
  'project.hidden',
  /** `/unhide` — classification returned to the default. */
  'project.unhidden',
  /** `/forget` — the project's config file was removed. Files on disk untouched. */
  'project.forgotten',
  /** `/projects classify` applied a proposed classification. */
  'project.classified',

  // ── live configuration (Phase 13 M4) ────────────────────────────────────
  /** A remotely-mutable config key changed. Payload logs the KEY only, never the value. */
  'config.changed',

  // ── missions requested from an interface (M2 Priority 3) ─────────────────
  /** Free text became a mission request awaiting the owner's approval. */
  'mission.created',
  /** The owner approved the request; work is authorized to begin. */
  'mission.approved',
  /** The owner rejected the request; nothing was started. */
  'mission.rejected',
  /** An approved request became a real supervised worker. */
  'mission.started',
  /** A real, evidence-backed phase/progress change (never a guess). */
  'mission.progress',
  'mission.completed',
  'mission.blocked',
  'mission.cancelled',
  'mission.failed',

  // ── approvals (the M1 channel, now event-sourced) ────────────────────────
  'approval.required',
  'approval.accepted',
  'approval.rejected',
  'approval.modified',
  'approval.done',
  'approval.expired',

  // ── workers ──────────────────────────────────────────────────────────────
  'worker.started',
  'worker.completed',
  'worker.failed',
  'worker.stopped',
  'worker.adopted',

  // ── the operator interface ───────────────────────────────────────────────
  /** An inbound message was accepted and routed. */
  'command.received',
  /** An inbound message was refused (unknown, unauthorized, unsafe). */
  'command.rejected',
  /** A destructive action was confirmed and carried out. */
  'command.confirmed',

  // ── outbound ─────────────────────────────────────────────────────────────
  'notification.sent',
]);

const TYPE_SET = new Set(EVENT_TYPES);

/** Whether `type` is a known event type. */
export function isKnownEventType(type) {
  return TYPE_SET.has(type);
}

/**
 * Map an approval decision (`approvalStore.DECISIONS`) to its event type.
 * Returns null for a decision that has no event (nothing is invented to fill
 * a gap — an unmapped decision simply produces no event).
 *
 * @param {string} decision
 * @returns {string|null}
 */
export function approvalEventFor(decision) {
  return {
    approved: 'approval.accepted',
    rejected: 'approval.rejected',
    modified: 'approval.modified',
    done: 'approval.done',
    expired: 'approval.expired',
  }[decision] ?? null;
}

/**
 * Map a terminal mission lifecycle state (`missionLifecycle.TERMINAL_STATES`)
 * to its event type.
 *
 * @param {string} state
 * @returns {string|null}
 */
export function missionEventFor(state) {
  return {
    completed: 'mission.completed',
    blocked: 'mission.blocked',
    cancelled: 'mission.cancelled',
    failed: 'mission.failed',
  }[state] ?? null;
}

export default { EVENT_TYPES, isKnownEventType, approvalEventFor, missionEventFor };
