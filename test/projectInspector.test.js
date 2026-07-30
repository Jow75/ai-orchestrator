/**
 * Unit tests for operator/projectInspector.js (Phase 14 M9) — deterministic
 * language/framework/package-manager/build-test-command detection from files
 * on disk. No AI, no mission pipeline; see the module's own header comment.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectProject } from '../src/operator/projectInspector.js';

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aio-inspect-'));
}

function writeJson(dir, name, data) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
}

function writeText(dir, name, text) {
  fs.writeFileSync(path.join(dir, name), text);
}

test('an empty directory reports unknown, low confidence', () => {
  const dir = tmpProject();

  const result = inspectProject(dir);

  assert.equal(result.language, 'unknown');
  assert.equal(result.framework, null);
  assert.equal(result.packageManager, null);
  assert.equal(result.confidence, 'low');
  assert.deepEqual(result.tags, []);
});

test('a Node + Electron project is detected with high confidence and a desktop tag', () => {
  const dir = tmpProject();
  writeJson(dir, 'package.json', {
    dependencies: { electron: '^30.0.0', react: '^18.0.0' },
    scripts: { build: 'vite build', test: 'vitest run' },
  });
  writeText(dir, 'package-lock.json', '{}');

  const result = inspectProject(dir);

  assert.equal(result.language, 'javascript');
  assert.equal(result.framework, 'electron'); // electron takes priority over react
  assert.equal(result.packageManager, 'npm');
  assert.equal(result.buildCommand, 'npm run build');
  assert.equal(result.testCommand, 'npm test');
  assert.equal(result.confidence, 'high');
  assert.deepEqual(result.tags, ['desktop']);
});

test('typescript is detected via tsconfig.json even with no typescript dependency', () => {
  const dir = tmpProject();
  writeJson(dir, 'package.json', { dependencies: { express: '^4.0.0' } });
  writeText(dir, 'tsconfig.json', '{}');
  writeText(dir, 'yarn.lock', '');

  const result = inspectProject(dir);

  assert.equal(result.language, 'typescript');
  assert.equal(result.framework, 'express');
  assert.equal(result.packageManager, 'yarn');
  assert.deepEqual(result.tags, ['api', 'backend']);
});

test('a Node project with no recognized framework is medium confidence', () => {
  const dir = tmpProject();
  writeJson(dir, 'package.json', { dependencies: { lodash: '^4.0.0' } });

  const result = inspectProject(dir);

  assert.equal(result.language, 'javascript');
  assert.equal(result.framework, null);
  assert.equal(result.confidence, 'medium');
});

test('a placeholder npm-init test script is not reported as a real test command', () => {
  const dir = tmpProject();
  writeJson(dir, 'package.json', {
    scripts: { test: 'echo "Error: no test specified" && exit 1' },
  });

  const result = inspectProject(dir);

  assert.equal(result.testCommand, null);
});

test('a Python project with a Flask dependency and tests/ dir is detected', () => {
  const dir = tmpProject();
  writeText(dir, 'requirements.txt', 'flask==3.0.0\npytest==8.0.0\n');
  fs.mkdirSync(path.join(dir, 'tests'));

  const result = inspectProject(dir);

  assert.equal(result.language, 'python');
  assert.equal(result.framework, 'flask');
  assert.equal(result.packageManager, 'pip');
  assert.equal(result.testCommand, 'pytest');
  assert.equal(result.confidence, 'high');
  assert.deepEqual(result.tags, ['api', 'backend']);
});

test('a Python project using Poetry is detected as poetry, not pip', () => {
  const dir = tmpProject();
  writeText(dir, 'pyproject.toml', '[tool.poetry]\nname = "demo"\n\n[tool.poetry.dependencies]\ndjango = "^5.0"\n');

  const result = inspectProject(dir);

  assert.equal(result.packageManager, 'poetry');
  assert.equal(result.framework, 'django');
});

test('an AI-flavored dependency adds the "ai" tag', () => {
  const dir = tmpProject();
  writeJson(dir, 'package.json', { dependencies: { express: '^4.0.0', '@anthropic-ai/sdk': '^1.0.0' } });

  const result = inspectProject(dir);

  assert.deepEqual(result.tags, ['ai', 'api', 'backend']);
});

test('a Rust project is detected via Cargo.toml', () => {
  const dir = tmpProject();
  writeText(dir, 'Cargo.toml', '[package]\nname = "demo"\n\n[dependencies]\nactix-web = "4"\n');

  const result = inspectProject(dir);

  assert.equal(result.language, 'rust');
  assert.equal(result.framework, 'actix-web');
  assert.equal(result.packageManager, 'cargo');
  assert.equal(result.buildCommand, 'cargo build');
  assert.equal(result.testCommand, 'cargo test');
  assert.equal(result.confidence, 'high');
});

test('signals disclose what was actually found on disk', () => {
  const dir = tmpProject();
  writeJson(dir, 'package.json', { dependencies: { electron: '^30.0.0' } });

  const result = inspectProject(dir);

  assert.ok(result.signals.some((s) => s.includes('package.json')));
  assert.ok(result.signals.some((s) => s.includes('electron')));
});
