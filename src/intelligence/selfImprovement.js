/**
 * selfImprovement.js — Phase 10I: learn from historical mission data.
 *
 * Mines what every completed run already left behind — progress ledgers
 * (now with per-run duration + agent id), the P5 failure catalog and task
 * history, per-agent health tallies, verification results stored on task
 * queues, and the approval audit trail — and surfaces patterns as
 * RECOMMENDATIONS. Nothing here rewrites code or config automatically;
 * the owner decides what to change (the same rule as Phase 10E).
 *
 * Findings produced:
 *   - recurring failures        same failure category hitting repeatedly
 *   - successful strategies     agents/verifier types with strong pass rates
 *   - slow agents               high attempts-per-done or long average runs
 *   - verification bottlenecks  verifier types that fail most often
 *   - common approval types     what the owner is asked to approve most
 *   - common patterns           dominant run exit reasons across missions
 */

export class SelfImprovement {
  /**
   * @param {object} deps - Read-only collaborators.
   * @param {() => string[]} deps.listProjects
   * @param {import('../progress/progressLedger.js').ProgressLedger} deps.ledger
   * @param {import('../memory/memoryStore.js').MemoryStore} deps.memoryStore
   * @param {import('../mission/taskQueue.js').TaskQueue} deps.taskQueue
   * @param {import('../agents/agentHealth.js').AgentHealth} [deps.agentHealth]
   * @param {import('../approvals/approvalStore.js').ApprovalStore} [deps.approvalStore]
   * @param {object} deps.logger
   */
  constructor(deps) {
    Object.assign(this, deps);
  }

  /**
   * Analyze all projects (or one).
   * @param {string} [onlyProject]
   * @returns {{generatedAt: string, findings: object, recommendations: object[]}}
   */
  analyze(onlyProject) {
    const projects = onlyProject ? [onlyProject] : this.listProjects();
    const findings = {
      recurringFailures: this.recurringFailures(projects),
      agentPerformance: this.agentPerformance(),
      verifierStats: this.verifierStats(projects),
      approvalStats: this.approvalStats(projects),
      exitReasonStats: this.exitReasonStats(projects),
    };
    return {
      generatedAt: new Date().toISOString(),
      projects,
      findings,
      recommendations: this.recommend(findings),
    };
  }

  /** Failure categories that hit 2+ times (per project), resolved or not. */
  recurringFailures(projects) {
    const byCategory = new Map();
    for (const project of projects) {
      for (const failure of this.memoryStore.load(project)?.failures ?? []) {
        const key = `${project}::${failure.category}`;
        const entry = byCategory.get(key) ?? {
          project, category: failure.category, count: 0, unresolved: 0, lastReason: null,
        };
        entry.count += 1;
        if (!failure.resolved) entry.unresolved += 1;
        entry.lastReason = failure.reason;
        byCategory.set(key, entry);
      }
    }
    return [...byCategory.values()].filter((e) => e.count >= 2)
      .sort((a, b) => b.count - a.count);
  }

  /** Per-agent outcome/pace stats from the health tallies. */
  agentPerformance() {
    if (!this.agentHealth) return [];
    const all = this.agentHealth.load();
    return Object.values(all).map((record) => {
      const finished = (record.tasksDone ?? 0) + (record.tasksFailed ?? 0) + (record.tasksBlocked ?? 0);
      return {
        agentId: record.agentId,
        finished,
        doneRate: finished ? (record.tasksDone ?? 0) / finished : null,
        attemptsPerDone: record.tasksDone ? (record.totalAttempts ?? 0) / record.tasksDone : null,
        avgRunMs: record.totalRuns ? Math.round((record.totalRunMs ?? 0) / record.totalRuns) : null,
      };
    }).filter((a) => a.finished > 0 || a.avgRunMs !== null);
  }

  /** Pass/fail counts per verifier type, from queue checkpoints + last results. */
  verifierStats(projects) {
    const byType = new Map();
    const tally = (type, passed) => {
      const entry = byType.get(type) ?? { type, passes: 0, failures: 0 };
      if (passed) entry.passes += 1;
      else entry.failures += 1;
      byType.set(type, entry);
    };
    for (const project of projects) {
      for (const task of this.taskQueue.load(project)?.tasks ?? []) {
        for (const result of task.checkpoint?.verify?.results ?? []) {
          tally(result.type, result.passed);
        }
        // A mid-retry failure that never reached a checkpoint still counts.
        if (task.lastVerifyResult && !task.checkpoint) {
          for (const result of task.lastVerifyResult.results ?? []) {
            tally(result.type, result.passed);
          }
        }
      }
    }
    return [...byType.values()].sort((a, b) => b.failures - a.failures);
  }

  /** What the owner gets asked to approve, by category. */
  approvalStats(projects) {
    if (!this.approvalStore) return [];
    const byCategory = new Map();
    for (const project of projects) {
      for (const request of this.approvalStore.list(project)) {
        const entry = byCategory.get(request.category)
          ?? { category: request.category, total: 0, autoApproved: 0, rejected: 0 };
        entry.total += 1;
        if (request.status === 'auto-approved') entry.autoApproved += 1;
        if (request.status === 'rejected') entry.rejected += 1;
        byCategory.set(request.category, entry);
      }
    }
    return [...byCategory.values()].sort((a, b) => b.total - a.total);
  }

  /** Dominant run exit reasons across recent ledger history. */
  exitReasonStats(projects) {
    const byReason = new Map();
    for (const project of projects) {
      for (const run of this.ledger.recent(project, 100)) {
        const reason = run.exitReason ?? run.cause ?? 'unknown';
        byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
      }
    }
    return [...byReason.entries()].map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count);
  }

  /** Turn findings into owner-facing recommendations. */
  recommend(findings) {
    const recommendations = [];

    for (const failure of findings.recurringFailures) {
      recommendations.push({
        type: 'recurring-failure', priority: failure.unresolved ? 'high' : 'medium',
        title: `"${failure.category}" has failed ${failure.count}× on ${failure.project}`,
        detail: `Last: ${failure.lastReason}. A repeating category is a fixable root cause — ` +
          'address it once (permissions, prompts, environment) instead of paying for retries.',
      });
    }

    for (const agent of findings.agentPerformance) {
      if (agent.doneRate !== null && agent.finished >= 3 && agent.doneRate >= 0.8) {
        recommendations.push({
          type: 'successful-strategy', priority: 'low',
          title: `Agent "${agent.agentId}" is a reliable finisher (${Math.round(agent.doneRate * 100)}% done)`,
          detail: 'Route more tasks of the kinds it completes to this agent.',
        });
      }
      if (agent.attemptsPerDone !== null && agent.attemptsPerDone > 2.5) {
        recommendations.push({
          type: 'slow-agent', priority: 'medium',
          title: `Agent "${agent.agentId}" needs ~${agent.attemptsPerDone.toFixed(1)} attempts per completed task`,
          detail: 'Its briefings/prompts may be under-specified for the tasks it gets, or the ' +
            'verify conditions are stricter than the prompts explain. Compare with other agents.',
        });
      }
    }

    for (const verifier of findings.verifierStats) {
      const total = verifier.passes + verifier.failures;
      if (verifier.failures >= 3 && verifier.failures / total > 0.5) {
        recommendations.push({
          type: 'verification-bottleneck', priority: 'medium',
          title: `Verifier "${verifier.type}" fails ${verifier.failures}/${total} of its checks`,
          detail: 'Either the tasks under-deliver against it or the check is misconfigured — ' +
            'a bottleneck this consistent is usually the check, not the work.',
        });
      }
    }

    const frequentManual = findings.approvalStats.find(
      (a) => a.total >= 3 && a.autoApproved === 0 && a.rejected === 0
    );
    if (frequentManual) {
      recommendations.push({
        type: 'approval-pattern', priority: 'low',
        title: `You always approve "${frequentManual.category}" (${frequentManual.total}×, 0 rejections)`,
        detail: 'Consider adding it to approvals.automaticCategories (or switching this project ' +
          'to autonomous mode) so it stops interrupting you.',
      });
    }

    const topReason = findings.exitReasonStats[0];
    if (topReason && topReason.reason.includes('no-progress') && topReason.count >= 5) {
      recommendations.push({
        type: 'pattern', priority: 'medium',
        title: `"${topReason.reason}" is the most common run outcome (${topReason.count}×)`,
        detail: 'Runs that end without measurable progress dominate — tighten prompts or add ' +
          'verify conditions that give the agent a concrete finish line.',
      });
    }

    return recommendations;
  }
}

export default SelfImprovement;
