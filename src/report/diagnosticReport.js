/**
 * diagnosticReport.js — Human-readable "why did we stop?" report.
 *
 * When the loop breaker trips or a blocked state is detected, the
 * orchestrator does not merely stop — it explains itself. This writer
 * produces `state/diagnostics/<project>-<timestamp>.md` with the evidence a
 * human needs to fix the blocker: the reason, the likely cause, a concrete
 * recommended fix, recent run history, and the agent's last words.
 *
 * The report is the deliverable the overnight incident should have produced
 * after ~1 minute instead of a silent 13-hour quota fire.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Write a diagnostic report and return its path.
 *
 * @param {object} params
 * @param {string} params.diagnosticsDir - Output directory.
 * @param {object} params.project - Project config (name, workingDirectory).
 * @param {object} params.session - Session record.
 * @param {string} params.reason - Why supervision stopped.
 * @param {string} [params.category] - 'stagnation' | 'permission-denied' | ...
 * @param {string} [params.hint] - Recommended fix.
 * @param {string} [params.evidence] - Excerpt supporting the diagnosis.
 * @param {object[]} [params.recentRuns] - Recent ledger records.
 * @param {object} params.logger - Module logger.
 * @returns {string|null} The report path, or null if writing failed.
 */
export function writeDiagnosticReport({
  diagnosticsDir,
  project,
  session,
  reason,
  category,
  hint,
  evidence,
  recentRuns = [],
  logger,
}) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(diagnosticsDir, `${project.name}-${timestamp}.md`);

  const lines = [
    `# Diagnostic report — ${project.name}`,
    '',
    `**Generated:** ${new Date().toISOString()}`,
    `**Reason supervision stopped:** ${reason}`,
    category ? `**Category:** ${category}` : null,
    '',
    '## Likely cause',
    '',
    hint ?? causeForCategory(category),
    '',
    '## Session',
    '',
    `- Session id: \`${session.id}\``,
    `- Engine session id: \`${session.engineSessionId ?? '(none captured)'}\``,
    `- Working directory: \`${project.workingDirectory ?? '(unknown)'}\``,
    `- Runs: ${session.runs} · resumes: ${session.resumes} · ` +
      `crashes: ${session.crashes} · rate limits: ${session.rateLimits}`,
    `- Consecutive no-progress runs: ${session.consecutiveNoProgress ?? 0}`,
    '',
  ];

  if (evidence) {
    lines.push('## Evidence', '', '```', evidence, '```', '');
  }

  if (recentRuns.length) {
    lines.push('## Recent runs (most recent last)', '');
    for (const r of recentRuns) {
      const flag = r.progressed ? 'progress' : 'NO progress';
      lines.push(
        `- \`${r.at}\` run ${r.run} — ${r.cause} — ${flag} ` +
          `(sig ${short(r.signature)}, via ${r.signatureMethod})` +
          (r.blocked?.blocked ? ` — blocked: ${r.blocked.category}` : '')
      );
      if (r.resultText) {
        lines.push(`  > ${firstLine(r.resultText)}`);
      }
    }
    lines.push('');
  }

  lines.push(
    '## Recommended next steps',
    '',
    '1. Read the "Likely cause" above and the agent\'s last responses.',
    '2. Fix the blocker (permissions, config, or the mission prompt).',
    '3. Re-run the project: `ai-orchestrator start ' + project.name + '`.',
    '   The blocked session is preserved in history; a fresh session starts clean.',
    ''
  );

  try {
    fs.mkdirSync(diagnosticsDir, { recursive: true });
    fs.writeFileSync(file, lines.filter((l) => l !== null).join('\n'), 'utf8');
    logger.info('Diagnostic report written', { file });
    return file;
  } catch (error) {
    logger.warn('Failed to write diagnostic report', { error: error.message });
    return null;
  }
}

function causeForCategory(category) {
  switch (category) {
    case 'stagnation':
      return (
        'The agent ran repeatedly without changing any files. It is likely stuck: ' +
        'the mission may be unclear, already complete, or blocked by something the ' +
        'agent cannot resolve on its own. Inspect the recent runs below.'
      );
    case 'permission-denied':
    case 'no-access':
      return (
        'The agent was denied a permission or access it needed. In headless mode it ' +
        'cannot ask interactively, so it exits without doing the work. Grant the ' +
        'permission via claude.permissionMode / claude.allowedTools.'
      );
    default:
      return 'See the reason and evidence above.';
  }
}

const short = (sig) => (sig ? sig.slice(0, 8) : 'none');
const firstLine = (text) => text.split('\n')[0].slice(0, 200);

export default { writeDiagnosticReport };
