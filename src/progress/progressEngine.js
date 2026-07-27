/**
 * progressEngine.js — Phase P1: a first-class progress engine.
 *
 * P0 answered a yes/no question ("did the workspace change?"). P1 promotes
 * that signal into structured, engine-agnostic *progress facts*: which files
 * were created, modified, or deleted, whether a git commit was made, and how
 * much confidence to place in the verdict — all derived independently of the
 * AI engine that produced the work.
 *
 * How it measures: a bounded snapshot of the working directory (each relevant
 * file → `size:mtime`), plus the git HEAD when the directory is a repo. The
 * snapshot is persisted per project (`state/progress/<project>.snapshot.json`,
 * latest only) and diffed against the previous run to produce the change
 * facts. Comparing snapshots — rather than trusting git's ignore rules —
 * closes the P0 gap where work inside a git-ignored directory registered as
 * "no progress" (only genuine noise dirs like node_modules are skipped).
 *
 * The engine still fails closed: if the workspace cannot be read at all, the
 * run is treated as no-progress so problems pause for review, never loop.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeJsonAtomic, readJsonSafe } from '../state/statePersistence.js';
import { assessConfidence } from './progressConfidence.js';

/** Directories that are never meaningful progress (build output, deps, our own state). */
export const DEFAULT_IGNORE_DIRS = [
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage',
  '.next', '.cache', '.venv', 'venv', '__pycache__', 'logs', 'state',
];

/** Bounds so a snapshot can never take unbounded time/memory. */
const MAX_FILES = 20_000;
const MAX_SAMPLE = 25; // cap the created/modified/deleted sample lists
const GIT_TIMEOUT_MS = 15_000;

export class ProgressEngine {
  /**
   * @param {object} options
   * @param {string} options.progressDir - Directory for per-project snapshots.
   * @param {object} options.logger - Module logger.
   * @param {string[]} [options.ignoreDirs] - Directory names to skip.
   */
  constructor({ progressDir, logger, ignoreDirs = DEFAULT_IGNORE_DIRS }) {
    this.progressDir = progressDir;
    this.logger = logger;
    this.ignoreDirs = new Set(ignoreDirs);
  }

  snapshotFile(project) {
    return path.join(this.progressDir, `${project}.snapshot.json`);
  }

  /**
   * Establish the pre-mission baseline: snapshot the workspace and persist it
   * so the first run's changes are measured against the true starting state.
   *
   * @param {object} project - Validated project config.
   * @returns {string|null} The baseline signature hash (null if unmeasurable).
   */
  baseline(project) {
    const snapshot = this.buildSnapshot(project.workingDirectory);
    if (snapshot.hash === null) return null;
    this.saveSnapshot(project.name, snapshot);
    return snapshot.hash;
  }

  /**
   * Analyze the workspace after a run: build a fresh snapshot, diff it against
   * the stored one, persist the new snapshot, and return structured facts.
   *
   * @param {object} project - Validated project config.
   * @returns {{
   *   hash: string|null, method: string,
   *   changes: {created: string[], modified: string[], deleted: string[],
   *             counts: object, committed: boolean}|null,
   *   confidence: {level: string, score: number, signals: string[]}
   * }}
   */
  analyze(project) {
    const previous = this.loadSnapshot(project.name);
    const snapshot = this.buildSnapshot(project.workingDirectory);

    const changes = previous && snapshot.hash !== null
      ? diffSnapshots(previous, snapshot)
      : null;

    if (snapshot.hash !== null) this.saveSnapshot(project.name, snapshot);

    const progressed = snapshot.hash !== null && (!previous || snapshot.hash !== previous.hash);
    const confidence = assessConfidence({
      progressed,
      method: snapshot.method,
      extraSignals: signalsFromChanges(changes),
    });

    return { hash: snapshot.hash, method: snapshot.method, changes, confidence };
  }

  /**
   * Build a snapshot of the working directory.
   * @param {string} dir
   * @returns {{hash: string|null, method: string, head: string|null, files: object}}
   */
  buildSnapshot(dir) {
    if (!dir || !fs.existsSync(dir)) {
      return { hash: null, method: 'none', head: null, files: {} };
    }

    let files;
    try {
      files = this.scanFiles(dir);
    } catch (error) {
      this.logger.warn('Progress snapshot failed', { dir, error: error.message });
      return { hash: null, method: 'none', head: null, files: {} };
    }

    const head = gitHead(dir);
    const hash = crypto.createHash('sha256');
    hash.update(`head:${head ?? 'none'}\n`);
    for (const key of Object.keys(files).sort()) hash.update(`${key}=${files[key]}\n`);

    return {
      hash: hash.digest('hex'),
      method: head ? 'git+scan' : 'scan',
      head,
      files,
    };
  }

  /** Walk the directory into a {relPath: "size:mtime"} map, skipping noise. */
  scanFiles(dir) {
    const files = {};
    let count = 0;

    const walk = (current) => {
      if (count >= MAX_FILES) return;
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        if (count >= MAX_FILES) return;
        if (entry.isDirectory()) {
          if (this.ignoreDirs.has(entry.name)) continue;
          walk(path.join(current, entry.name));
        } else if (entry.isFile()) {
          const abs = path.join(current, entry.name);
          try {
            const stat = fs.statSync(abs);
            files[path.relative(dir, abs).replaceAll('\\', '/')] = `${stat.size}:${Math.round(stat.mtimeMs)}`;
            count += 1;
          } catch {
            // racing deletion — skip
          }
        }
      }
    };

    walk(dir);
    return files;
  }

  loadSnapshot(project) {
    return readJsonSafe(this.snapshotFile(project), { logger: this.logger });
  }

  saveSnapshot(project, snapshot) {
    try {
      writeJsonAtomic(this.snapshotFile(project), snapshot);
    } catch (error) {
      // Snapshot persistence is best-effort; never disrupt supervision.
      this.logger.warn('Failed to persist progress snapshot', {
        project, error: error.message,
      });
    }
  }
}

/**
 * Compute created/modified/deleted between two snapshots.
 *
 * Returns COMPLETE, untruncated file lists — this is the fact-of-record
 * consumed by verification (`files-changed`) as well as display, and a
 * verifier silently missing a file past some display cap would be a real
 * correctness bug, not a cosmetic one. Truncate only at display boundaries
 * (see `sampleChanges()`), never here.
 */
export function diffSnapshots(prev, curr) {
  const prevFiles = prev.files ?? {};
  const currFiles = curr.files ?? {};
  const created = [];
  const modified = [];
  const deleted = [];

  for (const [key, sig] of Object.entries(currFiles)) {
    if (!(key in prevFiles)) created.push(key);
    else if (prevFiles[key] !== sig) modified.push(key);
  }
  for (const key of Object.keys(prevFiles)) {
    if (!(key in currFiles)) deleted.push(key);
  }

  return {
    created,
    modified,
    deleted,
    counts: { created: created.length, modified: modified.length, deleted: deleted.length },
    committed: Boolean(prev.head && curr.head && prev.head !== curr.head),
  };
}

/**
 * Sample a `diffSnapshots()` result down to a bounded number of entries per
 * list, for compact human-facing display (ledger records, diagnostic
 * reports). Never use this for verification — verifiers need the complete
 * lists from `diffSnapshots()`/`analyze()` directly.
 *
 * @param {object} changes - A `diffSnapshots()` result (or null).
 * @param {number} [max] - Max entries kept per list.
 */
export function sampleChanges(changes, max = MAX_SAMPLE) {
  if (!changes) return changes;
  return {
    ...changes,
    created: changes.created.slice(0, max),
    modified: changes.modified.slice(0, max),
    deleted: changes.deleted.slice(0, max),
  };
}

/** Confidence signals derived from the change facts. */
function signalsFromChanges(changes) {
  if (!changes) return [];
  const signals = [];
  if (changes.committed) signals.push('git-commit');
  if (changes.counts.created > 0) signals.push('files-created');
  if (changes.counts.modified > 0) signals.push('files-modified');
  return signals;
}

/**
 * Return the current git HEAD for a directory, or null when not a repo.
 * Exported for reuse by the Phase 11 M2 mission-card builder, which wants
 * the real commit a mission ended on — never invented, never guessed.
 */
export function gitHead(dir) {
  return git(dir, ['rev-parse', 'HEAD']);
}

/**
 * The branch a directory is currently on, or null when it is not a git work
 * tree (or is in a detached HEAD, which reports the literal "HEAD" and is
 * normalized to null here — "detached" is not a branch name, and showing one
 * that doesn't exist on an operator's phone is worse than showing nothing).
 *
 * Phase 12 M2: the project registry reports the real branch and commit of
 * every project, so `/projects` on a phone answers "what am I looking at"
 * without a terminal.
 */
export function gitBranch(dir) {
  const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return branch && branch !== 'HEAD' ? branch : null;
}

/** The subject line of HEAD, or null when unavailable. */
export function gitHeadSubject(dir) {
  return git(dir, ['log', '-1', '--pretty=%s']);
}

/**
 * Whether the work tree has uncommitted changes — null when undeterminable
 * (not a repo, or git unavailable), which is deliberately distinct from
 * `false` ("checked, and it is clean").
 */
export function gitDirty(dir) {
  const output = git(dir, ['status', '--porcelain']);
  return output === null ? null : output.length > 0;
}

/** One bounded, never-throwing git invocation. Null on any failure. */
function git(dir, args) {
  try {
    return execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null; // not a git work tree, no commits yet, or git is not installed
  }
}

export default ProgressEngine;
