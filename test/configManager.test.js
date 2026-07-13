/**
 * Tests for the JSON configuration layer: merging, lookups, project
 * validation, and the quality of its error messages (users see these).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigManager, ConfigError, deepMerge } from '../src/config/configManager.js';

/** Build a throwaway installation root with config files. */
function scaffold({ orchestrator, projects = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-config-'));
  fs.mkdirSync(path.join(root, 'config', 'projects'), { recursive: true });
  if (orchestrator) {
    fs.writeFileSync(
      path.join(root, 'config', 'orchestrator.json'),
      JSON.stringify(orchestrator)
    );
  }
  for (const [name, definition] of Object.entries(projects)) {
    fs.writeFileSync(
      path.join(root, 'config', 'projects', `${name}.json`),
      typeof definition === 'string' ? definition : JSON.stringify(definition)
    );
  }
  return root;
}

test('deepMerge: nested objects merge, arrays and scalars replace', () => {
  const merged = deepMerge(
    { a: { x: 1, y: 2 }, list: [1, 2], keep: 'yes' },
    { a: { y: 99 }, list: [3] }
  );
  assert.deepEqual(merged, { a: { x: 1, y: 99 }, list: [3], keep: 'yes' });
});

test('defaults apply when no orchestrator.json exists', () => {
  const config = new ConfigManager({ rootDir: scaffold() });
  assert.equal(config.get('api.port'), 4711);
  assert.equal(config.get('rateLimit.maxWaitMs'), 21_600_000);
});

test('orchestrator.json overrides defaults without erasing siblings', () => {
  const root = scaffold({ orchestrator: { api: { port: 9999 } } });
  const config = new ConfigManager({ rootDir: root });
  assert.equal(config.get('api.port'), 9999);
  assert.equal(config.get('api.host'), '127.0.0.1'); // untouched sibling
});

test('config/local.json merges over orchestrator.json (credentials stay out of git)', () => {
  const root = scaffold({
    orchestrator: {
      api: { port: 9999 },
      notifications: { telegram: { enabled: false, botToken: '', chatId: '' } },
    },
  });
  fs.writeFileSync(
    path.join(root, 'config', 'local.json'),
    JSON.stringify({
      notifications: { telegram: { enabled: true, botToken: 'SECRET', chatId: '42' } },
    })
  );
  const config = new ConfigManager({ rootDir: root });
  assert.equal(config.get('notifications.telegram.enabled'), true);
  assert.equal(config.get('notifications.telegram.botToken'), 'SECRET');
  assert.equal(config.get('notifications.telegram.chatId'), '42');
  assert.equal(config.get('api.port'), 9999); // orchestrator.json siblings untouched
});

test('config/local.json alone works with no orchestrator.json present', () => {
  const root = scaffold();
  fs.writeFileSync(
    path.join(root, 'config', 'local.json'),
    JSON.stringify({ api: { port: 1234 } })
  );
  const config = new ConfigManager({ rootDir: root });
  assert.equal(config.get('api.port'), 1234);
  assert.equal(config.get('api.host'), '127.0.0.1'); // defaults still apply
});

test('get returns the fallback for unknown paths', () => {
  const config = new ConfigManager({ rootDir: scaffold() });
  assert.equal(config.get('no.such.key', 'fallback'), 'fallback');
});

test('getProject fails helpfully for an unknown project', () => {
  const config = new ConfigManager({ rootDir: scaffold() });
  assert.throws(() => config.getProject('ghost'), (error) => {
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /ghost/);
    return true;
  });
});

test('getProject fails helpfully on invalid JSON', () => {
  const root = scaffold({ projects: { broken: '{ not json' } });
  const config = new ConfigManager({ rootDir: root });
  assert.throws(() => config.getProject('broken'), /Invalid JSON/);
});

test('getProject validates workingDirectory and promptFile existence', () => {
  const root = scaffold({
    projects: {
      bad: { workingDirectory: 'C:/definitely/not/here', promptFile: 'prompt.md' },
    },
  });
  const config = new ConfigManager({ rootDir: root });
  assert.throws(() => config.getProject('bad'), /workingDirectory/);
});

test('getProject merges project defaults and resolves the prompt path', () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-work-'));
  fs.writeFileSync(path.join(workDir, 'prompt.md'), '# mission');

  const root = scaffold({
    projects: { good: { workingDirectory: workDir, promptFile: 'prompt.md' } },
  });
  const project = new ConfigManager({ rootDir: root }).getProject('good');

  assert.equal(project.name, 'good');
  assert.equal(project.driver, 'claude'); // from defaults
  assert.equal(project.mission.completionMarker, 'MISSION COMPLETE'); // from defaults
  assert.equal(project.resolvedPromptFile, path.join(workDir, 'prompt.md'));
});

test('a mission-mode project (non-empty tasks) does not require promptFile', () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-work-'));
  fs.writeFileSync(path.join(workDir, 'task1.md'), '# task 1');

  const root = scaffold({
    projects: {
      mission: {
        workingDirectory: workDir,
        tasks: [{ id: 'T1', prompt: 'task1.md' }],
      },
    },
  });
  const project = new ConfigManager({ rootDir: root }).getProject('mission');
  assert.equal(project.tasks.length, 1);
  assert.equal(project.tasks[0].resolvedPromptFile, path.join(workDir, 'task1.md'));
  assert.equal(project.resolvedPromptFile, undefined); // never required/resolved
});

test('a mission-mode project surfaces per-task validation problems', () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-work-'));
  const root = scaffold({
    projects: {
      broken: { workingDirectory: workDir, tasks: [{ id: 'T1', prompt: 'missing.md' }] },
    },
  });
  const config = new ConfigManager({ rootDir: root });
  assert.throws(() => config.getProject('broken'), /missing\.md/);
});

test('an empty tasks array still requires promptFile (legacy mode)', () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-work-'));
  const root = scaffold({
    projects: { legacy: { workingDirectory: workDir, tasks: [] } },
  });
  const config = new ConfigManager({ rootDir: root });
  assert.throws(() => config.getProject('legacy'), /promptFile/);
});

test('listProjects returns defined project names sorted', () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-work-'));
  fs.writeFileSync(path.join(workDir, 'p.md'), 'x');
  const root = scaffold({
    projects: {
      zeta: { workingDirectory: workDir, promptFile: 'p.md' },
      alpha: { workingDirectory: workDir, promptFile: 'p.md' },
    },
  });
  assert.deepEqual(new ConfigManager({ rootDir: root }).listProjects(), ['alpha', 'zeta']);
});
