/**
 * Unit tests for operator/commandGrammar.js — Phase 12 M2.
 *
 * The inbound grammar is the widest new attack surface this phase adds, and
 * the parser is pure, so this file leans hard on what it must REFUSE:
 *
 *   - a decision verb with an id this system never issued resolves nothing;
 *   - an unknown slash command never becomes a mission objective;
 *   - prose that happens to start with a command word stays prose.
 *
 * The last one is the subtle one. On a free-text channel "start by reading the
 * README" and "start" arrive through the same pipe, and reading the first as a
 * command would launch a mission nobody asked for.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCommand, findCommand, idKind, destructiveCommands, COMMANDS,
} from '../src/operator/commandGrammar.js';

test('an empty or whitespace message is nothing at all', () => {
  assert.equal(parseCommand('').kind, 'empty');
  assert.equal(parseCommand('   ').kind, 'empty');
  assert.equal(parseCommand(null).kind, 'empty');
  assert.equal(parseCommand('/').kind, 'empty');
});

test('the Phase 10 decision grammar is unchanged, with or without a slash', () => {
  const approve = parseCommand('APPROVE A7');
  assert.equal(approve.kind, 'decision');
  assert.equal(approve.requestId, 'A7');
  assert.equal(approve.decision, 'approved');
  assert.equal(approve.idKind, 'approval');

  const reject = parseCommand('/reject A7 too risky for a friday');
  assert.equal(reject.decision, 'rejected');
  assert.equal(reject.note, 'too risky for a friday');

  assert.equal(parseCommand('done A9').decision, 'done');
  assert.equal(parseCommand('MoDiFy A3 skip step two').decision, 'modified');
});

test('a decision on a mission request is routed to the mission store', () => {
  const parsed = parseCommand('APPROVE M3');

  assert.equal(parsed.kind, 'decision');
  assert.equal(parsed.idKind, 'mission-request');
  assert.equal(idKind('M12'), 'mission-request');
  assert.equal(idKind('A12'), 'approval');
  assert.equal(idKind('X12'), null);
});

test('a decision verb with an id this system never issues resolves NOTHING', () => {
  const parsed = parseCommand('APPROVE everything');

  assert.equal(parsed.kind, 'unknown-command', 'refused, not searched for a match');
  assert.equal(parsed.decisionVerb, true, 'and the reply can say what a real id looks like');
});

test('slash commands and their aliases resolve to one canonical name', () => {
  assert.equal(parseCommand('/projects').name, 'projects');
  assert.equal(parseCommand('/ls').name, 'projects');
  assert.equal(parseCommand('/use Remote Work').name, 'project');
  assert.equal(parseCommand('/cd calculator').name, 'project');
  assert.equal(findCommand('QUEUE').name, 'tasks');
  assert.equal(findCommand('nope'), null);
});

test('a rest-taking command keeps the whole remainder, spaces and all', () => {
  const parsed = parseCommand('/project Remote Work');

  assert.equal(parsed.kind, 'command');
  assert.equal(parsed.name, 'project');
  assert.equal(parsed.rest, 'Remote Work', 'a project name with a space survives intact');
  assert.deepEqual(parsed.args, ['Remote', 'Work']);
});

test('an unknown SLASH command is refused — never demoted to free text', () => {
  const parsed = parseCommand('/delete-everything now');

  assert.equal(parsed.kind, 'unknown-command');
  assert.equal(parsed.name, 'delete-everything');
});

test('a bare command word without a slash still works', () => {
  assert.equal(parseCommand('projects').kind, 'command');
  assert.equal(parseCommand('help').name, 'help');
  assert.equal(parseCommand('status calculator').name, 'status');
});

test('prose that begins with a command word stays prose', () => {
  const cases = [
    'start by reading the README and then refactor the payroll module',
    'projects are a mess right now, please tidy the folder structure',
    'status update: the dashboard is done, move on to the reports page',
  ];
  for (const text of cases) {
    assert.equal(parseCommand(text).kind, 'free-text', `"${text.slice(0, 24)}…" is prose`);
  }
});

test('the same prose WITH a slash is taken at its word', () => {
  // An explicit slash is an unambiguous declaration of intent; the owner gets
  // what they asked for, and the router validates the argument.
  assert.equal(parseCommand('/start by reading the README and then refactor').kind, 'command');
});

test('an ordinary sentence is free text and keeps its exact wording', () => {
  const parsed = parseCommand('  Build a payroll dashboard with CSV export.  ');

  assert.equal(parsed.kind, 'free-text');
  assert.equal(parsed.text, 'Build a payroll dashboard with CSV export.');
});

test('every destructive command is declared in the grammar, not in the router', () => {
  const destructive = destructiveCommands();

  assert.deepEqual(destructive.sort(), ['reset', 'shutdown', 'stop']);
  for (const name of destructive) {
    assert.equal(findCommand(name).destructive, true);
  }
});

test('every command has a usage line and a description (this is what /help renders)', () => {
  for (const command of COMMANDS) {
    assert.ok(command.usage?.startsWith('/'), `${command.name} has a usage line`);
    assert.ok(command.description?.length > 10, `${command.name} has a description`);
  }
});
