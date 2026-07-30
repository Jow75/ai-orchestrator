/**
 * gitVisibility.js — Phase 14 M1: read-only git facts for the operator's
 * `/git` command — branch, dirty state, HEAD, recent commit subjects, and
 * (when the branch tracks one) ahead/behind its upstream.
 *
 * Kept separate from `progress/progressEngine.js`'s own `gitBranch`/
 * `gitDirty`/etc.: those exist to feed mission-progress snapshots, not the
 * operator console, and this module needs a few facts (a changed-file count,
 * a batch of recent commits, ahead/behind) that module has no reason to
 * compute. Same never-throwing, bounded-timeout shelling pattern either way.
 */

import { execFileSync } from 'node:child_process';

const GIT_TIMEOUT_MS = 15_000;

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

/** Whether `dir` is inside a real git work tree. */
export function isGitRepo(dir) {
  return git(dir, ['rev-parse', '--is-inside-work-tree']) === 'true';
}

/**
 * The branch HEAD is on, or null for detached HEAD. Uses `symbolic-ref`
 * rather than `rev-parse --abbrev-ref HEAD`: the latter fails on a fresh
 * repo with no commits yet (an "unborn" branch has no resolvable revision),
 * which would misreport a brand-new repo as branchless. `symbolic-ref`
 * resolves the ref itself, not a commit, and fails cleanly on detached HEAD
 * (not a symbolic ref at all) — exactly the case that should read as null.
 */
function currentBranch(dir) {
  return git(dir, ['symbolic-ref', '--short', 'HEAD']);
}

/**
 * Uncommitted-change facts: whether the tree is dirty, and how many files
 * changed (staged + unstaged + untracked — one line per file in porcelain
 * output). Null when not a repo.
 */
function workingTreeStatus(dir) {
  const output = git(dir, ['status', '--porcelain']);
  if (output === null) return null;
  const changedCount = output.length ? output.split('\n').length : 0;
  return { dirty: changedCount > 0, changedCount };
}

/** Short hash + subject of HEAD, or null when there is no commit yet. */
function headInfo(dir) {
  const hash = git(dir, ['rev-parse', '--short', 'HEAD']);
  if (!hash) return null;
  return { hash, subject: git(dir, ['log', '-1', '--pretty=%s']) ?? '' };
}

/** Up to `count` most recent commits, newest first, as `{hash, subject}`. Empty when none. */
function recentCommits(dir, count) {
  const output = git(dir, ['log', `-${count}`, '--pretty=%h\t%s']);
  if (!output) return [];
  return output.split('\n').filter(Boolean).map((line) => {
    const [hash, ...rest] = line.split('\t');
    return { hash, subject: rest.join('\t') };
  });
}

/**
 * Commits ahead/behind the branch's own upstream, or null when it has none
 * configured — very common for local-only work — reported as "not tracked"
 * by the caller rather than a fabricated 0/0.
 */
function aheadBehind(dir) {
  const output = git(dir, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
  if (output === null) return null;
  const [behind, ahead] = output.split(/\s+/).map(Number);
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return null;
  return { ahead, behind };
}

/**
 * Everything `/git [project]` shows, one shell-out batch. Null when `dir` is
 * not a real git work tree at all — distinct from the individual fields
 * being null for a more specific reason (no commits yet, no upstream).
 *
 * @param {string} dir - A project's real working directory.
 * @param {{commitCount?: number}} [options]
 */
export function gitReport(dir, { commitCount = 8 } = {}) {
  if (!isGitRepo(dir)) return null;
  return {
    branch: currentBranch(dir),
    head: headInfo(dir),
    status: workingTreeStatus(dir),
    recentCommits: recentCommits(dir, commitCount),
    aheadBehind: aheadBehind(dir),
  };
}

export default { isGitRepo, gitReport };
