/**
 * infra/version.js — the single place the running version is read from.
 *
 * Phase 11 M4: a terminology/consistency audit found the version string
 * hardcoded in three places (package.json, the CLI's `.version()` call, and
 * statusManager.js's status snapshot) — kept in sync by hand discipline
 * alone at every release. All three now read from here instead, so a
 * version bump is one line, not three.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from './paths.js';

const packageJson = JSON.parse(
  fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')
);

/** The version declared in package.json — the one source of truth. */
export const VERSION = packageJson.version;

export default VERSION;
