/**
 * projectIntelligence.js — Phase 10E: continuous project-level answers.
 *
 * "What should I work on next? Is something already running? Is this
 * project healthy? Should implementation pause?" — answered from state the
 * orchestrator already keeps (sessions, task queue, ledger, memory, agent
 * health, approvals, lifecycle). READ-ONLY by decree: this module generates
 * recommendations; it never executes decisions. Surfaced via `intel <project>`
 * and `GET /api/intelligence/:project`.
 */

import { readyTasks, blockedByDependencies } from '../coordination/dependencyGraph.js';

/** Recent-run window used for health scoring. */
const HEALTH_WINDOW = 10;

export class ProjectIntelligence {
  /**
   * All read-only collaborators, injected (same style as everything here).
   *
   * @param {object} deps
   * @param {import('../config/configManager.js').ConfigManager} deps.configManager
   * @param {import('../state/sessionManager.js').SessionManager} deps.sessionManager
   * @param {import('../mission/taskQueue.js').TaskQueue} deps.taskQueue
   * @param {import('../memory/memoryStore.js').MemoryStore} deps.memoryStore
   * @param {import('../progress/progressLedger.js').ProgressLedger} deps.ledger
   * @param {import('../agents/agentRegistry.js').AgentRegistry} [deps.agentRegistry]
   * @param {import('../agents/agentHealth.js').AgentHealth} [deps.agentHealth]
   * @param {import('../approvals/approvalStore.js').ApprovalStore} [deps.approvalStore]
   * @param {import('../mission/missionLifecycle.js').MissionLifecycle} [deps.lifecycle]
   * @param {object} deps.logger
   */
  constructor(deps) {
    Object.assign(this, deps);
  }

  /**
   * Analyze one project.
   * @param {string} projectName
   * @returns {object} { project, running, health, nextWorkItem, recommendations }
   */
  analyze(projectName) {
    const recommendations = [];
    const active = this.sessionManager.getActiveSession(projectName);
    const queue = this.taskQueue.load(projectName);
    const memory = this.memoryStore.load(projectName);
    const recentRuns = this.ledger.recent(projectName, HEALTH_WINDOW);
    const lifecycle = this.lifecycle?.get(projectName) ?? null;
    const pendingApprovals = this.approvalStore?.pending(projectName) ?? [];

    // ── Is another mission already running? ────────────────────────────────
    const running = Boolean(active && ['running', 'waiting-rate-limit', 'waiting-retry'].includes(active.state));

    // ── Health score ───────────────────────────────────────────────────────
    const health = this.scoreHealth({ queue, memory, recentRuns, active });

    // ── What should run next? ──────────────────────────────────────────────
    const ready = queue ? readyTasks(queue) : [];
    const nextWorkItem = ready.length
      ? { taskId: ready[0].id, objective: ready[0].objective }
      : null;
    if (running) {
      recommendations.push({
        type: 'wait', priority: 'low',
        title: 'A mission is already running',
        detail: `Session ${active.id} is ${active.state} — start nothing else on this project.`,
      });
    } else if (nextWorkItem) {
      recommendations.push({
        type: 'next-work', priority: 'high',
        title: `Work on "${nextWorkItem.taskId}" next`,
        detail: `${nextWorkItem.objective ?? nextWorkItem.taskId} is the highest-value ready ` +
          `backlog item (plan order, dependencies satisfied). Start it with: start ${projectName}`,
      });
    }

    // ── Pending approvals age ──────────────────────────────────────────────
    for (const request of pendingApprovals) {
      const ageMs = Date.now() - new Date(request.createdAt).getTime();
      recommendations.push({
        type: 'approval', priority: ageMs > 3_600_000 ? 'high' : 'medium',
        title: `Approval ${request.id} is waiting (${request.category})`,
        detail: `Pending since ${new Date(request.createdAt).toLocaleString()}. ` +
          `The mission is paused until you decide: approvals approve ${request.id}`,
      });
    }

    // ── Blocked/failed current task ────────────────────────────────────────
    const current = queue?.tasks[queue.currentIndex];
    if (current && ['blocked', 'failed'].includes(current.state)) {
      recommendations.push({
        type: 'unblock', priority: 'high',
        title: `Task "${current.id}" is ${current.state} — decide retry or skip`,
        detail: `${current.checkpoint?.summary ?? 'See the diagnostic report.'} ` +
          `Use "tasks approve ${projectName} ${current.id}" to retry or "tasks skip" to advance.`,
      });
    }

    // ── Dependency-stalled tasks ───────────────────────────────────────────
    for (const stall of queue ? blockedByDependencies(queue) : []) {
      recommendations.push({
        type: 'dependency', priority: 'medium',
        title: `Task "${stall.taskId}" is waiting on ${stall.waitingOn.join(', ')}`,
        detail: 'It cannot start until those tasks are done — no action needed unless they are stuck.',
      });
    }

    // ── Unresolved failures ────────────────────────────────────────────────
    const unresolved = (memory?.failures ?? []).filter((f) => !f.resolved);
    if (unresolved.length >= 2) {
      recommendations.push({
        type: 'failures', priority: 'medium',
        title: `${unresolved.length} unresolved failures on record`,
        detail: 'Every briefing repeats them as warnings. Fix the causes and mark them resolved ' +
          `("memory resolve ${projectName} <id>") to clean future briefings.`,
      });
    }

    // ── Research/implementation pacing ─────────────────────────────────────
    const noProgress = recentRuns.filter((r) => !r.progressed).length;
    if (recentRuns.length >= 5 && noProgress / recentRuns.length > 0.6) {
      recommendations.push({
        type: 'pause', priority: 'high',
        title: 'Most recent runs made no measurable progress — consider pausing',
        detail: `${noProgress}/${recentRuns.length} recent runs changed nothing. The mission may be ` +
          'researching in circles; review the prompts/verify conditions before spending more usage.',
      });
    }

    // ── Agent assignment ───────────────────────────────────────────────────
    recommendations.push(...this.agentRecommendations(projectName, queue));

    return {
      project: projectName,
      generatedAt: new Date().toISOString(),
      running,
      sessionState: active?.state ?? null,
      lifecycleState: lifecycle?.state ?? null,
      health,
      nextWorkItem,
      pendingApprovals: pendingApprovals.map((r) => r.id),
      recommendations,
    };
  }

  /** Health level from recent evidence: healthy / attention / unhealthy. */
  scoreHealth({ queue, memory, recentRuns, active }) {
    const signals = [];
    let score = 100;

    const current = queue?.tasks[queue.currentIndex];
    if (current && ['blocked', 'failed'].includes(current.state)) {
      score -= 40;
      signals.push(`current task is ${current.state}`);
    }
    if (active?.state === 'blocked' || active?.state === 'gave-up') {
      score -= 30;
      signals.push(`session ${active.state}`);
    }
    const unresolved = (memory?.failures ?? []).filter((f) => !f.resolved).length;
    if (unresolved) {
      score -= Math.min(20, unresolved * 5);
      signals.push(`${unresolved} unresolved failure(s)`);
    }
    if (recentRuns.length >= 3) {
      const noProgress = recentRuns.filter((r) => !r.progressed).length;
      const ratio = noProgress / recentRuns.length;
      if (ratio > 0.5) {
        score -= Math.round(20 * ratio);
        signals.push(`${noProgress}/${recentRuns.length} recent runs made no progress`);
      }
    }
    const crashes = recentRuns.filter((r) => r.cause === 'crash').length;
    if (crashes >= 2) {
      score -= 15;
      signals.push(`${crashes} recent crashes`);
    }

    score = Math.max(0, score);
    const level = score >= 75 ? 'healthy' : (score >= 45 ? 'attention' : 'unhealthy');
    if (!signals.length) signals.push('no negative signals');
    return { score, level, signals };
  }

  /** Should another/different agent be assigned? (recommendation only) */
  agentRecommendations(projectName, queue) {
    if (!this.agentRegistry || !this.agentHealth) return [];
    let project;
    try {
      project = this.configManager.getProject(projectName);
    } catch {
      return [];
    }
    const roster = this.agentRegistry.agentsFor(project);
    const report = this.agentHealth.report(roster);
    const recommendations = [];

    for (const agent of report) {
      if (agent.installed === false) {
        recommendations.push({
          type: 'agent', priority: 'high',
          title: `Agent "${agent.agentId}" engine is not installed`,
          detail: `${agent.installError ?? 'Install check failed.'} Tasks routed to it will block.`,
        });
      }
      const finished = agent.tasksDone + agent.tasksFailed + agent.tasksBlocked;
      if (finished >= 3 && agent.tasksDone / finished < 0.5) {
        recommendations.push({
          type: 'agent', priority: 'medium',
          title: `Agent "${agent.agentId}" finishes less than half its tasks`,
          detail: `${agent.tasksDone}/${finished} done. Consider routing its role to a different ` +
            'agent, or reviewing what its tasks ask for.',
        });
      }
    }

    // A pending task naming a role nobody fills lands on the default agent —
    // worth telling the owner explicitly.
    const roles = new Set(roster.map((a) => a.role));
    for (const task of queue?.tasks ?? []) {
      if (task.state === 'pending' && task.role && task.role !== 'general' && !roles.has(task.role)) {
        recommendations.push({
          type: 'agent', priority: 'low',
          title: `No agent fills role "${task.role}" (task "${task.id}")`,
          detail: 'It will fall back to the default agent. Add a matching agent to route it as intended.',
        });
      }
    }
    return recommendations;
  }
}

export default ProjectIntelligence;
