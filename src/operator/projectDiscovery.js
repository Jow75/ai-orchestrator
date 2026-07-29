/**
 * projectDiscovery.js — Phase 13 M2: find real, unregistered projects under
 * the operator's configured roots (`operator.projectRoots`).
 *
 * Deliberately shallow and always-live: one level deep per configured root,
 * marker-probed a few levels further, never cached to a state file — the
 * same "always re-read, never stale" philosophy `ConfigManager.getProject()`/
 * `listProjects()` already use (see docs/PHASE_13_PLAN.md M2). The root set
 * is a handful of folders; caching would only add staleness risk for no
 * measurable win.
 *
 * Two exclusions are unconditional, never configurable away:
 *  - AI-Orchestrator's own installation directory (ROOT_DIR) — without it, a
 *    root containing this very checkout would "discover itself."
 *  - anything already a registered project's workingDirectory.
 *
 * A directory containing `.git` is a scan LEAF: discovery never descends
 * past the first repo boundary it finds, so a monorepo's internals or a
 * nested demo folder inside a real project never become false candidates.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../infra/paths.js';

export const DEFAULT_MARKERS = Object.freeze([
  '.git', 'package.json', 'requirements.txt', 'pyproject.toml', 'Cargo.toml', 'README.md',
]);

export const DEFAULT_IGNORE = Object.freeze([
  'node_modules', '.git', 'dist', 'build', '.next', '.venv', '__pycache__',
]);

export const DEFAULT_MAX_DEPTH = 2;

function realOrResolved(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Does `dir` (or a subfolder within `maxDepth`, stopping at the first nested
 * repo boundary) contain any of `markers`?
 */
function hasMarker(dir, { markers, ignore, maxDepth }, depth = 0) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  const names = new Set(entries.map((e) => e.name));
  for (const marker of markers) {
    if (names.has(marker)) return true;
  }
  if (depth >= maxDepth) return false;
  // A directory containing .git is itself a repo boundary — the check above
  // already looked INSIDE it for markers; never descend further looking for
  // markers that would actually belong to some other, nested project.
  if (names.has('.git')) return false;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (ignore.includes(entry.name)) continue;
    if (hasMarker(path.join(dir, entry.name), { markers, ignore, maxDepth }, depth + 1)) return true;
  }
  return false;
}

/**
 * Scan configured roots for candidate projects.
 *
 * @param {string[]} roots - `operator.projectRoots`.
 * @param {object} [options]
 * @param {string[]} [options.markers]
 * @param {string[]} [options.ignore]
 * @param {number} [options.maxDepth]
 * @param {string[]} [options.existingDirs] - `workingDirectory` of every
 *   currently-registered project (any driver/status) — never re-offered.
 * @param {string} [options.selfRoot] - AI-Orchestrator's own installation
 *   directory, always excluded. Defaults to the real `ROOT_DIR`; injectable
 *   so tests can verify self-exclusion without depending on the real
 *   machine's filesystem layout.
 * @returns {{candidates: {name: string, path: string}[], rootsScanned: string[], rootsMissing: string[]}}
 */
export function scanRoots(roots, {
  markers = DEFAULT_MARKERS, ignore = DEFAULT_IGNORE, maxDepth = DEFAULT_MAX_DEPTH,
  existingDirs = [], selfRoot: selfRootOverride = ROOT_DIR,
} = {}) {
  const selfRoot = realOrResolved(selfRootOverride).toLowerCase();
  const existing = new Set(existingDirs.filter(Boolean).map((d) => realOrResolved(d).toLowerCase()));

  const candidates = [];
  const rootsScanned = [];
  const rootsMissing = [];
  const seen = new Set(); // the SAME real directory reached via two configured roots

  for (const root of roots ?? []) {
    if (!root) continue;
    if (!isDirectory(root)) {
      rootsMissing.push(root);
      continue;
    }
    rootsScanned.push(root);

    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (ignore.includes(entry.name)) continue;
      const candidatePath = path.join(root, entry.name);
      const real = realOrResolved(candidatePath).toLowerCase();
      if (real === selfRoot) continue; // never discover AI-Orchestrator's own checkout
      if (existing.has(real)) continue; // already a registered project
      if (seen.has(real)) continue;
      if (!hasMarker(candidatePath, { markers, ignore, maxDepth })) continue;
      seen.add(real);
      candidates.push({ name: entry.name, path: candidatePath });
    }
  }

  candidates.sort((a, b) => a.name.localeCompare(b.name));
  return { candidates, rootsScanned, rootsMissing };
}

export default { scanRoots, DEFAULT_MARKERS, DEFAULT_IGNORE, DEFAULT_MAX_DEPTH };
