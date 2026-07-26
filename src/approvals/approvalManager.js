/**
 * approvalManager.js — Phase 10A: the Approval Manager.
 *
 * The centerpiece of Phase 10: instead of blindly pausing (or blindly
 * continuing), the orchestrator asks this manager what a piece of work
 * needs. The manager classifies it (approvalPolicy.js), applies the
 * operating mode (10B), records the decision trail (approvalStore.js),
 * publishes anything that needs the owner through every configured
 * provider (10C), and — when supervision must pause — polls for the
 * owner's decision until it arrives, gracefully and abortably.
 *
 * Four request kinds flow through here:
 *   - automatic            recorded auto-approved; work continues
 *   - implementation-review a detected plan, summarized for the owner
 *                          (APPROVE / REJECT / MODIFY)
 *   - owner-gate           configured always-ask categories
 *   - human-action         the AI physically cannot continue; the owner
 *                          is told what/why/where and replies DONE
 *
 * Emits (subscribed by the notification engine, timeline, and lifecycle —
 * exactly like orchestrator domain events):
 *   'approval:required'      { project, request, title, message }
 *   'approval:resolved'      { project, request }
 *   'human-action:required'  { project, request, title, message }
 */

import { EventEmitter } from 'node:events';
import { sleep } from '../infra/time.js';
import {
  classifyCategory, decide, effectiveApprovalConfig, PLAN_CATEGORY,
} from './approvalPolicy.js';
import { renderImplementationSummary } from './implementationSummary.js';

export class ApprovalManager extends EventEmitter {
  /**
   * @param {object} options
   * @param {object} options.config - The global `approvals` config block.
   * @param {import('./approvalStore.js').ApprovalStore} options.store
   * @param {import('./providers/approvalProvider.js').ApprovalProvider[]} [options.providers]
   * @param {object} options.logger
   */
  constructor({ config, store, providers = [], logger }) {
    super();
    this.config = config ?? { enabled: false };
    this.store = store;
    this.providers = providers;
    this.logger = logger;
    // Request ids this process has already announced as resolved — a
    // decision can be observed twice (provider poll + the store re-check in
    // waitForDecision), but must only ever be announced once.
    this.emittedResolutions = new Set();
  }

  /** Emit 'approval:resolved' exactly once per request per process. */
  emitResolved(project, request) {
    if (this.emittedResolutions.has(request.id)) return;
    this.emittedResolutions.add(request.id);
    this.emit('approval:resolved', { project, request });
  }

  /** Whether the approval system is active at all. */
  get enabled() {
    return this.config.enabled !== false;
  }

  /** The effective mode for a project ('balanced' when unset). */
  modeFor(projectConfig) {
    return effectiveApprovalConfig(this.config, projectConfig).mode ?? 'balanced';
  }

  /** Classify + decide for one category under a project's effective config. */
  evaluate(category, projectConfig) {
    const effective = effectiveApprovalConfig(this.config, projectConfig);
    const approvalClass = classifyCategory(category, effective);
    const decision = decide({ approvalClass, mode: effective.mode });
    return { approvalClass, ...decision };
  }

  /**
   * Request approval for one piece of work.
   *
   * Auto-approvable work is recorded (audit trail) and returns immediately
   * with `approved: true`. Anything else is persisted pending, published to
   * every provider, announced via 'approval:required', and returned with
   * `approved: false` — callers then `waitForDecision()`. If a PENDING
   * request already exists for the same (project, taskId, category) — e.g.
   * a stop/resume or crash recovery re-entering a gate that never got a
   * decision — that request is reused as-is: no new id, no re-publish, no
   * re-announcement (Phase 11 M2; see approvalStore.findPending).
   *
   * @param {object} params
   * @param {string} params.project - Project name.
   * @param {string} params.category - Approval category.
   * @param {string} params.title - One-line human title.
   * @param {string} [params.summary] - Rendered summary body.
   * @param {object} [params.details] - Structured extras.
   * @param {string} [params.taskId]
   * @param {object} [params.projectConfig] - For per-project mode overrides.
   * @returns {Promise<{approved: boolean, auto?: boolean, request: object|null}>}
   */
  async requestApproval({ project, category, title, summary, details, taskId, projectConfig }) {
    const { approvalClass, requiresApproval, reason } = this.evaluate(category, projectConfig);

    if (!this.enabled || !requiresApproval) {
      const request = this.store?.create(project, {
        category, approvalClass, title, summary, details, taskId, status: 'auto-approved',
      }) ?? null;
      this.logger.info('Approval auto-granted by policy', { project, category, approvalClass, reason });
      return { approved: true, auto: true, request };
    }

    // Phase 11 M2: reuse an existing PENDING request for this exact
    // (project, taskId, category) instead of minting a new id and
    // re-publishing. Without this, a stop/resume or crash recovery that
    // re-enters a still-ungranted gate created a FRESH request every time
    // and re-announced it through every provider — paging the owner again
    // for a decision they hadn't even had a chance to make yet.
    const existing = this.store?.findPending(project, { taskId: taskId ?? null, category });
    if (existing) {
      this.logger.info('Reusing existing pending approval request (not re-publishing)', {
        project, id: existing.id, category,
      });
      return { approved: false, request: existing };
    }

    const request = this.store?.create(project, {
      category, approvalClass, title, summary, details, taskId,
    });
    if (!request) {
      // No store configured (minimal test harness): fail open only for
      // 'automatic', otherwise refuse — an unpersistable gate is unsafe.
      const failOpen = approvalClass === 'automatic';
      this.logger.warn('Approval store unavailable; cannot persist request', {
        project, category, failOpen,
      });
      return { approved: failOpen, auto: failOpen, request: null };
    }

    const message = this.renderRequestMessage(request);
    await this.publish(request, title, message);
    const event = approvalClass === 'human-action' ? 'human-action:required' : 'approval:required';
    this.emit(event, { project, request, title, message });
    this.logger.info('Approval required — mission pausing for decision', {
      project, id: request.id, category, approvalClass, reason,
    });
    return { approved: false, request };
  }

  /**
   * Report a situation the AI cannot resolve alone (10A human interaction):
   * what happened, why it stopped, what the owner must do, and where.
   * Returns the pending request; callers `waitForDecision()` for the DONE.
   */
  async requestHumanAction({ project, category, what, why, actionRequired, where, taskId, projectConfig }) {
    const summary = [
      `What happened: ${what}`,
      `Why it stopped: ${why}`,
      `Action required: ${actionRequired}`,
      `Where: ${where}`,
    ].join('\n');
    return this.requestApproval({
      project,
      category,
      title: `Human action required — ${project}`,
      summary,
      details: { what, why, actionRequired, where },
      taskId,
      projectConfig,
    });
  }

  /**
   * Build the owner-facing implementation-review request from a detected
   * plan (see implementationSummary.js) and publish it.
   */
  async requestImplementationReview({ project, summary, taskId, projectConfig }) {
    return this.requestApproval({
      project,
      category: PLAN_CATEGORY,
      title: `Implementation review — ${project}`,
      summary: renderImplementationSummary(summary),
      details: summary,
      taskId,
      projectConfig,
    });
  }

  /** The response instructions appended to every published request. */
  renderRequestMessage(request) {
    const lines = [request.summary ?? request.title, ''];
    if (request.approvalClass === 'human-action') {
      lines.push(`When completed, reply: DONE ${request.id}`);
    } else {
      lines.push(
        `Reply: APPROVE ${request.id} · REJECT ${request.id} [reason] · MODIFY ${request.id} <changes>`
      );
    }
    lines.push(`(or: ai-orchestrator approvals approve ${request.id})`);
    return lines.join('\n');
  }

  /** Publish one request to every provider (best-effort, like notifications). */
  async publish(request, title, message) {
    await Promise.allSettled(
      this.providers.map(async (provider) => {
        try {
          await provider.publish({ request, title, message });
        } catch (error) {
          this.logger.warn('Approval provider failed to publish', {
            provider: provider.name, id: request.id, error: error.message,
          });
        }
      })
    );
  }

  /**
   * Poll every two-way provider once and apply any decisions to the store.
   * Returns the requests that were resolved this round.
   */
  async pollProvidersOnce() {
    const resolved = [];
    for (const provider of this.providers.filter((p) => p.canReceive)) {
      let decisions = [];
      try {
        // eslint-disable-next-line no-await-in-loop
        decisions = await provider.fetchDecisions();
      } catch (error) {
        this.logger.warn('Approval provider poll failed', {
          provider: provider.name, error: error.message,
        });
      }
      for (const { requestId, decision, note, by } of decisions) {
        const result = this.store.resolveById(requestId, {
          decision, note, by, via: provider.name,
        });
        if (result.ok) {
          resolved.push(result.request);
          this.emitResolved(result.request.project, result.request);
        } else {
          this.logger.warn('Ignored remote decision', { requestId, decision, reason: result.reason });
        }
      }
    }
    return resolved;
  }

  /**
   * Resolve a request locally (CLI / API / desktop).
   * @returns {{ok: boolean, reason?: string, request?: object}}
   */
  resolve(project, id, { decision, note, by, via }) {
    const result = this.store.resolve(project, id, { decision, note, by, via });
    if (result.ok) {
      this.emitResolved(project, result.request);
    }
    return result;
  }

  /**
   * Pause until the owner decides (or the wait is aborted / times out).
   * The poll cadence and timeout come from config — per-project
   * `approvals.decisionPollMs`/`decisionTimeoutMs` override the globals
   * when `projectConfig` is supplied; timeout 0 waits forever — a paused
   * mission is always recoverable, exactly like a rate-limit wait.
   *
   * @param {object} request - The pending request.
   * @param {{signal?: AbortSignal, projectConfig?: object}} [options]
   * @returns {Promise<object>} The final request record. Status remains
   *   'pending' only when the wait was aborted (operator stop).
   */
  async waitForDecision(request, { signal, projectConfig } = {}) {
    const effective = effectiveApprovalConfig(this.config, projectConfig);
    const pollMs = effective.decisionPollMs ?? 15_000;
    const timeoutMs = effective.decisionTimeoutMs ?? 0;
    const startedAt = Date.now();

    for (;;) {
      const current = this.store.get(request.project, request.id) ?? request;
      if (current.status !== 'pending') {
        // A resolution written by ANOTHER process (CLI/desktop while this
        // orchestrator waited) still gets announced here — exactly once.
        this.emitResolved(request.project, current);
        return current;
      }
      if (timeoutMs > 0 && Date.now() - startedAt >= timeoutMs) {
        this.store.resolve(request.project, request.id, {
          decision: 'expired', by: 'system', via: 'timeout',
        });
        const expired = this.store.get(request.project, request.id);
        this.emitResolved(request.project, expired);
        return expired;
      }
      // eslint-disable-next-line no-await-in-loop
      await this.pollProvidersOnce();
      if (signal?.aborted) return this.store.get(request.project, request.id) ?? current;
      // eslint-disable-next-line no-await-in-loop
      await sleep(pollMs, signal);
      if (signal?.aborted) return this.store.get(request.project, request.id) ?? current;
    }
  }
}

export default ApprovalManager;
