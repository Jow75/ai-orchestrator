/**
 * commandGrammar.js — Phase 12 M2: what the owner is allowed to say.
 *
 * Pure parsing. No I/O, no daemon, no side effects — which is the point: the
 * inbound grammar is the widest new attack surface this phase adds, and a
 * parser that cannot touch anything can be exhaustively tested for what it
 * ACCEPTS and, more importantly, for what it REFUSES.
 *
 * Three rules shape the design:
 *
 *  1. THE DECISION GRAMMAR IS NOT REIMPLEMENTED. `APPROVE A7` and friends are
 *     parsed by the same `parseDecisionText` every provider has used since
 *     Phase 10C. One parser, no drift — if the two ever disagreed, an owner's
 *     approval would be read differently depending on which loop saw it.
 *
 *  2. AN UNKNOWN SLASH COMMAND IS NEVER FREE TEXT. `/delete-everything` must
 *     come back as an unknown command, not silently become a mission
 *     objective. Anything the owner clearly meant as an instruction and that
 *     this system does not implement has to be refused loudly.
 *
 *  3. FREE TEXT IS THE LAST RESORT, NOT THE DEFAULT PATH. It is recognized
 *     only after every command form has failed to match, and even then it
 *     carries no authority whatsoever — see missionRequests.js.
 */

import { parseDecisionText } from '../approvals/providers/approvalProvider.js';

/**
 * Every command the operator interface implements.
 *
 * `destructive: true` means the command must pass through an explicit
 * confirmation before it does anything (Priority 7). That flag lives here, in
 * the grammar, rather than in the router, so "is this dangerous?" is answered
 * in the one place that enumerates the whole surface — a new command cannot be
 * added without confronting the question.
 *
 * `category` (Phase 13 M8) groups commands for `renderHelp()` and
 * `docs/OPERATOR_CONSOLE.md` — additive metadata only, never consulted by the
 * parser above or by `commandMenu.js`, so a typo here can misfile a command in
 * `/help` but can never change what it does. `examples` (also M8) is a short
 * list of realistic invocations for commands whose `usage` hint alone doesn't
 * show a concrete value; omitted for zero-argument commands, where there is
 * nothing to exemplify.
 */
export const COMMANDS = Object.freeze([
  {
    name: 'help',
    aliases: ['h', '?', 'commands'],
    usage: '/help',
    category: 'General',
    description: 'Show every command.',
  },
  {
    name: 'projects',
    aliases: ['ls', 'list'],
    usage: '/projects [all|classify]',
    takesRest: true,
    category: 'Projects',
    examples: ['/projects all', '/projects classify'],
    description: '"all" (with hidden), "classify" (propose classifications for unclassified projects).',
  },
  {
    name: 'project',
    aliases: ['use', 'select', 'cd'],
    usage: '/project <name>',
    takesRest: true,
    category: 'Projects',
    examples: ['/project Remote Work'],
    description: 'Select the active project. Later commands apply to it.',
  },
  {
    name: 'status',
    aliases: ['st'],
    usage: '/status [project]',
    takesRest: true,
    category: 'Projects',
    examples: ['/status Remote Work'],
    description: 'Full status of the active (or named) project.',
  },
  {
    name: 'workspace',
    aliases: ['overview'],
    usage: '/workspace',
    category: 'Projects',
    description: 'Portfolio rollup: mission-readiness, status counts, git clean/dirty, recently active, needs attention.',
  },
  {
    name: 'git',
    aliases: [],
    usage: '/git [project|dirty|clean]',
    takesRest: true,
    category: 'Projects',
    examples: ['/git Remote Work', '/git dirty', '/git clean'],
    description: 'Branch, dirty/clean state, HEAD, and recent commits for the active (or named) project. "dirty"/"clean" list every registered project in that state.',
  },
  {
    name: 'start',
    aliases: ['run'],
    usage: '/start [project]',
    takesRest: true,
    category: 'Missions',
    examples: ['/start Remote Work'],
    description: 'Start supervising the active (or named) project.',
  },
  {
    name: 'stop',
    aliases: [],
    usage: '/stop [project]',
    takesRest: true,
    destructive: true,
    category: 'Missions',
    examples: ['/stop Remote Work'],
    description: 'Stop a running mission (the session stays resumable).',
  },
  {
    name: 'tasks',
    aliases: ['queue'],
    usage: '/tasks [project]',
    takesRest: true,
    category: 'Missions',
    examples: ['/tasks Remote Work'],
    description: "The active project's task queue and where it is.",
  },
  {
    name: 'approvals',
    aliases: ['pending'],
    usage: '/approvals [mode [conservative|balanced|autonomous]]',
    takesRest: true,
    category: 'Decisions',
    examples: ['/approvals mode', '/approvals mode autonomous'],
    description: 'Every decision waiting on you, across all projects. "mode" shows or sets the global approval mode.',
  },
  {
    name: 'missions',
    aliases: ['requests'],
    usage: '/missions',
    category: 'Decisions',
    description: 'Mission requests you have raised and not yet answered.',
  },
  {
    name: 'service',
    aliases: ['daemon', 'uptime'],
    usage: '/service',
    category: 'System',
    description: 'Is the service running, and will it survive a reboot?',
  },
  {
    name: 'events',
    aliases: ['activity'],
    usage: '/events [count]',
    takesRest: true,
    category: 'System',
    examples: ['/events 20'],
    description: 'The most recent things the system actually did.',
  },
  {
    name: 'log',
    aliases: ['logs'],
    usage: '/log [project] [n]',
    takesRest: true,
    category: 'System',
    examples: ['/log Remote Work', '/log Remote Work 40'],
    description: 'Tail the real orchestrator log file for the active (or named) project — raw text, not the structured event log /events shows.',
  },
  {
    name: 'reset',
    aliases: ['abandon'],
    usage: '/reset [project]',
    takesRest: true,
    destructive: true,
    category: 'Missions',
    examples: ['/reset Remote Work'],
    description: 'Abandon an interrupted session so the next start begins fresh.',
  },
  {
    name: 'shutdown',
    aliases: [],
    usage: '/shutdown',
    destructive: true,
    category: 'System',
    description: 'Stop the Core Service itself. Nothing remote works after this.',
  },
  {
    name: 'confirm',
    aliases: ['yes'],
    usage: '/confirm <code>',
    takesRest: true,
    category: 'Decisions',
    examples: ['/confirm K7XM'],
    description: 'Confirm a destructive action you were just asked about.',
  },
  {
    name: 'cancel',
    aliases: ['no'],
    usage: '/cancel [code]',
    takesRest: true,
    category: 'Decisions',
    examples: ['/cancel K7XM'],
    description: 'Cancel a pending confirmation or a mission request.',
  },
  {
    name: 'whoami',
    aliases: ['context'],
    usage: '/whoami',
    category: 'General',
    description: 'Which project this conversation is currently pointed at.',
  },
  {
    name: 'scan',
    aliases: ['rescan', 'discover'],
    usage: '/scan',
    category: 'Registry',
    description: 'Find real, unregistered projects under your configured roots.',
  },
  {
    name: 'import',
    aliases: [],
    usage: '/import <path> [as <name>] | /import all',
    takesRest: true,
    category: 'Registry',
    examples: ['/import C:\\Users\\Admin\\Music\\new-project', '/import C:\\Users\\Admin\\Music\\new-project as "New Project"', '/import all'],
    description: 'Register a folder /scan found as a project. "all" registers every current /scan candidate in one confirmed batch. Registry only — never touches files.',
  },
  {
    name: 'mission',
    aliases: [],
    usage: '/mission [project] | /mission all',
    takesRest: true,
    category: 'Registry',
    examples: ['/mission Remote Work', '/mission all'],
    description: 'Auto-detect a project\'s stack from files on disk and write it a starter promptFile. "all" does every project missing one, in one confirmed batch. Never overwrites an existing mission.',
  },
  {
    name: 'archive',
    aliases: [],
    usage: '/archive [project]',
    takesRest: true,
    category: 'Registry',
    examples: ['/archive Remote Work'],
    description: 'Mark a project archived — demoted in priority, never deleted.',
  },
  {
    name: 'restore',
    aliases: [],
    usage: '/restore [project]',
    takesRest: true,
    category: 'Registry',
    examples: ['/restore Remote Work'],
    description: 'Return an archived or hidden project to "development".',
  },
  {
    name: 'hide',
    aliases: [],
    usage: '/hide [project]',
    takesRest: true,
    category: 'Registry',
    examples: ['/hide Remote Work'],
    description: 'Hide a project from /projects (still shown by /projects all).',
  },
  {
    name: 'unhide',
    aliases: [],
    usage: '/unhide [project]',
    takesRest: true,
    category: 'Registry',
    examples: ['/unhide Remote Work'],
    description: 'Return a hidden project to "development".',
  },
  {
    name: 'forget',
    aliases: [],
    usage: '/forget [project]',
    takesRest: true,
    destructive: true,
    category: 'Registry',
    examples: ['/forget Remote Work'],
    description: 'Remove a project from the registry. Files on disk are NEVER touched.',
  },
  {
    name: 'roots',
    aliases: [],
    usage: '/roots [add|remove <path>]',
    takesRest: true,
    category: 'Registry',
    examples: ['/roots add D:\\Development', '/roots remove D:\\Development'],
    description: 'List, add, or remove a project root (where /scan looks for projects).',
  },
  {
    name: 'provider',
    aliases: [],
    usage: '/provider',
    category: 'Configuration',
    description: 'Current default provider/model, known drivers, and capabilities.',
  },
  {
    name: 'model',
    aliases: [],
    usage: '/model [name|default]',
    takesRest: true,
    category: 'Configuration',
    examples: ['/model claude-sonnet-5', '/model default'],
    description: 'Show or set the default model. Never interrupts an active mission.',
  },
  {
    name: 'safemode',
    aliases: [],
    usage: '/safemode [on|off]',
    takesRest: true,
    category: 'Configuration',
    examples: ['/safemode on', '/safemode off'],
    description: 'Global read-only override: while on, every project runs headless-read-only regardless of its own permissionMode.',
  },
  {
    name: 'notify',
    aliases: [],
    usage: '/notify [status|telegram on|off|email on|off|discord on|off|webhook on|off|severity <info|warning|critical>]',
    takesRest: true,
    category: 'Configuration',
    examples: ['/notify', '/notify telegram off', '/notify severity warning'],
    description: 'Show or change which notification channels are enabled and the minimum severity that reaches them.',
  },
  {
    name: 'files',
    aliases: ['ls-files', 'dir'],
    usage: '/files [path]',
    takesRest: true,
    category: 'Files',
    examples: ['/files src'],
    description: 'List a directory inside the active project (default: its root).',
  },
  {
    name: 'file',
    aliases: ['cat', 'read'],
    usage: '/file <path>',
    takesRest: true,
    category: 'Files',
    examples: ['/file src/index.js'],
    description: 'Read one file from the active project — inline if small, as an attachment if not.',
  },
  {
    name: 'grep',
    aliases: ['search', 'find'],
    usage: '/grep <pattern>',
    takesRest: true,
    category: 'Search',
    examples: ['/grep TODO', '/grep console\\.log'],
    description: 'Search the active project\'s real files for text (a regex if it parses as one, otherwise a literal match). Case-insensitive.',
  },
  {
    name: 'symbol',
    aliases: [],
    usage: '/symbol <name>',
    takesRest: true,
    category: 'Search',
    examples: ['/symbol DriverRegistry'],
    description: '/grep with a language-aware-ish pattern layered on top — finds where a function/class/const/etc. is likely DEFINED, not a real symbol index.',
  },
  {
    // Telegram's setMyCommands rejects any name outside [a-z0-9_]{1,32} — a
    // hyphen is not legal there, unlike every other place a command name
    // appears in this codebase. The owner's own directive wrote
    // "/download-project"; that exact spelling still works (as an alias),
    // it just is not the one Telegram's tappable menu can register.
    name: 'download_project',
    aliases: ['download-project', 'download', 'zip'],
    usage: '/download-project [project]',
    takesRest: true,
    category: 'Files',
    examples: ['/download-project Remote Work'],
    description: 'ZIP the active (or named) project — source only, never node_modules/.git/build output.',
  },
]);

/** name/alias → command definition. */
const BY_NAME = new Map();
for (const command of COMMANDS) {
  BY_NAME.set(command.name, command);
  for (const alias of command.aliases ?? []) BY_NAME.set(alias, command);
}

/** Look up a command by name or alias (case-insensitive). Null when unknown. */
export function findCommand(name) {
  return BY_NAME.get(String(name ?? '').toLowerCase()) ?? null;
}

/** Every destructive command name (for docs and tests). */
export function destructiveCommands() {
  return COMMANDS.filter((c) => c.destructive).map((c) => c.name);
}

/**
 * How many words may follow an UN-SLASHED command word before the message is
 * read as prose instead. "status" and "status calculator" are commands;
 * "status update: the payroll page is done, please continue" is not.
 * Deliberately small — the slash form always works and is never ambiguous.
 */
export const MAX_IMPLICIT_ARG_WORDS = 3;

/**
 * A word that looks like a request id: `A7` (approval) or `M3` (mission
 * request). Used to route a decision to the right store without guessing.
 */
const REQUEST_ID = /^[AM]\d+$/i;

/** Which store an id belongs to. Null when it is neither shape. */
export function idKind(id) {
  if (!REQUEST_ID.test(String(id ?? ''))) return null;
  return String(id)[0].toUpperCase() === 'A' ? 'approval' : 'mission-request';
}

/**
 * Parse one inbound message.
 *
 * @param {string} text - The raw message.
 * @returns {object} One of:
 *   {kind:'empty'}
 *   {kind:'decision', requestId, decision, note?, idKind}
 *   {kind:'command', name, command, rest, args}
 *   {kind:'unknown-command', name}
 *   {kind:'free-text', text}
 */
export function parseCommand(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { kind: 'empty' };

  // Decisions first, and via the shared parser: `APPROVE A7`, `/done M3 …`.
  // Checked before commands because "approve"/"reject"/"done" are decision
  // verbs in this system and must never be shadowed by a command of the same
  // name — an owner approving something is the highest-value message there is.
  const decision = parseDecisionText(raw);
  if (decision) {
    const kind = idKind(decision.requestId);
    if (kind) return { kind: 'decision', ...decision, idKind: kind };
    // A decision verb with an id shape this system does not issue. Refusing is
    // safer than searching: `APPROVE everything` must not resolve anything.
    return { kind: 'unknown-command', name: decision.requestId, decisionVerb: true };
  }

  const slash = raw.startsWith('/');
  const body = slash ? raw.slice(1).trim() : raw;
  if (!body) return { kind: 'empty' };

  const [word, ...restWords] = body.split(/\s+/);
  const command = findCommand(word);
  const rest = body.slice(word.length).trim();

  if (command) {
    const asCommand = { kind: 'command', name: command.name, command, rest, args: restWords };
    // A slash is an unambiguous declaration of intent — always a command.
    if (slash) return asCommand;
    // Without one, a known command word used as prose is a real risk on a
    // free-text channel ("projects are a mess", "start by reading the
    // README"). A bare word is a command; a word plus a short argument is a
    // command only if the command actually takes one; anything longer is prose.
    if (restWords.length === 0) return asCommand;
    if (command.takesRest && restWords.length <= MAX_IMPLICIT_ARG_WORDS) return asCommand;
    return { kind: 'free-text', text: raw };
  }

  // Explicitly slash-prefixed but unrecognized: an instruction this system
  // does not implement. Never demote it to free text.
  if (slash) return { kind: 'unknown-command', name: word };

  return { kind: 'free-text', text: raw };
}

export default { COMMANDS, parseCommand, findCommand, idKind, destructiveCommands };
