/**
 * Tests for the first-run flow (Phase 11A). These verify the ORCHESTRATION —
 * which steps run on yes/no, the auto-resume branch, and the closing summary
 * — with every sub-wizard and probe injected, so no real environment or
 * network is touched.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigManager } from '../src/config/configManager.js';
import { createPrompter } from '../src/onboarding/prompts.js';
import { runInit } from '../src/onboarding/init.js';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aio-init-'));
}

function harness(root, answers) {
  const queue = [...answers];
  const out = [];
  const prompter = createPrompter({
    // Echo the query text too, exactly as real readline would print the
    // prompt — otherwise confirm()/text()'s own question text (as opposed
    // to say() calls) would be invisible to assertions on out().
    ask: async (query) => {
      out.push(query);
      if (!queue.length) throw new Error('init asked for more input than supplied');
      return queue.shift();
    },
    output: { write: (s) => out.push(s) },
  });
  return { prompter, out: () => out.join(''), configManager: new ConfigManager({ rootDir: root }) };
}

/** Injected fakes that record whether each step ran. */
function fakes(overrides = {}) {
  const calls = { project: 0, telegram: 0, email: 0, install: 0 };
  return {
    calls,
    probe: async () => [{ label: 'Node.js v22', ok: true, detail: 'supported' }],
    notifyTest: async () => [{ name: 'desktop', ok: true }],
    projectWizard: async () => { calls.project += 1; },
    telegramWizard: async () => { calls.telegram += 1; },
    emailWizard: async () => { calls.email += 1; },
    autoResume: {
      isInstalled: async () => false,
      install: async () => { calls.install += 1; },
    },
    ...overrides,
  };
}

test('yes to everything runs every step', async () => {
  const root = tmpRoot();
  const { prompter, configManager } = harness(root, ['y', 'y', 'y', 'y']);
  const f = fakes();
  await runInit({ configManager, prompter, ...f });
  assert.deepEqual(f.calls, { project: 1, telegram: 1, email: 1, install: 1 });
});

test('no to everything skips every step', async () => {
  const root = tmpRoot();
  const { prompter, configManager } = harness(root, ['n', 'n', 'n', 'n']);
  const f = fakes();
  await runInit({ configManager, prompter, ...f });
  assert.deepEqual(f.calls, { project: 0, telegram: 0, email: 0, install: 0 });
});

test('an already-installed auto-resume task skips the install prompt', async () => {
  const root = tmpRoot();
  // Only 3 answers: create/telegram/email — no install confirm is asked.
  const { prompter, out, configManager } = harness(root, ['n', 'n', 'n']);
  const f = fakes({ autoResume: { isInstalled: async () => true, install: async () => { throw new Error('should not run'); } } });
  await runInit({ configManager, prompter, ...f });
  assert.match(out(), /already installed/);
});

test('no auto-resume control (non-Windows) simply omits that step', async () => {
  const root = tmpRoot();
  const { prompter, configManager } = harness(root, ['n', 'n', 'n']);
  const f = fakes({ autoResume: null });
  await runInit({ configManager, prompter, ...f });
  // Reaching here without an "asked for more input" error proves no 4th prompt.
  assert.ok(true);
});

test('summary reflects existing projects and enabled channels', async () => {
  const root = tmpRoot();
  const cm = new ConfigManager({ rootDir: root });
  cm.saveProject('alpha', { driver: 'mock', workingDirectory: root, promptFile: 'p.md' });
  cm.writeLocalConfig({ notifications: { telegram: { enabled: true, botToken: 't', chatId: '1' } } });

  // No startMission injected here -> the start-now offer is skipped entirely
  // (no 5th prompt consumed), so the summary must fall back to a concrete,
  // copy-pasteable command — never the old `<project>` placeholder.
  const { prompter, out, configManager } = harness(root, ['n', 'n', 'n', 'n']);
  await runInit({ configManager, prompter, ...fakes() });
  const text = out();
  assert.match(text, /already have 1 project/);
  assert.match(text, /Projects:\s+alpha/);
  assert.match(text, /Channels:.*telegram/);
  assert.match(text, /Start a mission:\s+ai-orchestrator start alpha/);
  assert.ok(!text.includes('<project>'), 'must never print the literal placeholder');
});

test('no projects at all: no start-now offer, summary says to create one', async () => {
  const root = tmpRoot();
  const { prompter, out, configManager } = harness(root, ['n', 'n', 'n', 'n']);
  const calls = [];
  await runInit({
    configManager, prompter,
    ...fakes({ startMission: async (name) => { calls.push(name); return { complete: true }; } }),
  });
  assert.deepEqual(calls, []); // never offered — nothing to start
  assert.match(out(), /Create a project:\s+ai-orchestrator projects add --interactive/);
});

test('offers to start the single existing project and launches it on yes', async () => {
  const root = tmpRoot();
  const cm = new ConfigManager({ rootDir: root });
  cm.saveProject('alpha', { driver: 'mock', workingDirectory: root, promptFile: 'p.md' });
  const calls = [];
  const { prompter, out, configManager } = harness(root, ['n', 'n', 'n', 'n', 'y']);
  await runInit({
    configManager, prompter,
    ...fakes({ startMission: async (name) => { calls.push(name); return { complete: true, reason: 'all done' }; } }),
  });
  assert.deepEqual(calls, ['alpha']);
  assert.match(out(), /Start "alpha" now\?/);
  assert.match(out(), /Starting "alpha"/);
  assert.match(out(), /Mission complete: all done/);
  assert.match(out(), /"alpha" is running.*ai-orchestrator stop/s);
});

test('declining the start-now offer falls back to the concrete command', async () => {
  const root = tmpRoot();
  const cm = new ConfigManager({ rootDir: root });
  cm.saveProject('alpha', { driver: 'mock', workingDirectory: root, promptFile: 'p.md' });
  const calls = [];
  const { prompter, out, configManager } = harness(root, ['n', 'n', 'n', 'n', 'n']);
  await runInit({
    configManager, prompter,
    ...fakes({ startMission: async (name) => { calls.push(name); return { complete: true }; } }),
  });
  assert.deepEqual(calls, []);
  assert.match(out(), /Start a mission:\s+ai-orchestrator start alpha/);
});

test('multiple existing projects: asks which one, chosen by number', async () => {
  const root = tmpRoot();
  const cm = new ConfigManager({ rootDir: root });
  cm.saveProject('alpha', { driver: 'mock', workingDirectory: root, promptFile: 'p.md' });
  cm.saveProject('beta', { driver: 'mock', workingDirectory: root, promptFile: 'p.md' });
  const calls = [];
  // 5th answer 'y' (start now), 6th answer picks "beta" by its list number.
  const { prompter, configManager } = harness(root, ['n', 'n', 'n', 'n', 'y', '2']);
  await runInit({
    configManager, prompter,
    ...fakes({ startMission: async (name) => { calls.push(name); return { complete: true }; } }),
  });
  assert.deepEqual(calls, ['beta']);
});

test('a project name with a space is quoted in the concrete command', async () => {
  const root = tmpRoot();
  const cm = new ConfigManager({ rootDir: root });
  cm.saveProject('My Project', { driver: 'mock', workingDirectory: root, promptFile: 'p.md' });
  const { prompter, out, configManager } = harness(root, ['n', 'n', 'n', 'n']);
  await runInit({ configManager, prompter, ...fakes() });
  assert.match(out(), /ai-orchestrator start "My Project"/);
});
