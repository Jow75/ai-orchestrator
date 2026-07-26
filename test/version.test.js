/**
 * Test for src/infra/version.js — Phase 11 M4 found the version string
 * hardcoded in three places (package.json, the CLI's `.version()`, and
 * statusManager.js) kept in sync by hand alone. This guards the fix: all
 * three now read from here, so this test pins it to package.json itself.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../src/infra/version.js';

test('VERSION matches package.json — the one source of truth', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(VERSION, pkg.version);
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});
