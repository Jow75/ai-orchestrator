/**
 * missionRequests.js — Phase 12 M2: free text becomes a mission, safely.
 *
 * The directive's Priority 3 is that typing "Build a payroll dashboard" into a
 * phone should produce a plan with real estimates, and that work begins only
 * after the owner approves. The security posture in PHASE_12_PLAN.md §6 states
 * the same requirement from the other side: **no free text may implicitly
 * start work.**
 *
 * So a message never starts anything. It creates a REQUEST, which the owner
 * must approve, and approval is what authorizes a mission. There are therefore
 * two gates on the path from a sentence to a commit, and they answer different
 * questions:
 *
 *   1. THIS GATE (`M3`)  — "do you want me to work on this at all?"
 *      Everything here is knowable before any AI runs: the objective as typed,
 *      the project, its working directory and branch, what is already queued,
 *      and this project's own recent history.
 *
 *   2. THE PLAN GATE (`A9`) — "do you accept THIS plan?"
 *      Phase 10's implementation-review flow, unchanged. The agent plans, emits
 *      the plan marker, and approvals/implementationSummary.js extracts the
 *      real objective, duration, files, tasks and risks FROM THE PLAN. Those
 *      are the estimates the directive asks for.
 *
 * That split is deliberate and is the honest answer to "never invent
 * confidence". Nothing can estimate the files a payroll dashboard will touch
 * before something has looked at the codebase; a number produced at gate 1
 * would be a fabrication wearing a number's clothes. Gate 1 shows only facts
 * and history, clearly labelled as history. Gate 2 shows the real plan.
 *
 * How an approved request reaches a worker: it is written as a prompt file
 * under `state/operator/prompts/` and enqueued as a task on the project's
 * queue (the exact mechanism `tasks add` and `POST /api/tasks/:p/add` have
 * used since P3). No worker code changes; no new execution path exists.
 */

import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic, readJsonSafe } from '../state/statePersistence.js';

/** Statuses a request moves through. */
export const REQUEST_STATUSES = Object.freeze([
  'proposed', 'approved', 'started', 'rejected', 'expired', 'cancelled',
]);

/** Statuses that still allow a decision. */
export const OPEN_STATUSES = Object.freeze(['proposed']);

/** Hard cap on an objective, so one paste cannot become an unbounded prompt. */
export const MAX_OBJECTIVE_CHARS = 4_000;

export class MissionRequestStore {
  /**
   * @param {object} options
   * @param {string} [options.requestsFile] - state/operator/missions.json.
   *   Absent ⇒ every method is a safe no-op (matching ApprovalStore).
   * @param {string} [options.promptsDir] - Where approved objectives are
   *   written as prompt files. Under state/, never inside the user's repo.
   * @param {object} options.logger
   * @param {number} [options.ttlMs] - How long a proposal stays approvable.
   */
  constructor({ requestsFile, promptsDir, logger, ttlMs = 86_400_000 }) {
    this.requestsFile = requestsFile;
    this.promptsDir = promptsDir;
    this.logger = logger;
    this.ttlMs = ttlMs;
  }

  load() {
    if (!this.requestsFile) return { nextId: 1, requests: [] };
    return readJsonSafe(this.requestsFile, { logger: this.logger }) ?? { nextId: 1, requests: [] };
  }

  save(record) {
    if (!this.requestsFile) return;
    try {
      writeJsonAtomic(this.requestsFile, record);
    } catch (error) {
      this.logger?.warn('Failed to persist mission requests', { error: error.message });
    }
  }

  /**
   * Raise a request. This is the ONLY thing a free-text message can do, and it
   * changes nothing about any project.
   *
   * @param {object} params
   * @param {string} params.project
   * @param {string} params.objective - What the owner typed, verbatim.
   * @param {string} [params.by] - Who typed it.
   * @param {string} [params.via] - Which channel it arrived on.
   * @param {object} [params.context] - Facts captured at request time (branch,
   *   commit, queue depth, history). Stored so the proposal can be re-rendered
   *   later showing what was true WHEN IT WAS RAISED, not when it was read.
   * @returns {object|null} The request.
   */
  create({ project, objective, by, via, context }) {
    if (!this.requestsFile) return null;
    const record = this.load();
    const id = `M${record.nextId ?? 1}`;
    const request = {
      id,
      project,
      objective: String(objective).slice(0, MAX_OBJECTIVE_CHARS),
      status: 'proposed',
      createdAt: new Date().toISOString(),
      createdBy: by ?? 'owner',
      via: via ?? null,
      context: context ?? null,
      decidedAt: null,
      decidedBy: null,
      decisionNote: null,
      promptFile: null,
      taskId: null,
      startedAt: null,
    };
    record.requests.push(request);
    record.nextId = (record.nextId ?? 1) + 1;
    this.save(record);
    this.logger?.info('Mission request created', { id, project });
    return request;
  }

  /** One request by id, or null. */
  get(id) {
    return this.load().requests.find((r) => r.id === id) ?? null;
  }

  /**
   * Every still-open request, newest first, having first expired anything past
   * its TTL. A proposal the owner never answered must not be approvable a week
   * later against a workspace that has moved on.
   *
   * @param {string} [project] - Restrict to one project.
   * @returns {object[]}
   */
  open(project) {
    this.expireStale();
    return this.load().requests
      .filter((r) => OPEN_STATUSES.includes(r.status) && (!project || r.project === project))
      .reverse();
  }

  /** All requests for a project, newest first. */
  list(project, limit = 20) {
    const all = this.load().requests.filter((r) => !project || r.project === project);
    return all.slice(-limit).reverse();
  }

  /** Mark every proposal older than the TTL as expired. Returns them. */
  expireStale(now = Date.now()) {
    if (!this.requestsFile || !this.ttlMs) return [];
    const record = this.load();
    const expired = [];
    for (const request of record.requests) {
      if (!OPEN_STATUSES.includes(request.status)) continue;
      const age = now - Date.parse(request.createdAt);
      if (Number.isFinite(age) && age > this.ttlMs) {
        request.status = 'expired';
        request.decidedAt = new Date(now).toISOString();
        request.decidedBy = 'system';
        expired.push(request);
      }
    }
    if (expired.length) this.save(record);
    return expired;
  }

  /**
   * Record a decision on a request. Approval here means AUTHORIZED, not
   * started: the caller (commandRouter) still has to materialize the work and
   * start a worker, and either may fail for its own reasons.
   *
   * @param {string} id
   * @param {{decision: 'approved'|'rejected'|'cancelled', by?: string, note?: string}} params
   * @returns {{ok: boolean, reason?: string, request?: object}}
   */
  decide(id, { decision, by, note }) {
    if (!['approved', 'rejected', 'cancelled'].includes(decision)) {
      return { ok: false, reason: `Unknown decision "${decision}".` };
    }
    const record = this.load();
    const request = record.requests.find((r) => r.id === id);
    if (!request) return { ok: false, reason: `No mission request "${id}".` };
    if (!OPEN_STATUSES.includes(request.status)) {
      return { ok: false, reason: `Mission request "${id}" is already ${request.status}.` };
    }
    request.status = decision;
    request.decidedAt = new Date().toISOString();
    request.decidedBy = by ?? 'owner';
    request.decisionNote = note ?? null;
    this.save(record);
    this.logger?.info('Mission request decided', { id, decision, by });
    return { ok: true, request };
  }

  /** Merge fields into a request (prompt file, task id, worker pid, status). */
  update(id, patch) {
    const record = this.load();
    const request = record.requests.find((r) => r.id === id);
    if (!request) return null;
    Object.assign(request, patch);
    this.save(record);
    return request;
  }

  /**
   * Write an approved objective as a real prompt file.
   *
   * The prompt deliberately instructs the agent to PLAN FIRST and emit the
   * configured plan marker. That is not decoration: it is what routes the run
   * into Phase 10's implementation-review gate, so the owner's second approval
   * carries the agent's own estimates rather than anything this module made up.
   *
   * @param {object} request
   * @param {object} options
   * @param {string} options.planMarker - config `approvals.planMarker`.
   * @param {string} options.completionMarker - the project's completion marker.
   * @returns {string} Absolute path of the written prompt file.
   */
  writePrompt(request, { planMarker, completionMarker }) {
    if (!this.promptsDir) throw new Error('No prompts directory configured for mission requests.');
    fs.mkdirSync(this.promptsDir, { recursive: true });
    const file = path.join(this.promptsDir, `${request.project}-${request.id}.md`);
    fs.writeFileSync(file, renderMissionPrompt(request, { planMarker, completionMarker }), 'utf8');
    return file;
  }
}

/**
 * The prompt an approved request becomes.
 *
 * Written as a normal mission prompt, because that is exactly what it is —
 * there is no special "remote mission" execution path, and inventing one would
 * mean a second code path that only ever runs unattended and unobserved.
 *
 * @param {object} request
 * @param {{planMarker: string, completionMarker: string}} markers
 * @returns {string}
 */
export function renderMissionPrompt(request, { planMarker, completionMarker }) {
  return [
    `# Mission ${request.id} — ${request.project}`,
    '',
    'This mission was requested remotely by the project owner and approved by',
    'them before this run started.',
    '',
    '## Objective',
    '',
    request.objective,
    '',
    '## How to proceed',
    '',
    '1. Read enough of the codebase to understand what this objective actually',
    '   requires here. Do not assume a structure; check.',
    '2. Present an implementation plan BEFORE writing any code. Include:',
    '   - **Objective:** one line restating what you will deliver',
    '   - **Tasks:** the concrete steps, in order',
    '   - **Files:** the files you expect to create or change',
    '   - **Risks:** what could go wrong, and anything you are unsure about',
    '   - **Estimated duration:** your honest estimate',
    '   - **Estimated files changed:** a number',
    `3. End the plan with the exact text: ${planMarker}`,
    '   Then STOP. The owner reviews the plan and approves, rejects, or asks',
    '   for changes. You will be resumed with their decision.',
    '4. After approval, implement the plan. Keep changes scoped to it — if the',
    '   work turns out to need something the plan did not cover, say so rather',
    '   than quietly widening the scope.',
    '',
    '## Completion',
    '',
    'When — and only when — the objective is fully delivered and verified,',
    'output the exact text:',
    '',
    completionMarker,
    '',
  ].join('\n');
}

export default MissionRequestStore;
