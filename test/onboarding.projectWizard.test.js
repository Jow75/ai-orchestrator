/**
 * Tests for the guided project-creation wizard (Phase 11B). The wizard is a
 * config writer: these assert it produces the SAME file shape `projects add`
 * writes, creates the working dir / starter prompt, and only writes a file
 * that passes the loader's own validation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigManager } from '../src/config/configManager.js';
import { createPrompter } from '../src/onboarding/prompts.js';
import { runProjectWizard } from '../src/onboarding/projectWizard.js';

/** A wizard run wired to a scripted answer queue and captured output. */
function drive(root, answers, { name } = {}) {
  const queue = [...answers];
  const out = [];
  const prompter = createPrompter({
    ask: async () => {
      if (!queue.length) throw new Error('wizard asked for more input than supplied');
      return queue.shift();
    },
    output: { write: (s) => out.push(s) },
  });
  const configManager = new ConfigManager({ rootDir: root });
  return { run: () => runProjectWizard({ configManager, prompter, name }), out: () => out.join(''), configManager };
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aio-wiz-'));
}

test('creates a valid single-prompt claude project and starter prompt', async () => {
  const root = tmpRoot();
  const wd = path.join(root, 'work'); // does not exist yet
  const { run, configManager } = drive(root, [
    'demo-proj',     // name
    wd,              // working directory
    'y',             // create it
    'claude',        // engine
    'prompt',        // work shape
    '',              // prompt path -> default prompt.md
    'y',             // create starter prompt
    'acceptEdits',   // permission mode
    '',              // allowed tools (none)
  ]);
  const { file, definition } = await run();

  // File shape matches what `projects add` writes.
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(written, {
    driver: 'claude',
    workingDirectory: path.resolve(wd),
    promptFile: 'prompt.md',
    claude: { permissionMode: 'acceptEdits' },
  });
  assert.deepEqual(written, definition);

  // Working dir + starter prompt were created.
  assert.ok(fs.statSync(path.resolve(wd)).isDirectory());
  assert.ok(fs.existsSync(path.join(path.resolve(wd), 'prompt.md')));

  // And the loader validates it without complaint.
  assert.doesNotThrow(() => configManager.getProject('demo-proj'));
});

test('re-prompts when the supplied name is already taken', async () => {
  const root = tmpRoot();
  const cm = new ConfigManager({ rootDir: root });
  cm.saveProject('taken', { driver: 'mock', workingDirectory: root, promptFile: 'p.md' });
  const wd = path.join(root, 'w2');
  const { run, out } = drive(root, [
    'fresh',   // re-prompted name (after "taken" is rejected)
    wd, 'y',   // working dir + create
    'mock',    // engine (no claude questions)
    'prompt',  // shape
    '', 'y',   // prompt path default + create
  ], { name: 'taken' });
  const { name } = await run();
  assert.equal(name, 'fresh');
  assert.match(out(), /already exists/);
});

test('creates a task-plan project with one starter task', async () => {
  const root = tmpRoot();
  const wd = path.join(root, 'twork');
  const { run, configManager } = drive(root, [
    'tasks-proj',
    wd, 'y',
    'claude',
    'tasks',            // multi-step task plan
    '', 'y',            // first task prompt (default task-1.md) + create
    'Build the thing',  // objective
    'acceptEdits',
    '',
  ]);
  const { file } = await run();
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(written.promptFile, undefined); // task mode: no top-level prompt
  assert.equal(written.tasks.length, 1);
  assert.deepEqual(written.tasks[0], { id: 'T1', objective: 'Build the thing', prompt: 'task-1.md' });
  assert.ok(fs.existsSync(path.join(path.resolve(wd), 'task-1.md')));
  assert.doesNotThrow(() => configManager.getProject('tasks-proj'));
});

test('parses comma-separated allowed tools and warns on read-only mode', async () => {
  const root = tmpRoot();
  const wd = path.join(root, 'rwork');
  const { run, out } = drive(root, [
    'ro-proj',
    wd, 'y',
    'claude',
    'prompt',
    '', 'y',
    '3',                             // read-only permission mode (option 3; empty value)
    'Bash(git:*), Bash(node:*)',     // allowed tools
  ]);
  const { definition } = await run();
  assert.equal(definition.claude.permissionMode, '');
  assert.deepEqual(definition.claude.allowedTools, ['Bash(git:*)', 'Bash(node:*)']);
  assert.match(out(), /Read-only mode/);
});

test('uses an existing working directory without offering to create it', async () => {
  const root = tmpRoot();
  const wd = path.join(root, 'exists');
  fs.mkdirSync(wd);
  fs.writeFileSync(path.join(wd, 'prompt.md'), '# already here\n');
  const { run } = drive(root, [
    'ex-proj',
    wd,          // exists -> no create confirm consumed
    'mock',
    'prompt',
    '',          // prompt path default prompt.md, already exists -> no create confirm
  ]);
  const { definition } = await run();
  assert.equal(definition.workingDirectory, path.resolve(wd));
  assert.equal(definition.promptFile, 'prompt.md');
});
