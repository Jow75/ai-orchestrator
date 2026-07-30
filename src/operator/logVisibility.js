/**
 * logVisibility.js — Phase 14 M2: read-only tail of the orchestrator's own
 * rotated text log for the operator's `/log` command — timestamp, severity,
 * and message per line, paginated.
 *
 * Distinct from `src/events/eventStore.js` (which `/events` reads): that is
 * a structured, append-only record of discrete things the system decided to
 * announce (`mission.started`, `approval.resolved`, …). This reads the raw
 * file `src/infra/logger.js` actually writes to — one JSON object per line,
 * covering everything any module logged, including lines nothing ever
 * turned into an event. Every daemon and mission-worker process writes to
 * the SAME file (see `src/infra/paths.js`'s `logsDir` — one location for the
 * whole installation), so "for a project" means filtering by the `project`
 * field individual log calls attach to their own lines — not a separate
 * file per project. Lines with no such field (daemon startup, HTTP, …) are
 * the service's own activity, not any one project's, so a project-scoped
 * read correctly excludes them rather than guessing.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Lines shown per page when no explicit count is given. */
export const DEFAULT_LOG_LINES = 20;

/** Upper bound on lines per page, so one message cannot become a wall of text. */
export const MAX_LOG_LINES = 100;

/**
 * The most recently modified `orchestrator-*.log` file in `logsDir`, or null
 * when none exist yet. Picked by mtime rather than assembled from today's
 * date string: a read moments after midnight, before the new day's file has
 * its first line written, still finds yesterday's real file instead of a
 * phantom empty one.
 *
 * @param {string} logsDir
 * @returns {string|null}
 */
export function latestLogFile(logsDir) {
  let names;
  try {
    names = fs.readdirSync(logsDir);
  } catch {
    return null;
  }

  let newest = null;
  for (const name of names) {
    if (!/^orchestrator-.*\.log$/.test(name)) continue; // eslint-disable-line no-continue -- error/rotation-audit files live alongside it
    const full = path.join(logsDir, name);
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(full).mtimeMs;
    } catch {
      continue; // eslint-disable-line no-continue -- vanished between readdir and stat
    }
    if (!newest || mtimeMs > newest.mtimeMs) newest = { full, mtimeMs };
  }
  return newest?.full ?? null;
}

/** Parse one winston JSON log line. Null for a blank or malformed line — never throws. */
function parseLine(line) {
  try {
    const record = JSON.parse(line);
    return {
      timestamp: record.timestamp,
      level: record.level,
      project: record.project,
      message: record.message,
    };
  } catch {
    return null;
  }
}

/**
 * Tail the current orchestrator log file, newest line first, paginated.
 *
 * @param {string} logsDir
 * @param {string} [project] - Only lines whose `project` metadata matches
 *   (case-insensitive, exact). Omitted ⇒ every line in the file, i.e. the
 *   service's own activity rather than any one project's.
 * @param {{page?: number, pageSize?: number}} [options]
 * @returns {{file: string, lines: {timestamp: string, level: string, project?: string,
 *   message: string}[], page: number, pageCount: number, total: number} | null}
 *   Null when no log file exists yet at all.
 */
export function readLogTail(logsDir, project, { page = 1, pageSize = DEFAULT_LOG_LINES } = {}) {
  const file = latestLogFile(logsDir);
  if (!file) return null;

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }

  const needle = project ? String(project).toLowerCase() : null;
  const lines = raw.split('\n').filter(Boolean).map(parseLine).filter(Boolean)
    .filter((entry) => !needle || String(entry.project ?? '').toLowerCase() === needle)
    .reverse();

  const total = lines.length;
  const clampedPageSize = Math.max(1, Math.min(pageSize, MAX_LOG_LINES));
  const pageCount = Math.max(1, Math.ceil(total / clampedPageSize));
  const clampedPage = Math.min(Math.max(1, page), pageCount);
  const start = (clampedPage - 1) * clampedPageSize;

  return {
    file: path.basename(file),
    lines: lines.slice(start, start + clampedPageSize),
    page: clampedPage,
    pageCount,
    total,
  };
}

export default { latestLogFile, readLogTail, DEFAULT_LOG_LINES, MAX_LOG_LINES };
