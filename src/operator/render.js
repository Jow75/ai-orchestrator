/**
 * render.js — Phase 12 M2: what the owner actually sees on a phone.
 *
 * Pure functions from data to plain text. No I/O, no state, no formatting
 * escapes — the channel owns escaping (see notifications/telegramFormat.js,
 * which HTML-escapes and protects filenames from Telegram's auto-linkifier).
 * Emitting raw text here means the same renderers serve a future Discord,
 * desktop, or web client with no un-escaping to undo first.
 *
 * Written for a phone screen, which is the actual constraint: about six lines
 * before scrolling, read one-handed, often while walking. So every renderer
 * leads with the answer, keeps lists short and countable, and never pads.
 *
 * Icons and labels come from shared/vocabulary.js rather than inline literals,
 * for the reason that module exists at all.
 */

import { formatDuration } from '../infra/time.js';
import {
  projectStatusIcon, projectStatusLabel, phaseIcon, phaseLabel,
  healthLabel, decisionLabel,
} from '../shared/vocabulary.js';
import { COMMANDS } from './commandGrammar.js';

/** Longest list a single phone message should carry before it is summarized. */
const MAX_LIST = 10;

/**
 * "4 min ago" / "2 h ago" / "3 d ago". Null timestamps render as 'never',
 * which is a real and useful answer for a project that has not run.
 */
export function relativeTime(iso, now = Date.now()) {
  if (!iso) return 'never';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return 'unknown';
  const delta = now - then;
  if (delta < 0) return 'just now';
  if (delta < 60_000) return 'just now';
  return `${formatDuration(delta)} ago`;
}

/** One project as a single scannable line. */
export function renderProjectLine(record, { active } = {}) {
  const marker = active === record.name ? '▸ ' : '• ';
  const parts = [`${marker}${projectStatusIcon(record.status)} ${record.name}`];
  const detail = [];
  detail.push(projectStatusLabel(record.status));
  if (record.tasks?.total) detail.push(`${record.tasks.done}/${record.tasks.total} tasks`);
  if (record.git?.branch) detail.push(record.git.branch);
  if (record.health?.level) detail.push(healthLabel(record.health.level).toLowerCase());
  parts.push(`   ${detail.join(' · ')}`);
  return parts.join('\n');
}

/**
 * `/projects` — the directive's Priority 1.
 *
 * @param {object[]} records - From ProjectRegistry.list().
 * @param {{active?: string|null}} [options]
 */
export function renderProjectList(records, { active } = {}) {
  if (!records.length) {
    return [
      'No projects are defined yet.',
      '',
      'Add one from the machine with: ai-orchestrator projects add --interactive',
    ].join('\n');
  }
  const lines = [`Projects (${records.length})`, ''];
  for (const record of records.slice(0, MAX_LIST)) {
    lines.push(renderProjectLine(record, { active }));
  }
  if (records.length > MAX_LIST) lines.push(`… and ${records.length - MAX_LIST} more.`);
  lines.push('');
  lines.push(active ? `Active: ${active}` : 'No project selected — /project <name>');
  return lines.join('\n');
}

/** `/status` — everything known about one project. */
export function renderProjectDetail(record, { now = Date.now() } = {}) {
  if (record.status === 'misconfigured') {
    return [
      `⚠️ ${record.name} — configuration problem`,
      '',
      record.problem ?? 'Its project file could not be loaded.',
    ].join('\n');
  }

  const lines = [
    `${projectStatusIcon(record.status)} ${record.name} — ${projectStatusLabel(record.status)}`,
  ];
  if (record.description) lines.push(record.description);
  lines.push('');

  if (record.lifecycle) {
    lines.push(`Phase: ${phaseIcon(record.lifecycle)} ${phaseLabel(record.lifecycle)}`);
  }
  if (record.tasks?.total) {
    const current = record.tasks.current
      ? ` (current: ${record.tasks.current}${record.tasks.currentState ? `, ${record.tasks.currentState}` : ''})`
      : '';
    lines.push(`Tasks: ${record.tasks.done}/${record.tasks.total} done${current}`);
  }
  if (record.worker) {
    lines.push(`Worker: pid ${record.worker.pid}, up ${relativeTime(record.worker.startedAt, now).replace(' ago', '')}`);
  }
  if (record.pendingApprovals?.length) {
    lines.push('');
    lines.push(`Waiting on you (${record.pendingApprovals.length}):`);
    for (const request of record.pendingApprovals.slice(0, 5)) {
      lines.push(`  ${request.id} — ${request.title}`);
    }
    lines.push(`Reply: APPROVE ${record.pendingApprovals[0].id}`);
  }

  lines.push('');
  if (record.git) {
    const dirty = record.git.dirty ? ' (uncommitted changes)' : '';
    lines.push(`Branch: ${record.git.branch ?? 'detached'}${dirty}`);
    lines.push(`Commit: ${record.git.commit}${record.git.subject ? ` — ${record.git.subject}` : ''}`);
  } else if (record.path) {
    lines.push('Branch: not a git repository');
  }
  if (record.path) lines.push(`Path: ${record.path}`);
  lines.push(`Last activity: ${relativeTime(record.lastActivity, now)}`);
  if (record.health?.level) {
    const score = Number.isFinite(record.health.score) ? ` (${record.health.score}/100)` : '';
    lines.push(`Health: ${healthLabel(record.health.level)}${score}`);
  }
  if (record.health?.reasons?.length) {
    for (const reason of record.health.reasons.slice(0, 3)) lines.push(`  · ${reason}`);
  }
  return lines.join('\n');
}

/** `/tasks` — the queue and where it is. */
export function renderTasks(project, queue) {
  if (!queue || !queue.tasks?.length) {
    return `${project}: no task queue yet. It will be created on the first mission.`;
  }
  const lines = [`${project} — tasks (${queue.currentIndex}/${queue.tasks.length})`, ''];
  for (const [index, task] of queue.tasks.slice(0, MAX_LIST).entries()) {
    const marker = index === queue.currentIndex ? '▸' : ' ';
    const attempts = task.attempts ? ` ·  ${task.attempts} attempt${task.attempts === 1 ? '' : 's'}` : '';
    lines.push(`${marker} ${task.id} [${task.state}]${attempts}`);
    if (task.objective) lines.push(`    ${task.objective}`);
  }
  if (queue.tasks.length > MAX_LIST) lines.push(`… and ${queue.tasks.length - MAX_LIST} more.`);
  return lines.join('\n');
}

/** `/approvals` — every decision waiting, across every project. */
export function renderApprovals(requests) {
  if (!requests.length) return 'Nothing is waiting for your decision.';
  const lines = [`Waiting for you (${requests.length})`, ''];
  for (const request of requests.slice(0, MAX_LIST)) {
    lines.push(`${request.id} · ${request.project}`);
    lines.push(`   ${request.title}`);
    lines.push(request.approvalClass === 'human-action'
      ? `   Reply: DONE ${request.id}`
      : `   Reply: APPROVE ${request.id} · REJECT ${request.id}`);
  }
  if (requests.length > MAX_LIST) lines.push(`… and ${requests.length - MAX_LIST} more.`);
  return lines.join('\n');
}

/**
 * The mission proposal — gate 1 of the two-gate flow (see missionRequests.js).
 *
 * Deliberately contains no estimate of files, tasks, tests or duration for
 * THIS objective, because nothing has looked at the code yet and a number
 * invented here would be a fabrication. What it does carry is real: the
 * project's actual state, and its own measured history, labelled as history.
 */
export function renderMissionProposal(request) {
  const context = request.context ?? {};
  const lines = [
    `📋 Mission ${request.id} — ${request.project}`,
    '',
    request.objective,
    '',
    'Before anything runs:',
  ];
  if (context.branch) {
    lines.push(`  Branch: ${context.branch}${context.dirty ? ' (uncommitted changes)' : ''}`);
  }
  if (context.path) lines.push(`  Path: ${context.path}`);
  if (context.queuedTasks) lines.push(`  Already queued: ${context.queuedTasks} task(s)`);

  if (context.history) {
    lines.push('');
    lines.push('This project\'s recent history (not a prediction):');
    const h = context.history;
    if (h.missions) lines.push(`  Missions measured: ${h.missions}`);
    if (h.averageRunMs) lines.push(`  Average run: ${formatDuration(h.averageRunMs)}`);
    if (h.verifierPassRate != null) lines.push(`  Verifier pass rate: ${h.verifierPassRate}%`);
  }

  lines.push('');
  lines.push('If you approve, a planning run starts. It will come back with a');
  lines.push('real plan — tasks, files, duration, risks — for a second approval');
  lines.push('before any code is written.');
  lines.push('');
  lines.push(`Reply: APPROVE ${request.id} · REJECT ${request.id} [why]`);
  return lines.join('\n');
}

/** `/missions` — open mission requests. */
export function renderMissionRequests(requests) {
  if (!requests.length) return 'No mission requests are waiting.';
  const lines = [`Mission requests (${requests.length})`, ''];
  for (const request of requests.slice(0, MAX_LIST)) {
    lines.push(`${request.id} · ${request.project} · ${decisionLabel(request.status)}`);
    lines.push(`   ${truncate(request.objective, 120)}`);
  }
  return lines.join('\n');
}

/** `/events` — what the system actually did, newest last. */
export function renderEvents(events) {
  if (!events.length) return 'No events recorded yet.';
  const lines = [`Recent activity (${events.length})`, ''];
  for (const event of events) {
    const when = new Date(event.at).toLocaleTimeString();
    const project = event.project ? ` ${event.project}` : '';
    lines.push(`${when} · ${event.type}${project}`);
  }
  return lines.join('\n');
}

/** A destructive action, restated, with the code that performs it. */
export function renderConfirmation(confirmation) {
  return [
    '⚠️ Confirm this action',
    '',
    confirmation.summary,
    '',
    `Reply: /confirm ${confirmation.code}`,
    'Or ignore this message — it expires on its own.',
  ].join('\n');
}

/**
 * A real phase change on a running mission (Priority 4).
 *
 * `tasksDone`/`tasksTotal` come from the persisted task queue, so the progress
 * shown is work that actually finished. There is deliberately no percentage
 * derived from elapsed time: this project does not report progress it has not
 * measured.
 */
export function renderPhaseUpdate({ project, state, tasksDone, tasksTotal, taskId, detail }) {
  const lines = [`${phaseIcon(state)} ${project} — ${phaseLabel(state)}`];
  if (tasksTotal) {
    lines.push(`Tasks: ${tasksDone}/${tasksTotal} done${taskId ? ` · now: ${taskId}` : ''}`);
  } else if (taskId) {
    lines.push(`Task: ${taskId}`);
  }
  if (detail) lines.push(detail);
  return lines.join('\n');
}

/** `/help` — generated from the grammar, so it can never drift from it. */
export function renderHelp({ active } = {}) {
  const lines = ['AI-Orchestrator — remote console', ''];
  for (const command of COMMANDS) {
    const mark = command.destructive ? ' ⚠️' : '';
    lines.push(`${command.usage}${mark}`);
    lines.push(`   ${command.description}`);
  }
  lines.push('');
  lines.push('Decisions: APPROVE A7 · REJECT A7 [why] · MODIFY A7 <changes> · DONE A7');
  lines.push('');
  lines.push('Anything else you type becomes a mission request for the active');
  lines.push('project — a proposal you must approve. Typing never starts work.');
  lines.push('');
  lines.push(active ? `Active project: ${active}` : 'No project selected — /project <name>');
  lines.push('⚠️ marks actions that ask for confirmation first.');
  return lines.join('\n');
}

/** Shared truncation so every list clips the same way. */
export function truncate(text, maxChars) {
  const value = String(text ?? '');
  return value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value;
}

export default {
  relativeTime, renderProjectLine, renderProjectList, renderProjectDetail,
  renderTasks, renderApprovals, renderMissionProposal, renderMissionRequests,
  renderEvents, renderConfirmation, renderPhaseUpdate, renderHelp, truncate,
};
