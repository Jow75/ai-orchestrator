/**
 * approvalStore.js — Phase 10A: persisted approval requests.
 *
 * One JSON file per project at `state/approvals/<project>.json` (same
 * atomic-write persistence as every other piece of orchestrator state),
 * plus a tiny global counter file so every request id is short, unique
 * across projects, and easy to type from a phone ("APPROVE A7").
 *
 * A request's lifecycle:
 *
 *   pending ──▶ approved | rejected | modified | done | expired | cancelled
 *   (auto-approved requests are recorded already-decided, purely as an
 *    audit trail of what the policy let through)
 *
 * The store is deliberately dumb: classification and waiting live in
 * `approvalManager.js`; providers publish and collect decisions; the CLI,
 * API, and desktop resolve requests here directly. Like MemoryStore, every
 * method degrades to a safe no-op/empty result when `approvalsDir` is
 * unset (hand-built test configs that predate this phase).
 */

import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic, readJsonSafe } from '../state/statePersistence.js';

/** Statuses a decision can set (plus 'pending' and 'auto-approved'). */
export const DECISIONS = Object.freeze(['approved', 'rejected', 'modified', 'done', 'expired', 'cancelled']);

const COUNTER_FILE = 'counter.json';

export class ApprovalStore {
  /**
   * @param {object} options
   * @param {string} [options.approvalsDir] - Directory for per-project
   *   request files. Absent ⇒ every method is a safe no-op.
   * @param {object} options.logger - Module logger.
   */
  constructor({ approvalsDir, logger }) {
    this.approvalsDir = approvalsDir;
    this.logger = logger;
  }

  file(project) {
    return path.join(this.approvalsDir, `${project}.json`);
  }

  /** Load a project's request record, or null if none/unconfigured. */
  load(project) {
    if (!this.approvalsDir) return null;
    return readJsonSafe(this.file(project), { logger: this.logger });
  }

  /** Load existing record, or create (and persist) an empty one. */
  ensure(project) {
    const existing = this.load(project);
    if (existing) return existing;
    const record = { project, requests: [] };
    this.save(record);
    return record;
  }

  save(record) {
    if (!this.approvalsDir) return;
    try {
      writeJsonAtomic(this.file(record.project), record);
    } catch (error) {
      this.logger.warn('Failed to persist approval requests', {
        project: record.project, error: error.message,
      });
    }
  }

  /** Globally-unique, phone-friendly id: A1, A2, A3, ... */
  nextId() {
    if (!this.approvalsDir) return `A${Date.now()}`;
    const counterFile = path.join(this.approvalsDir, COUNTER_FILE);
    const counter = readJsonSafe(counterFile, { logger: this.logger }) ?? { next: 1 };
    const id = `A${counter.next}`;
    try {
      writeJsonAtomic(counterFile, { next: counter.next + 1 });
    } catch (error) {
      this.logger.warn('Failed to persist approval counter', { error: error.message });
    }
    return id;
  }

  /**
   * Create and persist a new request.
   *
   * @param {string} project
   * @param {object} fields
   * @param {string} fields.category - Approval category (e.g. 'tests').
   * @param {string} fields.approvalClass - Classified class (see approvalPolicy).
   * @param {string} fields.title - One-line human title.
   * @param {string} [fields.summary] - Longer human-readable summary.
   * @param {object} [fields.details] - Structured extras (plan summary, ...).
   * @param {string} [fields.taskId] - Task this request belongs to, if any.
   * @param {string} [fields.status] - Initial status (default 'pending').
   * @returns {object|null} The created request (null when unconfigured).
   */
  create(project, { category, approvalClass, title, summary, details, taskId, status = 'pending' }) {
    if (!this.approvalsDir) return null;
    const record = this.ensure(project);
    const request = {
      id: this.nextId(),
      project,
      category,
      approvalClass,
      title,
      summary: summary ?? null,
      details: details ?? null,
      taskId: taskId ?? null,
      status,
      createdAt: new Date().toISOString(),
      decidedAt: status === 'pending' ? null : new Date().toISOString(),
      decidedBy: null,
      decisionNote: null,
      via: null,
    };
    record.requests.push(request);
    this.save(record);
    return request;
  }

  /** One request by id within a project, or null. */
  get(project, id) {
    const record = this.load(project);
    return record?.requests.find((r) => r.id === id) ?? null;
  }

  /**
   * Resolve a pending request with a decision.
   *
   * @param {string} project
   * @param {string} id
   * @param {{decision: string, note?: string, by?: string, via?: string}} params
   * @returns {{ok: boolean, reason?: string, request?: object}}
   */
  resolve(project, id, { decision, note, by, via }) {
    if (!DECISIONS.includes(decision)) {
      return { ok: false, reason: `Unknown decision "${decision}". Use: ${DECISIONS.join(', ')}.` };
    }
    const record = this.load(project);
    const request = record?.requests.find((r) => r.id === id);
    if (!request) return { ok: false, reason: `No approval request "${id}" for "${project}".` };
    if (request.status !== 'pending') {
      return { ok: false, reason: `Request "${id}" is already ${request.status}.` };
    }
    request.status = decision;
    request.decidedAt = new Date().toISOString();
    request.decidedBy = by ?? 'owner';
    request.decisionNote = note ?? null;
    request.via = via ?? null;
    this.save(record);
    this.logger.info('Approval request resolved', { project, id, decision, via });
    return { ok: true, request };
  }

  /**
   * Resolve a request when only the id is known (remote providers see the
   * id alone). Scans all projects for the pending request.
   *
   * @returns {{ok: boolean, reason?: string, request?: object}}
   */
  resolveById(id, { decision, note, by, via }) {
    const match = this.findById(id);
    if (!match) return { ok: false, reason: `No approval request "${id}" found in any project.` };
    return this.resolve(match.project, id, { decision, note, by, via });
  }

  /**
   * Merge extra fields into a request's `details` (e.g. marking a release
   * approval consumed). Never changes status.
   *
   * @returns {{ok: boolean, reason?: string}}
   */
  annotate(project, id, patch) {
    const record = this.load(project);
    const request = record?.requests.find((r) => r.id === id);
    if (!request) return { ok: false, reason: `No approval request "${id}" for "${project}".` };
    request.details = { ...(request.details ?? {}), ...patch };
    this.save(record);
    return { ok: true };
  }

  /** Find a request by id across every project (or null). */
  findById(id) {
    for (const project of this.listProjects()) {
      const request = this.get(project, id);
      if (request) return request;
    }
    return null;
  }

  /** Pending requests for one project, oldest first. */
  pending(project) {
    const record = this.load(project);
    return record?.requests.filter((r) => r.status === 'pending') ?? [];
  }

  /**
   * Find an existing PENDING request for this project matching the same
   * task (or the task-less legacy slot, `taskId: null`) and category.
   *
   * Phase 11 M2: this is what lets the Approval Manager REUSE a request
   * instead of minting a new one on every stop/resume or crash recovery
   * that re-enters an ungranted gate — the actual root cause of duplicate
   * approval notifications (a fresh id was created and re-published every
   * time, even though the owner's original request was still pending).
   *
   * @param {string} project
   * @param {{taskId?: string|null, category: string}} match
   * @returns {object|null}
   */
  findPending(project, { taskId = null, category }) {
    return this.pending(project).find(
      (r) => (r.taskId ?? null) === taskId && r.category === category
    ) ?? null;
  }

  /** Pending requests across every project, oldest first. */
  pendingAll() {
    return this.listProjects().flatMap((project) => this.pending(project));
  }

  /** All requests for one project (newest last). */
  list(project) {
    return this.load(project)?.requests ?? [];
  }

  /** Every project with a request file. */
  listProjects() {
    if (!this.approvalsDir || !fs.existsSync(this.approvalsDir)) return [];
    return fs.readdirSync(this.approvalsDir)
      .filter((f) => f.endsWith('.json') && f !== COUNTER_FILE && !f.includes('.corrupt-'))
      .map((f) => path.basename(f, '.json'))
      .sort();
  }
}

export default ApprovalStore;
