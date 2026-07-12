/**
 * activitySummary.js — Phase 10G: the daily/weekly digest text.
 *
 * Reads what already exists — per-project timelines (P0), progress ledgers
 * (P0/P1), and pending approvals (10A) — and composes the owner-facing
 * summary the scheduler sends through the notification engine. Pure
 * assembly over injected readers; no new state.
 */

import { formatDuration } from '../infra/time.js';

/**
 * Build the digest text for the period ending now.
 *
 * @param {object} deps
 * @param {() => string[]} deps.listProjects
 * @param {(project: string) => object[]} deps.readTimeline - Timeline entries.
 * @param {(project: string, n: number) => object[]} deps.recentLedger - Ledger entries.
 * @param {() => object[]} [deps.pendingApprovals] - Pending approval requests.
 * @param {object} params
 * @param {number} params.sinceMs - Period length (24h daily, 7d weekly).
 * @param {Date} [params.now]
 * @returns {string}
 */
export function buildActivitySummary(
  { listProjects, readTimeline, recentLedger, pendingApprovals },
  { sinceMs, now = new Date() }
) {
  const since = new Date(now.getTime() - sinceMs);
  const lines = [`Period: ${since.toLocaleString()} → ${now.toLocaleString()}`, ''];
  let sawActivity = false;

  for (const project of listProjects()) {
    const timeline = readTimeline(project).filter((e) => new Date(e.at) >= since);
    const ledger = recentLedger(project, 200).filter((e) => new Date(e.at) >= since);
    if (!timeline.length && !ledger.length) continue;
    sawActivity = true;

    const count = (event) => timeline.filter((e) => e.event === event).length;
    const progressed = ledger.filter((e) => e.progressed).length;
    const busyMs = ledger.reduce((sum, e) => sum + (e.durationMs ?? 0), 0);

    lines.push(`▸ ${project}`);
    lines.push(
      `  runs ${ledger.length} (${progressed} progressed)` +
      (busyMs ? ` · agent time ${formatDuration(busyMs)}` : '')
    );
    const highlights = [
      ['tasks done', count('task-done')],
      ['completed', count('complete')],
      ['blocked', count('blocked')],
      ['verify failures', count('verify-failed')],
      ['approvals asked', count('approval-required')],
      ['rate limits', count('rate-limit')],
      ['crashes', count('crash')],
    ].filter(([, n]) => n > 0);
    if (highlights.length) {
      lines.push(`  ${highlights.map(([label, n]) => `${label} ${n}`).join(' · ')}`);
    }
    lines.push('');
  }

  if (!sawActivity) lines.push('No mission activity in this period.');

  const pending = pendingApprovals?.() ?? [];
  if (pending.length) {
    lines.push('⚠ Awaiting your decision:');
    for (const request of pending) {
      lines.push(`  ${request.id} [${request.project}] ${request.category} — since ${new Date(request.createdAt).toLocaleString()}`);
    }
  }

  return lines.join('\n').trim();
}

export default { buildActivitySummary };
