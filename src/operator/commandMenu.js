/**
 * commandMenu.js — Phase 12 M2.2: the command list a chat client can show.
 *
 * Telegram will render a tappable menu for a bot that tells it what commands
 * exist (`setMyCommands`). Until it is told, an owner has to remember the
 * grammar, which on a phone means they mostly don't: the M2 live validation
 * showed free text being used for things `/status` answers better, because
 * free text is what you can type without remembering anything.
 *
 * The rule this module exists to enforce is the same one commandGrammar.js
 * states for `destructive`:
 *
 *     THE MENU IS DERIVED FROM THE PARSER, NEVER MAINTAINED BESIDE IT.
 *
 * A hand-kept list would drift, and drift here is worse than absence — a menu
 * that offers `/deploy` teaches the owner a command that will be refused, and
 * one that omits `/service` hides a command that works. So `buildCommandMenu()`
 * reads COMMANDS and nothing else. Adding a command to the grammar adds it to
 * every phone menu; deleting one removes it.
 *
 * Everything here is pure. The API call lives in the Telegram provider, which
 * is the thing that already owns the token — see registerCommands() there.
 */

import { COMMANDS } from './commandGrammar.js';

/**
 * Telegram's constraints on a BotCommand (Bot API `setMyCommands`).
 *
 * Enforced rather than assumed: the whole call is rejected if ANY entry is
 * invalid, so one bad command name would silently cost the owner the entire
 * menu. Validating locally turns that into a specific, fixable error.
 */
export const MAX_COMMANDS = 100;
export const MAX_DESCRIPTION_CHARS = 256;
const VALID_NAME = /^[a-z0-9_]{1,32}$/;

/**
 * The argument hint out of a usage string: `/project <name>` → `<name>`,
 * `/status [project]` → `[project]`, `/help` → null.
 *
 * Worth carrying into the description because the menu shows ONLY the
 * description — tapping an entry inserts the bare command, and an owner who
 * then sees "Select the active project" with no idea that a name goes after it
 * has been given a button that does nothing.
 */
function argumentHint(usage) {
  const match = String(usage ?? '').match(/\s([<[].*)$/);
  return match ? match[1].trim() : null;
}

/**
 * One command's menu description: argument hint, the grammar's own sentence,
 * and — for anything destructive — the fact that it will ask first.
 *
 * The confirmation note is not decoration. `/shutdown` in a tappable list is a
 * button that stops the service; an owner is entitled to know from the menu,
 * before tapping, that a second step exists.
 */
export function menuDescription(command) {
  const hint = argumentHint(command.usage);
  const parts = [];
  if (hint) parts.push(`${hint} —`);
  parts.push(command.description);
  if (command.destructive) parts.push('(asks you to confirm first)');
  const text = parts.join(' ');
  return text.length > MAX_DESCRIPTION_CHARS
    ? `${text.slice(0, MAX_DESCRIPTION_CHARS - 1)}…`
    : text;
}

/**
 * Every command, in Telegram's BotCommand shape, in grammar order.
 *
 * Order is deliberate and inherited: COMMANDS runs from "what can I see" to
 * "what can I change" to "what did I just get asked", which is the order an
 * owner scans a menu in.
 *
 * @param {object[]} [commands] - Defaults to the real grammar; injectable so
 *   the validation below can be tested without inventing a fake grammar.
 * @returns {{command: string, description: string}[]}
 * @throws {Error} When a command cannot legally be published. Loud on purpose:
 *   Telegram rejects the whole array for one bad entry, so a silent skip would
 *   trade a specific error for a mysteriously incomplete menu.
 */
export function buildCommandMenu(commands = COMMANDS) {
  if (commands.length > MAX_COMMANDS) {
    throw new Error(
      `Telegram accepts at most ${MAX_COMMANDS} commands; the grammar defines ${commands.length}.`
    );
  }
  return commands.map((command) => {
    if (!VALID_NAME.test(command.name)) {
      throw new Error(
        `Command "${command.name}" cannot be published to Telegram: names must be 1-32 ` +
        'characters of lowercase letters, digits or underscores.'
      );
    }
    const description = menuDescription(command);
    if (!description) {
      throw new Error(`Command "${command.name}" has no description to publish.`);
    }
    return { command: command.name, description };
  });
}

/**
 * Whether two menus are the same, so a caller can skip a pointless API call.
 *
 * Compares content and ORDER, because order is what the owner sees.
 *
 * @param {{command:string, description:string}[]|null} a
 * @param {{command:string, description:string}[]|null} b
 */
export function menusMatch(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((entry, i) =>
    entry.command === b[i].command && entry.description === b[i].description);
}

export default { buildCommandMenu, menuDescription, menusMatch, MAX_COMMANDS, MAX_DESCRIPTION_CHARS };
