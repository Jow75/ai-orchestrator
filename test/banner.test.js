/**
 * Tests for src/cli/banner.js — Phase 11 M4's startup banner. Pure builder
 * (buildStartupBanner) is tested against a real ConfigManager over a
 * throwaway root so project/mode/channel resolution is exercised for real,
 * not mocked; renderStartupBanner is tested separately as a pure formatter.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigManager } from '../src/config/configManager.js';
import { buildStartupBanner, renderStartupBanner } from '../src/cli/banner.js';
import { VERSION } from '../src/infra/version.js';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aio-banner-'));
}

/** getProject() validates promptFile actually exists — write a real one. */
function withPrompt(root, extra = {}) {
  const promptFile = path.join(root, 'banner-test-prompt.md');
  if (!fs.existsSync(promptFile)) fs.writeFileSync(promptFile, '# prompt\n');
  return { driver: 'mock', workingDirectory: root, promptFile: 'banner-test-prompt.md', ...extra };
}

test('no project requested and none configured → a clear placeholder, not a crash', () => {
  const configManager = new ConfigManager({ rootDir: tmpRoot() });
  const banner = buildStartupBanner({ projectNames: [], configManager });
  assert.equal(banner.version, VERSION);
  assert.match(banner.projects[0], /no project/i);
  assert.equal(banner.mode, 'balanced'); // the global default
  assert.deepEqual(banner.channels, ['desktop']); // enabled by default, unlike every remote channel
});

test('falls back to the configured defaultProject when none is passed', () => {
  const root = tmpRoot();
  const configManager = new ConfigManager({ rootDir: root });
  configManager.saveProject('alpha', withPrompt(root));
  configManager.writeLocalConfig({ defaultProject: 'alpha' });
  configManager.load(); // global config is cached — reload to see the write, exactly as a fresh CLI process would
  const banner = buildStartupBanner({ projectNames: [], configManager });
  assert.deepEqual(banner.projects, ['alpha']);
  assert.equal(banner.mode, 'balanced');
});

test('reports a project\'s own approval-mode override, not just the global default', () => {
  const root = tmpRoot();
  const configManager = new ConfigManager({ rootDir: root });
  configManager.saveProject('alpha', withPrompt(root, { approvals: { mode: 'autonomous' } }));
  const banner = buildStartupBanner({ projectNames: ['alpha'], configManager });
  assert.equal(banner.mode, 'autonomous');
});

test('several projects with differing modes are all shown', () => {
  const root = tmpRoot();
  const configManager = new ConfigManager({ rootDir: root });
  configManager.saveProject('a', withPrompt(root, { approvals: { mode: 'conservative' } }));
  configManager.saveProject('b', withPrompt(root, { approvals: { mode: 'autonomous' } }));
  const banner = buildStartupBanner({ projectNames: ['a', 'b'], configManager });
  assert.ok(banner.mode.includes('conservative'));
  assert.ok(banner.mode.includes('autonomous'));
});

test('approvals disabled globally is reported plainly, not as a mode name', () => {
  const root = tmpRoot();
  const configManager = new ConfigManager({ rootDir: root });
  configManager.writeLocalConfig({ approvals: { enabled: false } });
  configManager.load();
  const banner = buildStartupBanner({ projectNames: [], configManager });
  assert.equal(banner.mode, 'approvals disabled');
});

test('an unresolvable project name never throws — banner is cosmetic only', () => {
  const configManager = new ConfigManager({ rootDir: tmpRoot() });
  assert.doesNotThrow(() => buildStartupBanner({ projectNames: ['no-such-project'], configManager }));
});

test('lists every enabled notification channel', () => {
  const root = tmpRoot();
  const configManager = new ConfigManager({ rootDir: root });
  configManager.writeLocalConfig({
    notifications: {
      telegram: { enabled: true, botToken: 't', chatId: '1' },
      desktop: { enabled: true },
    },
  });
  configManager.load();
  const banner = buildStartupBanner({ projectNames: [], configManager });
  assert.deepEqual(banner.channels.sort(), ['Telegram', 'desktop'].sort());
});

test('renderStartupBanner is a plain multi-line, phone-readable summary', () => {
  const text = renderStartupBanner({
    version: '9.9.9', projects: ['alpha'], mode: 'balanced', channels: ['Telegram'],
  });
  assert.match(text, /AI-Orchestrator v9\.9\.9/);
  assert.match(text, /Project: alpha/);
  assert.match(text, /Mode: balanced/);
  assert.match(text, /Notifications: Telegram/);
  assert.match(text, /owner-gate/);
});

test('renderStartupBanner pluralizes "Projects" for parallel missions', () => {
  const text = renderStartupBanner({ version: '1.0.0', projects: ['a', 'b'], mode: 'balanced', channels: [] });
  assert.match(text, /^Projects: a, b$/m);
});

test('renderStartupBanner says so when nothing is configured', () => {
  const text = renderStartupBanner({ version: '1.0.0', projects: ['a'], mode: 'balanced', channels: [] });
  assert.match(text, /Notifications: none configured/);
});
