/**
 * agentHealth.js — Phase 9: per-agent health & performance tracking.
 *
 * Two things about each agent, persisted at `state/agents/health.json`:
 *  - **health**: is its engine installed/runnable? (delegates to the
 *    driver's existing `checkInstallation()` — no new engine knowledge here)
 *  - **performance**: running tallies of task outcomes it produced
 *    (done/failed/blocked, total attempts, last used) so an operator — and
 *    the desktop Agents view — can see which agents are pulling their weight.
 *
 * Like `MemoryStore` and the progress ledger, this never throws into
 * supervision: a failed read/write is logged and swallowed. Recording a
 * performance outcome must never be able to fail a mission.
 */

import path from 'node:path';
import { writeJsonAtomic, readJsonSafe } from '../state/statePersistence.js';

/** A fresh, zeroed record for one agent. */
function emptyRecord(agentId) {
  return {
    agentId,
    driver: null,
    installed: null, // null = never checked; true/false once checked
    version: null,
    installError: null,
    lastCheckedAt: null,
    tasksDone: 0,
    tasksFailed: 0,
    tasksBlocked: 0,
    totalAttempts: 0,
    lastUsedAt: null,
    lastOutcome: null,
  };
}

export class AgentHealth {
  /**
   * @param {object} options
   * @param {string} [options.healthFile] - Path to state/agents/health.json.
   *   Absent (some hand-built test configs) → every method is a safe no-op.
   * @param {object} options.logger
   */
  constructor({ healthFile, logger }) {
    this.healthFile = healthFile;
    this.logger = logger;
  }

  /** Load the whole `{ [agentId]: record }` map (empty object if none). */
  load() {
    if (!this.healthFile) return {};
    return readJsonSafe(this.healthFile, { logger: this.logger }) ?? {};
  }

  /** One agent's record, or a fresh zeroed one if unseen. */
  get(agentId) {
    return this.load()[agentId] ?? emptyRecord(agentId);
  }

  save(all) {
    if (!this.healthFile) return;
    try {
      writeJsonAtomic(this.healthFile, all);
    } catch (error) {
      this.logger.warn('Failed to persist agent health', { error: error.message });
    }
  }

  /** Merge a patch into one agent's record and persist. */
  update(agentId, patch) {
    if (!this.healthFile) return;
    const all = this.load();
    all[agentId] = { ...(all[agentId] ?? emptyRecord(agentId)), ...patch };
    this.save(all);
    return all[agentId];
  }

  /**
   * Probe an agent's engine installation via its driver and record the
   * result. Pure delegation — the driver owns all engine specifics.
   *
   * @param {object} agent - Normalized agent profile.
   * @param {import('../drivers/aiDriver.js').AIDriver} driver
   * @param {object} [effectiveProject] - For the driver's executable lookup.
   * @returns {Promise<{ok: boolean, version?: string, error?: string}>}
   */
  async check(agent, driver, effectiveProject = {}) {
    let result;
    try {
      result = await driver.checkInstallation(effectiveProject[driver.id]?.executable);
    } catch (error) {
      result = { ok: false, error: error.message };
    }
    this.update(agent.id, {
      driver: agent.driver,
      installed: result.ok,
      version: result.version ?? null,
      installError: result.ok ? null : (result.error ?? 'unknown'),
      lastCheckedAt: new Date().toISOString(),
    });
    return result;
  }

  /**
   * Record a terminal task outcome an agent produced. `outcome` is one of
   * 'done' | 'failed' | 'blocked'. Never throws.
   *
   * @param {string} agentId
   * @param {'done'|'failed'|'blocked'} outcome
   * @param {number} [attempts] - Launches this task took.
   */
  recordOutcome(agentId, outcome, attempts = 0) {
    if (!this.healthFile) return;
    const record = this.get(agentId);
    const field = { done: 'tasksDone', failed: 'tasksFailed', blocked: 'tasksBlocked' }[outcome];
    this.update(agentId, {
      [field ?? 'tasksDone']: (record[field ?? 'tasksDone'] ?? 0) + 1,
      totalAttempts: (record.totalAttempts ?? 0) + attempts,
      lastUsedAt: new Date().toISOString(),
      lastOutcome: outcome,
    });
  }

  /** Note that an agent was assigned a task (updates lastUsedAt). */
  markUsed(agentId) {
    if (!this.healthFile) return;
    this.update(agentId, { lastUsedAt: new Date().toISOString() });
  }

  /**
   * A merged view: one record per agent in `agents`, backfilled with a
   * zeroed record for any never-seen agent, for the CLI/API/UI to render.
   *
   * @param {object[]} agents - The project's roster.
   * @returns {object[]}
   */
  report(agents) {
    const all = this.load();
    return agents.map((a) => ({
      ...emptyRecord(a.id),
      ...(all[a.id] ?? {}),
      role: a.role,
      driver: a.driver,
      capabilities: a.capabilities,
      enabled: a.enabled,
    }));
  }
}

export default AgentHealth;
