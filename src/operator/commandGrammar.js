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
 */
export const COMMANDS = Object.freeze([
  {
    name: 'help',
    aliases: ['h', '?', 'commands'],
    usage: '/help',
    description: 'Show every command.',
  },
  {
    name: 'projects',
    aliases: ['ls', 'list'],
    usage: '/projects',
    description: 'Every project, with status, branch and health.',
  },
  {
    name: 'project',
    aliases: ['use', 'select', 'cd'],
    usage: '/project <name>',
    takesRest: true,
    description: 'Select the active project. Later commands apply to it.',
  },
  {
    name: 'status',
    aliases: ['st'],
    usage: '/status [project]',
    takesRest: true,
    description: 'Full status of the active (or named) project.',
  },
  {
    name: 'start',
    aliases: ['run'],
    usage: '/start [project]',
    takesRest: true,
    description: 'Start supervising the active (or named) project.',
  },
  {
    name: 'stop',
    aliases: [],
    usage: '/stop [project]',
    takesRest: true,
    destructive: true,
    description: 'Stop a running mission (the session stays resumable).',
  },
  {
    name: 'tasks',
    aliases: ['queue'],
    usage: '/tasks [project]',
    takesRest: true,
    description: "The active project's task queue and where it is.",
  },
  {
    name: 'approvals',
    aliases: ['pending'],
    usage: '/approvals',
    description: 'Every decision waiting on you, across all projects.',
  },
  {
    name: 'missions',
    aliases: ['requests'],
    usage: '/missions',
    description: 'Mission requests you have raised and not yet answered.',
  },
  {
    name: 'events',
    aliases: ['log', 'activity'],
    usage: '/events [count]',
    takesRest: true,
    description: 'The most recent things the system actually did.',
  },
  {
    name: 'reset',
    aliases: ['abandon'],
    usage: '/reset [project]',
    takesRest: true,
    destructive: true,
    description: 'Abandon an interrupted session so the next start begins fresh.',
  },
  {
    name: 'shutdown',
    aliases: [],
    usage: '/shutdown',
    destructive: true,
    description: 'Stop the Core Service itself. Nothing remote works after this.',
  },
  {
    name: 'confirm',
    aliases: ['yes'],
    usage: '/confirm <code>',
    takesRest: true,
    description: 'Confirm a destructive action you were just asked about.',
  },
  {
    name: 'cancel',
    aliases: ['no'],
    usage: '/cancel [code]',
    takesRest: true,
    description: 'Cancel a pending confirmation or a mission request.',
  },
  {
    name: 'whoami',
    aliases: ['context'],
    usage: '/whoami',
    description: 'Which project this conversation is currently pointed at.',
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
