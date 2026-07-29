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

test('deepMerge: a branch the source never touches is a clone, never the SAME object as target\'s (Phase 13 M4)', () => {
  // Regression test for a real bug found while building LiveConfigLayer: a
  // shallow `{...target}` spread leaves an untouched nested object
  // reference-equal to the one inside `target` — which, when `target` is
  // the shared, module-level ORCHESTRATOR_DEFAULTS, means an in-place
  // mutation of the merged result silently corrupts that singleton for
  // every other ConfigManager in the process.
  const target = { untouched: { deep: { value: 1 }, list: ['a', 'b'] } };
  const merged = deepMerge(target, {});
  assert.notEqual(merged.untouched, target.untouched, 'must be a fresh clone, not the same reference');
  assert.notEqual(merged.untouched.deep, target.untouched.deep, 'independence must hold at every depth');
  assert.notEqual(merged.untouched.list, target.untouched.list, 'arrays must be cloned too, not just objects');

  merged.untouched.deep.value = 999;
  merged.untouched.list.push('c');
  assert.equal(target.untouched.deep.value, 1, 'mutating the merged result must never affect target');
  assert.deepEqual(target.untouched.list, ['a', 'b'], 'nor may pushing onto a cloned array affect target\'s');
});

test('a live-config mutation on one ConfigManager never corrupts a second instance built from the same defaults', () => {
  const configA = new ConfigManager({ rootDir: scaffold({}) });
  const configB = new ConfigManager({ rootDir: scaffold({}) });
  configA.load();
  configB.load();

  // Simulate what LiveConfigLayer does: mutate a nested object in place.
  configA.getAll().operator.projectRoots.push('C:\\Only\\In\\A');

  assert.ok(!configB.getAll().operator.projectRoots.includes('C:\\Only\\In\\A'),
    'a second, independently-loaded ConfigManager must never see the first one\'s live mutation');
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

test('writeLocalConfig creates config/local.json and it merges on load', () => {
  const root = scaffold();
  const config = new ConfigManager({ rootDir: root });
  const file = config.writeLocalConfig({
    notifications: { telegram: { enabled: true, botToken: 'TOK', chatId: '99' } },
  });
  assert.ok(fs.existsSync(file));
  // A fresh manager reading the same root picks the credentials up.
  const reloaded = new ConfigManager({ rootDir: root });
  assert.equal(reloaded.get('notifications.telegram.enabled'), true);
  assert.equal(reloaded.get('notifications.telegram.botToken'), 'TOK');
  assert.equal(reloaded.get('notifications.telegram.chatId'), '99');
});

test('writeLocalConfig deep-merges, preserving unrelated existing keys', () => {
  const root = scaffold();
  const config = new ConfigManager({ rootDir: root });
  config.writeLocalConfig({ notifications: { telegram: { enabled: true, botToken: 'TOK' } } });
  // A second wizard writes an unrelated block; the first must survive.
  config.writeLocalConfig({ approvals: { providers: { telegram: { enabled: true } } } });
  const written = JSON.parse(
    fs.readFileSync(path.join(root, 'config', 'local.json'), 'utf8')
  );
  assert.equal(written.notifications.telegram.botToken, 'TOK'); // preserved
  assert.equal(written.approvals.providers.telegram.enabled, true); // added
});

test('writeLocalConfig creates the config dir when it does not exist', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-nocfg-'));
  const config = new ConfigManager({ rootDir: root });
  const file = config.writeLocalConfig({ api: { port: 5000 } });
  assert.ok(fs.existsSync(file));
  assert.equal(new ConfigManager({ rootDir: root }).get('api.port'), 5000);
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

// ── getRawProject (Phase 13 M2) ─────────────────────────────────────────────

test('getRawProject returns the merged definition even when it would fail validation', () => {
  const root = scaffold({
    projects: { broken: { workingDirectory: '/does/not/exist' } }, // no promptFile, no tasks
  });
  const config = new ConfigManager({ rootDir: root });
  assert.throws(() => config.getProject('broken'), /workingDirectory|promptFile/);

  const raw = config.getRawProject('broken');
  assert.equal(raw.workingDirectory, '/does/not/exist');
  assert.equal(raw.driver, 'claude'); // PROJECT_DEFAULTS still applied
});

test('getRawProject returns null for an unknown project or invalid JSON, never throws', () => {
  const root = scaffold({});
  const config = new ConfigManager({ rootDir: root });
  assert.equal(config.getRawProject('nope'), null);
  assert.equal(config.getRawProject(''), null);

  fs.mkdirSync(config.getPaths().projectsDir, { recursive: true });
  fs.writeFileSync(path.join(config.getPaths().projectsDir, 'bad.json'), '{ not json');
  assert.equal(config.getRawProject('bad'), null);
});

// ── getProjectFileContents (Phase 13 M3) ────────────────────────────────────

test('getProjectFileContents returns exactly what is on disk, with no defaults merged in', () => {
  const root = scaffold({
    projects: { p: { workingDirectory: '/w', driver: 'claude' } }, // no "classification" key
  });
  const config = new ConfigManager({ rootDir: root });

  const raw = config.getProjectFileContents('p');
  assert.equal(raw.classification, undefined, 'PROJECT_DEFAULTS.classification must NOT leak in');
  assert.equal(config.getRawProject('p').classification, 'development', 'but getRawProject DOES apply it');
});

test('getProjectFileContents returns null for an unknown project or invalid JSON', () => {
  const root = scaffold({});
  const config = new ConfigManager({ rootDir: root });
  assert.equal(config.getProjectFileContents('nope'), null);
  fs.mkdirSync(config.getPaths().projectsDir, { recursive: true });
  fs.writeFileSync(path.join(config.getPaths().projectsDir, 'bad.json'), '{ not json');
  assert.equal(config.getProjectFileContents('bad'), null);
});

// ── updateProject / deleteProject (Phase 13 M3) ─────────────────────────────

test('updateProject deep-merges a patch into the RAW file, without baking in defaults', () => {
  const root = scaffold({
    projects: { p: { workingDirectory: '/w', driver: 'claude', description: 'keep me' } },
  });
  const config = new ConfigManager({ rootDir: root });

  const merged = config.updateProject('p', { classification: 'archived' });
  assert.equal(merged.classification, 'archived');
  assert.equal(merged.description, 'keep me', 'unrelated fields survive the patch');
  assert.equal(merged.promptFile, undefined, 'PROJECT_DEFAULTS were never merged into the written file');

  // Re-reading the raw file confirms it was actually persisted, not just returned.
  assert.equal(config.getProjectFileContents('p').classification, 'archived');
});

test('updateProject refuses an unknown classification rather than writing it', () => {
  const root = scaffold({ projects: { p: { workingDirectory: '/w', driver: 'claude' } } });
  const config = new ConfigManager({ rootDir: root });
  assert.throws(() => config.updateProject('p', { classification: 'nonsense' }), /classification.*must be one of/);
  assert.equal(config.getProjectFileContents('p').classification, undefined, 'the bad patch was never written');
});

test('updateProject succeeds even on a project that would fail full validation', () => {
  // No promptFile, no tasks — getProject() would throw on this. Lifecycle
  // operations (archive a broken/imported project) must still work.
  const root = scaffold({ projects: { broken: { workingDirectory: '/w', driver: 'claude' } } });
  const config = new ConfigManager({ rootDir: root });
  assert.throws(() => config.getProject('broken'), /promptFile/);
  const merged = config.updateProject('broken', { classification: 'archived' });
  assert.equal(merged.classification, 'archived');
});

test('updateProject throws for an unknown project', () => {
  const config = new ConfigManager({ rootDir: scaffold({}) });
  assert.throws(() => config.updateProject('nope', { classification: 'archived' }), /not found/);
});

test('deleteProject removes the definition file and nothing else', () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-work-'));
  fs.writeFileSync(path.join(workDir, 'marker.txt'), 'still here');
  const root = scaffold({ projects: { p: { workingDirectory: workDir, driver: 'claude' } } });
  const config = new ConfigManager({ rootDir: root });

  config.deleteProject('p');

  assert.equal(config.getProjectFileContents('p'), null);
  assert.ok(fs.existsSync(path.join(workDir, 'marker.txt')), 'the project\'s real files are NEVER touched');
});

test('deleteProject throws for an unknown project', () => {
  const config = new ConfigManager({ rootDir: scaffold({}) });
  assert.throws(() => config.deleteProject('nope'), /not found/);
});
