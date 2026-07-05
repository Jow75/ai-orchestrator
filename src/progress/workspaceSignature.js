/**
 * workspaceSignature.js — Objective progress measurement.
 *
 * The overnight incident happened because the orchestrator had no way to
 * tell "the agent is making progress" from "the agent is spinning". This
 * module answers that question by reducing a project's workspace to a short
 * signature. Two runs that leave the workspace byte-identical produce the
 * same signature; any file created, modified, or deleted changes it.
 *
 * Strategy, best-to-worst:
 *   1. git    — HEAD commit + `git status --porcelain` + a digest of the
 *               contents of dirty files. Captures commits AND uncommitted
 *               edits, which is exactly how a coding agent shows progress.
 *   2. filescan — a digest of every file's relative path + size + mtime,
 *               skipping noise (node_modules, .git, build/state/log dirs).
 *
 * FAIL CLOSED: if a signature genuinely cannot be computed, the caller must
 * treat the run as "no progress". For a quota-protecting feature, refusing
 * to certify progress it cannot see is the safe direction — worst case a
 * real mission is paused for review, never an infinite loop.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

/** Directories never worth scanning for agent progress. */
const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage',
  '.next', '.cache', '.venv', 'venv', '__pycache__', 'logs', 'state',
]);

/** Upper bounds so a signature can never take unbounded time/memory. */
const MAX_FILES_SCANNED = 20_000;
const MAX_DIRTY_FILE_BYTES = 2_000_000; // per-file cap when digesting git-dirty files
const GIT_TIMEOUT_MS = 20_000;

/**
 * Compute a signature of the workspace's current state.
 *
 * @param {string} dir - The project's working directory.
 * @param {object} [options]
 * @param {object} [options.logger] - Optional logger for diagnostics.
 * @returns {{ hash: string|null, method: 'git'|'filescan'|'none', detail: object }}
 *   `hash` is null only when nothing could be measured (caller fails closed).
 */
export function computeWorkspaceSignature(dir, { logger } = {}) {
  if (!dir || !fs.existsSync(dir)) {
    return { hash: null, method: 'none', detail: { reason: 'workingDirectory missing' } };
  }

  const gitSig = tryGitSignature(dir);
  if (gitSig) return gitSig;

  try {
    return fileScanSignature(dir);
  } catch (error) {
    logger?.warn?.('Could not compute workspace signature', { dir, error: error.message });
    return { hash: null, method: 'none', detail: { reason: error.message } };
  }
}

/** git-based signature, or null when dir is not a git work tree. */
function tryGitSignature(dir) {
  const git = (args) =>
    execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });

  let head;
  try {
    // Fails (throws) when dir is not inside a git work tree — the signal to
    // fall back to a filesystem scan.
    head = git(['rev-parse', 'HEAD']).trim();
  } catch {
    try {
      // A brand-new repo with no commits yet is still git-trackable.
      git(['rev-parse', '--is-inside-work-tree']);
      head = 'no-commits-yet';
    } catch {
      return null;
    }
  }

  let porcelain = '';
  try {
    porcelain = git(['status', '--porcelain', '--untracked-files=all']);
  } catch {
    return null;
  }

  // Digest the CONTENTS of dirty/untracked files so that edits which do not
  // change a file's git status line still move the signature.
  const hash = crypto.createHash('sha256');
  hash.update(`HEAD:${head}\n`);
  hash.update(porcelain);

  let dirtyFiles = 0;
  for (const line of porcelain.split('\n')) {
    const rel = line.slice(3).trim().replace(/^"|"$/g, '');
    if (!rel || line.startsWith(' D') || line.startsWith('D ')) continue;
    const abs = path.join(dir, rel);
    try {
      const stat = fs.statSync(abs);
      if (stat.isFile() && stat.size <= MAX_DIRTY_FILE_BYTES) {
        hash.update(fs.readFileSync(abs));
        dirtyFiles += 1;
      } else if (stat.isFile()) {
        hash.update(`${rel}:${stat.size}:${stat.mtimeMs}`);
        dirtyFiles += 1;
      }
    } catch {
      // File vanished between status and read — the porcelain line already
      // contributed to the hash, which is enough to register the change.
    }
  }

  return {
    hash: hash.digest('hex'),
    method: 'git',
    detail: { head, dirty: countPorcelain(porcelain), dirtyFilesDigested: dirtyFiles },
  };
}

/** filesystem-scan signature for non-git workspaces. */
function fileScanSignature(dir) {
  const hash = crypto.createHash('sha256');
  let files = 0;

  const walk = (current) => {
    if (files >= MAX_FILES_SCANNED) return;
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    );
    for (const entry of entries) {
      if (files >= MAX_FILES_SCANNED) return;
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        walk(path.join(current, entry.name));
      } else if (entry.isFile()) {
        const abs = path.join(current, entry.name);
        try {
          const stat = fs.statSync(abs);
          hash.update(`${path.relative(dir, abs)}:${stat.size}:${stat.mtimeMs}\n`);
          files += 1;
        } catch {
          // Racing deletion — skip.
        }
      }
    }
  };

  walk(dir);
  return { hash: hash.digest('hex'), method: 'filescan', detail: { files } };
}

/** Count non-empty porcelain lines (number of changed paths). */
function countPorcelain(porcelain) {
  return porcelain.split('\n').filter((l) => l.trim()).length;
}

export default { computeWorkspaceSignature };
