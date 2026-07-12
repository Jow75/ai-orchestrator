/**
 * continuationBuilder.js — Phase P4: the Claude Continuation Builder.
 *
 * Before this phase, every resume — after a usage limit, a crash, a
 * network retry, or a failed verification — sent the exact same static
 * string ("Continue from where you left off..."). The agent had no way to
 * know WHY it was being relaunched, WHAT was already done, or — most
 * importantly on a verification-failed retry — WHICH check it failed and
 * why. It had to rediscover all of that from scratch, burning tokens and
 * turns on orientation instead of progress.
 *
 * This module turns the orchestrator's own state (session, task queue,
 * checkpoints, recent ledger entries) into a structured briefing instead.
 * Two entry points, matching the two supervision modes:
 *
 *  - buildLegacyContinuation() — single-prompt missions (no `tasks`).
 *  - buildTaskContinuation()   — mission mode, scoped to the current task:
 *    completed tasks (so they're never redone), remaining tasks (so the
 *    agent knows what's still ahead), and — when this is a retry after a
 *    failed verification — exactly which checks failed and why.
 *
 * Phase P5 extends both with optional cross-session memory: `memoryNotes`
 * (operator-authored durable facts) and `activeFailures` (the unresolved
 * failure catalog — see `src/memory/memoryStore.js`) are relevant to any
 * resume; `buildTaskContinuation()` additionally takes `priorAttempts`,
 * archived history for a task id that ran under an earlier, now-discarded
 * plan (a static-config edit reused the same task id).
 *
 * Pure functions: given already-loaded state, return a prompt string. They
 * perform no I/O themselves; callers (the orchestrator) supply ledger/queue/
 * memory data they already have on hand.
 */

/** Cap how much of a stored result/summary text is quoted into a briefing. */
const MAX_QUOTED_CHARS = 300;

/**
 * Build a continuation prompt for a legacy (single-prompt) mission.
 *
 * @param {object} params
 * @param {object} params.project - Validated project config.
 * @param {string} params.reason - Why this continuation is happening
 *   (e.g. "usage limit reset; resuming", "restarting after crash").
 * @param {object[]} [params.recentRuns] - Recent `progressLedger.recent()`
 *   entries, oldest to newest.
 * @param {object[]} [params.memoryNotes] - Operator-authored durable notes
 *   (Phase P5 — see `MemoryStore#recentNotes()`), most recent first.
 * @param {object[]} [params.activeFailures] - Unresolved failure-catalog
 *   entries (Phase P5 — see `MemoryStore#activeFailures()`), most recent
 *   first.
 * @returns {string}
 */
export function buildLegacyContinuation({
  project, reason, recentRuns = [], memoryNotes = [], activeFailures = [],
}) {
  const lines = [
    '## Mission Continuation Briefing',
    '',
    `**Project:** ${project.name}`,
    `**Why you are being resumed:** ${reason}`,
    '',
  ];

  appendMemory(lines, memoryNotes, activeFailures);
  appendRecentActivity(lines, recentRuns);

  lines.push(
    'Continue from where you left off. Review your progress so far, then ' +
    'carry on with the next unfinished task. Do not repeat completed work. ' +
    `When the entire mission is finished, output the exact text: ${project.mission.completionMarker}`
  );

  return lines.join('\n');
}

/**
 * Build a continuation prompt scoped to the current task of a mission-mode
 * project — the piece that makes retries actionable instead of a blind
 * "continue": it names exactly which verifier failed last time, if any.
 *
 * @param {object} params
 * @param {object} params.project - Validated project config.
 * @param {object} params.queue - Persisted TaskQueue state.
 * @param {object} params.task - The CURRENT task's queue entry (full
 *   definition + runtime state — see TaskQueue#toQueueEntry).
 * @param {string} params.reason - Why this continuation is happening.
 * @param {object[]} [params.recentRuns] - Recent ledger entries (optional
 *   extra context; the task-scoped sections below are usually enough).
 * @param {object[]} [params.memoryNotes] - Operator-authored durable notes
 *   (Phase P5), most recent first.
 * @param {object[]} [params.activeFailures] - Unresolved failure-catalog
 *   entries (Phase P5), most recent first.
 * @param {object[]} [params.priorAttempts] - Archived history for this
 *   exact task id from an earlier, now-superseded plan (Phase P5 — see
 *   `MemoryStore#taskHistoryFor()`), oldest to newest. Distinct from
 *   `task.attempts`/`task.lastVerifyResult`, which cover the *current*
 *   queue's own attempts on this task.
 * @param {object[]} [params.agentMessages] - Phase 10H: unread cross-agent
 *   messages addressed to the agent handling this task (see
 *   `AgentMessageBus#unreadFor()`), oldest to newest.
 * @returns {string}
 */
export function buildTaskContinuation({
  project, queue, task, reason, recentRuns = [],
  memoryNotes = [], activeFailures = [], priorAttempts = [], agentMessages = [],
}) {
  const currentIndex = queue.tasks.indexOf(task);
  const completed = queue.tasks.filter((t) => t.state === 'done');
  const remaining = currentIndex >= 0 ? queue.tasks.slice(currentIndex + 1) : [];

  const lines = [
    '## Mission Continuation Briefing',
    '',
    `**Project:** ${project.name}`,
    `**Why you are being resumed:** ${reason}`,
    '',
    `### Current task: ${task.id}`,
  ];
  if (task.objective) lines.push(`Objective: ${task.objective}`);
  lines.push('');

  if (completed.length) {
    lines.push('### Completed tasks — do NOT redo these', '');
    for (const t of completed) lines.push(`- ${describeTask(t)} ✓`);
    lines.push('');
  }

  if (remaining.length) {
    lines.push('### Remaining tasks after this one', '');
    for (const t of remaining) lines.push(`- ${describeTask(t)}`);
    lines.push('');
  }

  if (priorAttempts.length) {
    lines.push(
      `### Task "${task.id}" was attempted before, under an earlier version of this plan`, ''
    );
    for (const attempt of priorAttempts) {
      const summary = attempt.summary ? `: ${truncate(attempt.summary, MAX_QUOTED_CHARS)}` : '';
      lines.push(`- Ended **${attempt.outcome}** after ${attempt.attempts} attempt(s)${summary}`);
    }
    lines.push('');
  }

  if (task.lastVerifyResult && !task.lastVerifyResult.passed) {
    lines.push(
      `### Your previous attempt (#${task.attempts}) was NOT accepted — here is exactly why`, ''
    );
    for (const r of task.lastVerifyResult.results.filter((r) => !r.passed)) {
      lines.push(`- **${r.type}** failed: ${r.detail}`);
    }
    lines.push('');
  }

  if (task.verify?.length) {
    lines.push('### This task is done only when ALL of these checks pass', '');
    for (const v of task.verify) lines.push(`- ${describeVerifier(v)}`);
    lines.push('');
  } else {
    lines.push(
      `Note: this task has no automated checks — it is considered done when your ` +
      `final response contains the exact text: ${project.mission.completionMarker}`,
      ''
    );
  }

  if (agentMessages.length) {
    lines.push('### Messages from other agents on this mission', '');
    for (const m of agentMessages) {
      const topic = m.topic ? ` [${m.topic}]` : '';
      lines.push(`- **from ${m.from}**${topic}: ${truncate(m.text, MAX_QUOTED_CHARS)}`);
    }
    lines.push('');
  }

  appendMemory(lines, memoryNotes, activeFailures);
  appendRecentActivity(lines, recentRuns);

  lines.push('Continue ONLY from here. Do not repeat completed work.');

  return lines.join('\n');
}

function describeTask(task) {
  return task.objective && task.objective !== task.id
    ? `${task.id}: ${task.objective}`
    : task.id;
}

/** A short, human-readable description of one verifier config. */
function describeVerifier(v) {
  switch (v.type) {
    case 'file-exists':
      return `file exists: \`${v.path}\``;
    case 'command':
      return `command \`${v.run}\` exits ${v.expectExit ?? 0}`;
    case 'output-contains':
      return v.regex
        ? `your output matches the pattern: ${v.pattern}`
        : `your output contains: "${v.pattern}"`;
    case 'files-changed':
      return `these paths are created or modified: ${v.paths.join(', ')}`;
    case 'json-schema':
      return `\`${v.path}\` conforms to its JSON schema`;
    case 'lint':
      return `lint command \`${v.run}\` reports zero problems`;
    case 'dependency':
      return `"${v.name}" is declared as a dependency${v.installed === false ? '' : ' and installed'}`;
    default:
      return `${v.type} (see project config)`;
  }
}

/**
 * Append project memory (Phase P5): durable operator notes and the
 * unresolved-failure catalog. Both are project-wide background, not
 * specific to this one resume — shown in both continuation shapes.
 */
function appendMemory(lines, memoryNotes, activeFailures) {
  if (memoryNotes.length) {
    lines.push('### Project memory (from the operator)', '');
    for (const note of memoryNotes) lines.push(`- **[${note.category}]** ${note.text}`);
    lines.push('');
  }
  if (activeFailures.length) {
    lines.push('### Known problems from past attempts on this project (unresolved)', '');
    for (const failure of activeFailures) {
      const scope = failure.taskId ? `task "${failure.taskId}"` : 'the mission';
      lines.push(`- (${scope}) ${failure.reason}${failure.hint ? ` — ${failure.hint}` : ''}`);
    }
    lines.push('');
  }
}

/** Append a "recent activity" section when ledger entries are available. */
function appendRecentActivity(lines, recentRuns) {
  if (!recentRuns.length) return;
  lines.push('### Recent activity (most recent last)', '');
  for (const run of recentRuns) {
    const summary = run.resultText ? `: ${truncate(firstLine(run.resultText), MAX_QUOTED_CHARS)}` : '';
    lines.push(`- ${run.exitReason ?? run.cause}${summary}`);
  }
  lines.push('');
}

function firstLine(text) {
  return text.split('\n')[0];
}

function truncate(text, maxChars) {
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

export default { buildLegacyContinuation, buildTaskContinuation };
