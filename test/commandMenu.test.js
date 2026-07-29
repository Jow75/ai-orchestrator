/**
 * Tests for operator/commandMenu.js and the registration path — Phase 12 M2.2.
 *
 * The claim under test is the one the module exists for: THE MENU IS THE
 * GRAMMAR. Not "the menu is currently correct" — that would pass with a
 * hand-copied list and fail silently the first time someone adds a command.
 * So the central test asserts the two are the same set, by construction.
 *
 * The rest pins the things Telegram will reject the whole array for, and the
 * gateway behaviour that keeps a menu from ever costing the owner their
 * inbound channel.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCommandMenu, menuDescription, menusMatch, MAX_DESCRIPTION_CHARS, MAX_COMMANDS,
} from '../src/operator/commandMenu.js';
import { COMMANDS, findCommand } from '../src/operator/commandGrammar.js';
import OperatorGateway from '../src/operator/operatorGateway.js';
import TelegramApprovalProvider from '../src/approvals/providers/telegramProvider.js';
import { silentLogger } from '../src/infra/logger.js';

// ───────────────────────────────────────────── the menu is the grammar ─────

test('every command the parser accepts is published, and nothing else is', () => {
  const menu = buildCommandMenu();

  assert.deepEqual(
    menu.map((e) => e.command).sort(),
    COMMANDS.map((c) => c.name).sort(),
    'a command added to the grammar must appear in the menu without anyone remembering to add it'
  );
  for (const entry of menu) {
    assert.ok(findCommand(entry.command), `/${entry.command} is offered, so the parser must accept it`);
  }
});

test('the menu keeps grammar order — the order an owner scans in', () => {
  assert.deepEqual(buildCommandMenu().map((e) => e.command), COMMANDS.map((c) => c.name));
});

test('the operator commands the directive named are all present', () => {
  // The explicit list from the M2.2 request. Pinned separately from the
  // set-equality test above so a rename of any of these fails loudly here.
  const required = [
    'help', 'projects', 'project', 'status', 'missions', 'tasks',
    'approvals', 'events', 'start', 'stop', 'reset', 'shutdown', 'whoami',
  ];
  const published = new Set(buildCommandMenu().map((e) => e.command));
  for (const name of required) {
    assert.ok(published.has(name), `/${name} must appear in the Telegram menu`);
  }
});

// ─────────────────────────────────────────── what Telegram will accept ─────

test('every published entry satisfies Telegram\'s BotCommand rules', () => {
  const menu = buildCommandMenu();
  assert.ok(menu.length <= MAX_COMMANDS);
  for (const { command, description } of menu) {
    assert.match(command, /^[a-z0-9_]{1,32}$/, `"${command}" is not a legal command name`);
    assert.ok(description.length >= 1 && description.length <= MAX_DESCRIPTION_CHARS,
      `"${command}" has an unpublishable description`);
  }
});

test('an illegal command name fails loudly instead of being skipped', () => {
  // Telegram rejects the ENTIRE array for one bad entry, so a silent skip would
  // trade a precise error for a mysteriously incomplete menu.
  assert.throws(
    () => buildCommandMenu([{ name: 'Deploy-Now', usage: '/x', description: 'nope' }]),
    /cannot be published/
  );
  assert.throws(
    () => buildCommandMenu([{ name: 'ok', usage: '/ok', description: '' }]),
    /no description/
  );
  assert.throws(
    () => buildCommandMenu(Array.from({ length: MAX_COMMANDS + 1 }, (_, i) => ({
      name: `c${i}`, usage: '/x', description: 'd',
    }))),
    /at most 100 commands/
  );
});

test('a description carries the argument hint and the confirmation warning', () => {
  assert.match(menuDescription(findCommand('project')), /^<name> —/,
    'tapping a menu entry inserts the bare command; the argument must be advertised');
  assert.match(menuDescription(findCommand('status')), /^\[project\] —/);
  assert.doesNotMatch(menuDescription(findCommand('help')), /^[<[]/, 'no args ⇒ no hint');

  assert.match(menuDescription(findCommand('shutdown')), /asks you to confirm first/,
    'a tappable button that stops the service must say a second step exists');
  assert.doesNotMatch(menuDescription(findCommand('status')), /confirm/);
});

test('the published menu never leaks category or examples metadata (Phase 13 M8)', () => {
  // buildCommandMenu() is unchanged by M8 on purpose: the Telegram menu stays
  // {command, description} exactly as before, even though COMMANDS entries
  // now carry more fields for renderHelp() and the docs to use.
  const menu = buildCommandMenu();
  assert.ok(menu.length > 0);
  for (const entry of menu) {
    assert.deepEqual(Object.keys(entry).sort(), ['command', 'description'],
      `${entry.command}'s menu entry must carry only {command, description}`);
  }
});

test('an over-long description is clipped rather than rejected by Telegram', () => {
  const description = menuDescription({
    name: 'x', usage: '/x', description: 'y'.repeat(400),
  });
  assert.equal(description.length, MAX_DESCRIPTION_CHARS);
  assert.match(description, /…$/);
});

test('menusMatch compares content and order, and treats unknown as different', () => {
  const a = [{ command: 'help', description: 'A' }, { command: 'status', description: 'B' }];
  assert.ok(menusMatch(a, [...a]));
  assert.ok(!menusMatch(a, [a[1], a[0]]), 'order is what the owner sees');
  assert.ok(!menusMatch(a, [{ command: 'help', description: 'CHANGED' }, a[1]]));
  assert.ok(!menusMatch(a, null), 'a failed read is "unknown", never "already correct"');
  assert.ok(!menusMatch(null, a));
});

// ──────────────────────────────────────────────── the transport itself ─────

/** A Telegram provider whose every API call is recorded, none of them real. */
function fakeProvider({ setResponse, getResult } = {}) {
  const calls = [];
  const provider = new TelegramApprovalProvider({
    config: { botToken: 'T', chatId: '4242' },
    logger: silentLogger,
    fetchFn: async (url, options) => {
      const method = String(url).split('/').pop();
      calls.push({ method, body: JSON.parse(options.body ?? '{}') });
      if (method === 'getMyCommands') {
        return { ok: true, json: async () => ({ ok: true, result: getResult ?? [] }) };
      }
      return setResponse ?? { ok: true, json: async () => ({ ok: true, result: true }) };
    },
  });
  provider.calls = calls;
  return provider;
}

test('registerCommands scopes the menu to the owner\'s chat, never globally', async () => {
  const provider = fakeProvider();

  const result = await provider.registerCommands(buildCommandMenu());

  assert.equal(result.ok, true);
  assert.equal(result.count, COMMANDS.length);
  const [call] = provider.calls;
  assert.equal(call.method, 'setMyCommands');
  assert.deepEqual(call.body.scope, { type: 'chat', chat_id: 4242 },
    'a global menu would advertise commands to strangers the provider then refuses');
  assert.equal(call.body.commands.length, COMMANDS.length);
});

test('a Telegram refusal is reported with its reason, not thrown', async () => {
  const provider = fakeProvider({
    setResponse: {
      ok: false, status: 400,
      json: async () => ({ ok: false, description: 'BAD_REQUEST: command is invalid' }),
    },
  });

  const result = await provider.registerCommands(buildCommandMenu());

  assert.equal(result.ok, false);
  assert.match(result.error, /command is invalid/, 'the reason is the only actionable part');
});

test('a network failure during registration is contained', async () => {
  const provider = new TelegramApprovalProvider({
    config: { botToken: 'T', chatId: '1' },
    logger: silentLogger,
    fetchFn: async () => { throw new Error('getaddrinfo ENOTFOUND api.telegram.org'); },
  });

  const result = await provider.registerCommands(buildCommandMenu());

  assert.equal(result.ok, false);
  assert.match(result.error, /ENOTFOUND/);
});

test('an empty menu is refused before it reaches the API', async () => {
  const provider = fakeProvider();
  const result = await provider.registerCommands([]);
  assert.equal(result.ok, false);
  assert.equal(provider.calls.length, 0, 'clearing the owner\'s menu is never what was meant');
});

// ─────────────────────────────────────────────────── gateway behaviour ─────

/** A gateway over one provider, with the approval-manager surface it reads. */
function gatewayOver(provider, { operatorEnabled = true } = {}) {
  return new OperatorGateway({
    router: { operatorConfig: { enabled: operatorEnabled } },
    approvalManager: { providers: [provider] },
    logger: silentLogger,
  });
}

test('the gateway publishes the menu once and skips it when already current', async () => {
  const provider = fakeProvider();
  const gateway = gatewayOver(provider);

  const first = await gateway.publishCommandMenu();
  assert.deepEqual(first, [{ channel: 'telegram', ok: true, count: COMMANDS.length }]);
  assert.deepEqual(provider.calls.map((c) => c.method), ['getMyCommands', 'setMyCommands']);

  // Second start, with Telegram now reporting exactly what we published.
  const current = fakeProvider({ getResult: buildCommandMenu() });
  const second = await gatewayOver(current).publishCommandMenu();
  assert.equal(second[0].skipped, true);
  assert.deepEqual(current.calls.map((c) => c.method), ['getMyCommands'],
    'the service starts at every logon; an unchanged menu must not cost a write');
});

test('--force re-publishes without consulting the current menu', async () => {
  const provider = fakeProvider({ getResult: buildCommandMenu() });

  const result = await gatewayOver(provider).publishCommandMenu({ force: true });

  assert.equal(result[0].ok, true);
  assert.ok(!result[0].skipped);
  assert.deepEqual(provider.calls.map((c) => c.method), ['setMyCommands']);
});

test('no menu is published when the operator interface is disabled', async () => {
  const provider = fakeProvider();

  const result = await gatewayOver(provider, { operatorEnabled: false }).publishCommandMenu();

  assert.deepEqual(result, []);
  assert.equal(provider.calls.length, 0,
    'the router refuses every command in this mode; a menu of them would be a lie');
});

test('a channel that cannot register commands is passed over, not crashed on', async () => {
  const gateway = new OperatorGateway({
    router: { operatorConfig: {} },
    approvalManager: { providers: [{ name: 'future-channel', canRoute: true }] },
    logger: silentLogger,
  });

  assert.deepEqual(await gateway.publishCommandMenu(), []);
});

test('a failing publish never propagates out of the gateway', async () => {
  const provider = fakeProvider();
  provider.fetchRegisteredCommands = async () => null;
  provider.registerCommands = async () => { throw new Error('exploded'); };

  const result = await gatewayOver(provider).publishCommandMenu();

  assert.deepEqual(result, [{ channel: 'telegram', ok: false, count: 0, error: 'exploded' }]);
});
