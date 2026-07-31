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
import { PROJECT_STATUSES } from './projectRegistry.js';
import { SIMULATION_BADGE, SIMULATION_NOTICE } from '../drivers/simulation.js';

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
  // The badge rides on the NAME rather than in the detail line, because the
  // detail line is what gets skimmed past. A simulated project must be
  // identifiable in the one line an owner actually reads — same reasoning
  // now applies to an archived one (Phase 13 M3): a demoted-priority
  // project that stays listed is easy to mistake for a live one otherwise.
  const badges = [];
  if (record.simulated) badges.push(SIMULATION_BADGE);
  if (record.classification === 'archived') badges.push('📦 ARCHIVED');
  const badge = badges.length ? `  ${badges.join(' ')}` : '';
  const parts = [`${marker}${projectStatusIcon(record.status)} ${record.name}${badge}`];
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

/**
 * Why a project belongs in `/workspace`'s "needs attention" list, or `null`
 * if it doesn't. Checked in priority order.
 *
 * "No mission yet" is checked BEFORE the generic 'misconfigured' status,
 * not after: a project with neither a `promptFile` nor a task plan fails
 * `ConfigManager.validateProject()` (both are required for a legal config)
 * and so ALWAYS shows status 'misconfigured' too — the exact 19-of-23-
 * projects gap `/mission` (Phase 14 M9) exists to close. Reporting that as
 * "misconfigured" would be accurate but actively unhelpful: the fix is one
 * command (`/mission <name>`), not hand-editing JSON. A project that fails
 * validation for a genuinely different reason (bad driver id, say) while
 * still having a `promptFile` set is unaffected by this reordering — it is
 * already in `missionReady`, so it falls through to 'misconfigured' below.
 */
function attentionReason(record, missionReady) {
  if (record.status === 'missing') return 'folder missing';
  if (missionReady && !missionReady.has(record.name)) return 'no mission yet';
  if (record.status === 'misconfigured') return 'misconfigured';
  if (record.status === 'blocked') return 'blocked';
  return null;
}

/**
 * `/workspace` — Phase 14 M0: a portfolio-wide rollup over every registered
 * project, answering "how is the whole workspace doing" without opening one
 * project at a time. No new data source: every field is already computed
 * per-project by `ProjectRegistry.list()` (status, git, lastActivity),
 * summed rather than shown one row at a time — except mission-readiness,
 * which isn't on the record at all (it comes from a raw config read only
 * the caller has reason to make), so it arrives precomputed as a `Set`.
 * Deliberately no cross-project reasoning here — see
 * `docs/PHASE_14_PLAN.md` §0a for why that's out of scope for this phase.
 *
 * @param {object[]} records - From `ProjectRegistry.list()`.
 * @param {{missionReady?: Set<string>, recentCount?: number}} [options]
 */
export function renderWorkspace(records, { missionReady, recentCount = 5 } = {}) {
  if (!records.length) {
    return [
      'No projects are defined yet.',
      '',
      'Add one from the machine with: ai-orchestrator projects add --interactive',
    ].join('\n');
  }

  const readyCount = missionReady ? records.filter((r) => missionReady.has(r.name)).length : 0;
  const lines = [
    `🗂️ Workspace — ${records.length} project${records.length === 1 ? '' : 's'}`,
    '',
    `Mission-ready: ${readyCount}/${records.length}`,
  ];

  const statusCounts = new Map();
  for (const record of records) statusCounts.set(record.status, (statusCounts.get(record.status) ?? 0) + 1);
  lines.push('', 'Status:');
  for (const status of PROJECT_STATUSES) {
    const count = statusCounts.get(status);
    if (count) lines.push(`${projectStatusIcon(status)} ${projectStatusLabel(status)}: ${count}`);
  }

  const withGit = records.filter((r) => r.git);
  if (withGit.length) {
    const dirty = withGit.filter((r) => r.git.dirty).length;
    const noRepo = records.length - withGit.length;
    const parts = [`${withGit.length - dirty} clean`, `${dirty} dirty`];
    if (noRepo) parts.push(`${noRepo} not a repo`);
    lines.push('', `Git: ${parts.join(' · ')}`);
  }

  const recent = records
    .filter((r) => r.lastActivity)
    .sort((a, b) => Date.parse(b.lastActivity) - Date.parse(a.lastActivity))
    .slice(0, recentCount);
  if (recent.length) {
    lines.push('', 'Recently active:');
    for (const r of recent) lines.push(`• ${r.name} — ${relativeTime(r.lastActivity)}`);
  }

  const needsAttention = records
    .map((r) => ({ record: r, reason: attentionReason(r, missionReady) }))
    .filter((entry) => entry.reason);
  lines.push('');
  if (needsAttention.length) {
    lines.push(`Needs attention (${needsAttention.length}):`);
    for (const { record, reason } of needsAttention.slice(0, MAX_LIST)) {
      lines.push(`${projectStatusIcon(record.status)} ${record.name} — ${reason}`);
    }
    if (needsAttention.length > MAX_LIST) lines.push(`… and ${needsAttention.length - MAX_LIST} more.`);
  } else {
    lines.push('Nothing needs attention right now.');
  }

  return lines.join('\n');
}

/**
 * `/git [project]` — Phase 14 M1. Repository state, HEAD, recent commits,
 * and (when tracked) ahead/behind — read-only, no diff, no file contents.
 *
 * @param {string} name
 * @param {import('./gitVisibility.js').gitReport|null} report - Null when
 *   `name`'s working directory is not a real git repository.
 */
export function renderGitStatus(name, report) {
  if (!report) {
    return [`${name}`, '', 'Not a git repository.'].join('\n');
  }

  const lines = [`${name}`, ''];
  lines.push(`Branch: ${report.branch ?? 'detached HEAD'}`);

  if (report.status) {
    lines.push(report.status.dirty
      ? `Status: 🔴 Dirty (${report.status.changedCount} changed)`
      : 'Status: 🟢 Clean');
  }

  if (report.head) {
    lines.push(`HEAD: ${report.head.hash}${report.head.subject ? ` — ${report.head.subject}` : ''}`);
  } else {
    lines.push('HEAD: no commits yet');
  }

  if (report.aheadBehind) {
    lines.push(`Upstream: ${report.aheadBehind.ahead} ahead, ${report.aheadBehind.behind} behind`);
  } else {
    lines.push('Upstream: not tracked');
  }

  if (report.recentCommits.length) {
    lines.push('', `Recent commits (${report.recentCommits.length}):`);
    for (const commit of report.recentCommits) lines.push(`${commit.hash} ${commit.subject}`);
  }

  return lines.join('\n');
}

/**
 * `/git dirty` / `/git clean` — every registered project in that git state,
 * across the whole registry (not just the active project). `records` is
 * already filtered to the requested `kind` by the caller.
 *
 * @param {'dirty'|'clean'} kind
 * @param {object[]} records - From `ProjectRegistry.list()`, pre-filtered.
 */
export function renderGitFilter(kind, records) {
  const icon = kind === 'dirty' ? '🔴' : '🟢';
  const label = kind === 'dirty' ? 'Dirty' : 'Clean';
  if (!records.length) {
    return `${icon} ${label} projects (0)\n\nNone.`;
  }
  const lines = [`${icon} ${label} projects (${records.length})`, ''];
  for (const record of records) lines.push(`• ${record.name}`);
  return lines.join('\n');
}

/** `/scan` — real, unregistered projects found under the configured roots. */
export function renderScanResults({ candidates, rootsScanned, rootsMissing }, { roots } = {}) {
  if (!roots?.length) {
    return [
      'No project roots are configured yet.',
      '',
      'Set "operator.projectRoots" in config/orchestrator.json or config/local.json, then /scan again.',
    ].join('\n');
  }

  const lines = ['🔍 Scan results', ''];
  lines.push(`Roots: ${rootsScanned.length ? rootsScanned.join(', ') : '(none exist on disk)'}`);
  if (rootsMissing.length) lines.push(`⚠️ Not found on disk: ${rootsMissing.join(', ')}`);
  lines.push('');

  if (!candidates.length) {
    lines.push('No new projects found — everything under your roots is already registered.');
    return lines.join('\n');
  }

  lines.push(`Found ${candidates.length} new project(s):`);
  for (const candidate of candidates.slice(0, MAX_LIST)) {
    lines.push(`• ${candidate.name} — ${candidate.path}`);
  }
  if (candidates.length > MAX_LIST) lines.push(`… and ${candidates.length - MAX_LIST} more.`);
  lines.push('');
  lines.push('Register one: /import <path>');
  return lines.join('\n');
}

/** `/mission` — what was auto-detected and assigned to one project. */
export function renderMissionAssignment(name, result) {
  const { stack, promptFileName, needsPermission } = result;
  const lines = [`✅ ${name} — mission assigned`, ''];
  lines.push(`Detected: ${stack.language}${stack.framework ? ` / ${stack.framework}` : ''} (confidence: ${stack.confidence})`);
  if (stack.packageManager) lines.push(`Package manager: ${stack.packageManager}`);
  if (stack.buildCommand) lines.push(`Build: ${stack.buildCommand}`);
  if (stack.testCommand) lines.push(`Test: ${stack.testCommand}`);
  if (stack.tags.length) lines.push(`Tags: ${stack.tags.join(', ')}`);
  lines.push('');
  lines.push(`Wrote ${promptFileName} — edit it by hand before starting if the auto-detected mission isn't what you want.`);
  if (needsPermission) {
    lines.push('');
    lines.push(
      '⚠️ No claude.permissionMode is set for this project — a real mission will run read-only and '
      + 'block. Set it in config/projects/<name>.json before /start.'
    );
  }
  return lines.join('\n');
}

/** `/mission all` — one row per project a batch assigned, skipped, or failed. */
export function renderMissionBatch({ assigned, skipped, failed }) {
  const lines = ['✅ Mission auto-assignment complete', ''];
  if (assigned.length) {
    lines.push(`Assigned (${assigned.length}):`);
    for (const a of assigned.slice(0, MAX_LIST)) {
      lines.push(`• ${a.name} — ${a.stack.language}${a.stack.framework ? `/${a.stack.framework}` : ''} (${a.stack.confidence})`);
    }
    if (assigned.length > MAX_LIST) lines.push(`… and ${assigned.length - MAX_LIST} more.`);
    lines.push('');
  }
  if (skipped.length) {
    lines.push(`Skipped — already had a mission by the time this ran: ${skipped.join(', ')}.`);
    lines.push('');
  }
  if (failed.length) {
    lines.push(`Failed (${failed.length}):`);
    for (const f of failed) lines.push(`• ${f.name} — ${f.error}`);
    lines.push('');
  }
  const needPermission = assigned.filter((a) => a.needsPermission).map((a) => a.name);
  if (needPermission.length) {
    lines.push(
      `${needPermission.length} project(s) still need claude.permissionMode set before a real mission `
      + `can write files: ${needPermission.join(', ')}.`
    );
  }
  return lines.join('\n').trim();
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
  if (record.status === 'missing') {
    return [
      `❌ ${record.name} — folder not found`,
      '',
      `Configured at ${record.path ?? 'an unknown path'}, but it no longer exists on disk`
      + ' (moved, renamed, or deleted outside AI-Orchestrator).',
      '',
      'Fix by hand-editing its "workingDirectory" in config/projects/, or re-import it once it exists again: /import <path>.',
    ].join('\n');
  }

  const lines = [
    `${projectStatusIcon(record.status)} ${record.name} — ${projectStatusLabel(record.status)}`,
  ];
  if (record.description) lines.push(record.description);
  if (record.simulated) {
    lines.push('');
    lines.push(`🧪 ${SIMULATION_NOTICE}`);
  }
  // Only shown when it's worth saying — every fresh project defaults to
  // 'development', and repeating that on every /status would be noise the
  // phone-first design this module follows explicitly argues against.
  if (record.classification && record.classification !== 'development') {
    lines.push('');
    lines.push(`📁 Classification: ${record.classification}`);
  }
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

/**
 * `/approvals` — every decision waiting, across every project.
 *
 * The badge matters more in this list than in most: `/approvals` is the screen
 * an owner acts from without opening anything first, so it is the one place a
 * decision can be spent on a fixture with no other surface in between. The
 * per-request gate messages disclose too (see implementationSummary.js) — this
 * is for the owner who replies straight from the list.
 *
 * @param {object[]} requests
 * @param {{simulated?: Set<string>}} [options] - Simulated project names, from
 *   ProjectRegistry.simulatedNames(). Absent ⇒ no badges, which keeps every
 *   existing caller working unchanged.
 */
export function renderApprovals(requests, { simulated } = {}) {
  if (!requests.length) return 'Nothing is waiting for your decision.';
  const lines = [`Waiting for you (${requests.length})`, ''];
  for (const request of requests.slice(0, MAX_LIST)) {
    const badge = simulated?.has(request.project) ? `  ${SIMULATION_BADGE}` : '';
    lines.push(`${request.id} · ${request.project}${badge}`);
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
  ];
  // Disclosed at gate 1, before the owner has spent a decision on it. Putting
  // this only in the completion report would tell them what happened; putting
  // it here tells them what is about to.
  if (context.simulated) {
    lines.push('', `🧪 ${SIMULATION_NOTICE}`);
  }
  lines.push(
    '',
    request.objective,
    '',
    'Before anything runs:'
  );
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
  if (context.simulated) {
    // The real flow's promise ("it will come back with a real plan") is a lie
    // here: the plan is a fixture too. Saying so is the whole point.
    lines.push('If you approve, the scripted fixture replays the two-gate flow');
    lines.push('so the approval path itself can be exercised. The plan it returns');
    lines.push('is canned and unrelated to what you asked for, and approving it');
    lines.push('produces no code.');
  } else {
    lines.push('If you approve, a planning run starts. It will come back with a');
    lines.push('real plan — tasks, files, duration, risks — for a second approval');
    lines.push('before any code is written.');
  }
  lines.push('');
  lines.push(`Reply: APPROVE ${request.id} · REJECT ${request.id} [why]`);
  return lines.join('\n');
}

/**
 * `/missions` — open mission requests.
 *
 * @param {object[]} requests
 * @param {{simulated?: Set<string>}} [options] - See {@link renderApprovals}.
 *   Preferred over each request's frozen `context.simulated` because a request
 *   raised before its project was pointed at a real engine would otherwise keep
 *   claiming to be a rehearsal after it stopped being one.
 */
export function renderMissionRequests(requests, { simulated } = {}) {
  if (!requests.length) return 'No mission requests are waiting.';
  const lines = [`Mission requests (${requests.length})`, ''];
  for (const request of requests.slice(0, MAX_LIST)) {
    const isSim = simulated ? simulated.has(request.project) : request.context?.simulated === true;
    const badge = isSim ? `  ${SIMULATION_BADGE}` : '';
    lines.push(`${request.id} · ${request.project}${badge} · ${decisionLabel(request.status)}`);
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

/**
 * `/service` — the health of the thing answering you.
 *
 * Leads with Running because that is what was asked, then spends its remaining
 * lines on the question the owner did not know to ask: whether this survives a
 * reboot. On 2026-07-28 the answer was no, and the way that surfaced was a
 * phone console that had simply stopped replying.
 */
export function renderServiceStatus(report) {
  const lines = ['🟢 Core Service — Running'];
  if (report.uptimeMs != null) lines.push(`Up for ${formatDuration(report.uptimeMs)}`);
  if (report.version) lines.push(`Version ${report.version}${report.pid ? ` · pid ${report.pid}` : ''}`);

  const max = report.maxWorkers ? `/${report.maxWorkers}` : '';
  lines.push(`Missions running: ${report.workers ?? 0}${max}`);
  lines.push(`Remote channel: ${report.telegramInbound ? 'active' : 'not configured'}`);

  const autostart = report.autostart ?? {};
  if (autostart.supported) {
    lines.push('');
    lines.push(autostart.installed
      ? 'After a reboot: starts automatically ✔'
      : 'After a reboot: ⚠️ it will NOT come back on its own.');
    if (!autostart.installed) {
      // The remedy has to run on the machine, so the message says so plainly
      // rather than offering a remote command that cannot exist.
      lines.push('This console goes silent until someone starts it by hand.');
      lines.push('Fix it once, at the machine: ai-orchestrator daemon install');
    }
  }
  return lines.join('\n');
}

/** One command's `/help` lines: its usage (with a ⚠️ mark if destructive) and description. */
function pushCommandLines(lines, command) {
  const mark = command.destructive ? ' ⚠️' : '';
  lines.push(`${command.usage}${mark}`);
  lines.push(`   ${command.description}`);
}

/**
 * `/help` — generated from the grammar, so it can never drift from it.
 *
 * Phase 13 M8: sectioned by each command's `category`, in the category's
 * first-seen order within `commands` — reading the one COMMANDS array rather
 * than a second, hand-kept list of section names that could drift from it.
 * If any command is missing a `category` (including every command, the
 * shape a revert of the M8 metadata commit would leave behind) this falls
 * back to the pre-M8 flat list rather than rendering a broken section.
 *
 * @param {{active?: string|null, commands?: object[]}} [options] - `commands`
 *   defaults to the real grammar; injectable so the fallback path can be
 *   tested without waiting for a real revert.
 */
export function renderHelp({ active, commands = COMMANDS } = {}) {
  const lines = ['AI-Orchestrator — remote console', ''];

  if (commands.some((command) => !command.category)) {
    for (const command of commands) pushCommandLines(lines, command);
  } else {
    const sections = new Map();
    for (const command of commands) {
      if (!sections.has(command.category)) sections.set(command.category, []);
      sections.get(command.category).push(command);
    }
    for (const [category, group] of sections) {
      lines.push(category);
      for (const command of group) pushCommandLines(lines, command);
      lines.push('');
    }
  }

  // Labelled "Decision grammar", not "Decisions", so it reads as distinct
  // from the "Decisions" category heading above (Phase 13 M8) — that section
  // groups /approvals, /missions, /confirm, /cancel; this line is the
  // separate APPROVE/REJECT/MODIFY/DONE reply syntax, unchanged since Phase 10.
  lines.push('Decision grammar: APPROVE A7 · REJECT A7 [why] · MODIFY A7 <changes> · DONE A7');
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

/** "1.4 KB" / "23.0 MB" — human sizes for file listings, /file, /download-project. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (const candidate of units) {
    unit = candidate;
    if (value < 1024) break;
    value /= 1024;
  }
  return `${value.toFixed(1)} ${unit}`;
}

/**
 * `/files` — one directory level, Explorer-style. Directories are listed
 * with a trailing `/` and no size (their size is not measured — a full
 * recursive walk for a number nobody asked for is exactly the unbounded
 * scan this command deliberately avoids).
 */
export function renderFileListing(project, listing) {
  const lines = [`📁 ${project}${listing.path === '.' ? '' : `/${listing.path}`}`, ''];
  if (!listing.entries.length) {
    lines.push(listing.total ? '(nothing on this page)' : '(empty)');
  }
  for (const entry of listing.entries) {
    lines.push(entry.type === 'dir'
      ? `📁 ${entry.name}/`
      : `📄 ${entry.name}  (${formatBytes(entry.size ?? 0)})`);
  }
  lines.push('');
  if (listing.pageCount > 1) {
    lines.push(`Page ${listing.page}/${listing.pageCount} · ${listing.total} entries total`);
  } else {
    lines.push(`${listing.total} entries`);
  }
  lines.push(listing.path === '.'
    ? 'Read one: /file <name>'
    : `Read one: /file ${listing.path}/<name>`);
  return lines.join('\n');
}

/** `/file` — a small text file, shown in full. See fileAccess.js for the size/binary cutoffs. */
export function renderFileInline(relativePath, content) {
  const body = content.endsWith('\n') ? content.slice(0, -1) : content;
  return [`📄 ${relativePath}`, '', body].join('\n');
}

/** Icon for one log line's winston level — `/log`'s severity marker. */
const LOG_LEVEL_ICON = Object.freeze({
  error: '🔴',
  warn: '🟡',
  info: '🔵',
  debug: '⚪',
});

/**
 * `/log [project]` — Phase 14 M2: a tail of the real orchestrator log file,
 * newest line first. `tail` is `logVisibility.js`'s `readLogTail()` result —
 * null when no log file exists on disk yet at all (a fresh install that has
 * never logged anything), distinct from a real file with zero lines tagged
 * for this particular project.
 */
export function renderLogTail(project, tail) {
  if (!tail) {
    return [`${project}`, '', 'No log file exists yet.'].join('\n');
  }

  const lines = [`${project} — ${tail.file}`, ''];
  if (!tail.lines.length) {
    lines.push(tail.total ? '(nothing on this page)' : 'Nothing logged for this project yet.');
  }
  for (const entry of tail.lines) {
    const when = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : '--:--:--';
    const icon = LOG_LEVEL_ICON[entry.level] ?? '⚪';
    lines.push(`${when} ${icon} ${entry.message}`);
  }
  lines.push('');
  lines.push(tail.pageCount > 1
    ? `Page ${tail.page}/${tail.pageCount} · ${tail.total} lines total`
    : `${tail.total} line${tail.total === 1 ? '' : 's'}`);
  return lines.join('\n');
}

/**
 * `/grep <pattern>` / `/symbol <name>` — Phase 14 M3. Both share this
 * renderer; the only difference is the label the caller passes in (`grep`
 * vs `symbol`) and the query text shown back, so a reply always confirms
 * what was actually searched for.
 */
export function renderSearchResults(project, label, query, results) {
  const lines = [`🔎 ${label} "${query}" — ${project}`, ''];
  if (!results.matches.length) {
    lines.push(results.total ? '(nothing on this page)' : 'No matches.');
  }
  for (const match of results.matches) {
    lines.push(`${match.file}:${match.line}`);
    lines.push(`  ${match.text}`);
  }
  lines.push('');
  lines.push(results.pageCount > 1
    ? `Page ${results.page}/${results.pageCount} · ${results.total} match${results.total === 1 ? '' : 'es'} total`
    : `${results.total} match${results.total === 1 ? '' : 'es'}`);
  if (results.truncated) {
    lines.push(`Stopped early after scanning ${results.filesScanned} files — narrow your pattern to see more.`);
  }
  return lines.join('\n');
}

export default {
  relativeTime, renderProjectLine, renderProjectList, renderProjectDetail,
  renderTasks, renderApprovals, renderMissionProposal, renderMissionRequests,
  renderEvents, renderConfirmation, renderPhaseUpdate, renderServiceStatus,
  renderHelp, truncate, formatBytes, renderFileListing, renderFileInline,
  renderSearchResults,
};
