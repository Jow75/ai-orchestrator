/**
 * repoSearch.js — Phase 14 M3: `/grep <pattern>` and `/symbol <name>`.
 *
 * A text-search primitive over the active project's real files, built on the
 * exact same containment guard `/files`/`/file` already use
 * (`resolveWithinProject()` in fileAccess.js) — no new traversal surface.
 * `/symbol` is `/grep` with a language-aware-ish pattern (function/class/
 * const declaration shapes) layered on top of the same walker, NOT a real
 * AST/ctags index — deliberately scoped as "good enough to find a
 * definition fast," since a persisted symbol index would be exactly the kind
 * of new architecture Phase 14 is meant to avoid (see docs/PHASE_14_PLAN.md
 * M3).
 *
 * The plan's own risk note calls this "the highest-blast-radius new surface
 * this phase adds" and asks for the same adversarial discipline M6's
 * path-traversal suite established, applied here to an unbounded scan
 * instead: `MAX_FILES_SCANNED` and `MAX_MATCHES` are hard stops so a huge
 * project or a broad pattern degrades to an honestly-reported truncation,
 * never an unbounded walk or a silently incomplete result.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_IGNORE_DIRS, looksBinary, resolveWithinProject } from './fileAccess.js';

/** Match rows per page of `/grep`/`/symbol` output. */
export const DEFAULT_SEARCH_PAGE_SIZE = 20;

/** Hard stop on total matches collected — protects against a pattern (e.g. "e") that matches almost every line of a large project. */
export const MAX_MATCHES = 500;

/** Hard stop on files walked — protects against a huge project even when the pattern matches nothing. */
export const MAX_FILES_SCANNED = 20_000;

/** Files larger than this are skipped entirely, never read into memory. */
export const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024; // 2 MB

/** How many characters of a matching line are kept — a minified/generated one-liner must not blow up the reply. */
const MAX_LINE_CHARS = 300;

/** Escape every regex metacharacter so a literal pattern search never becomes an accidental regex. */
export function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a search `RegExp` from owner input. A string that parses as a valid
 * regex is used as one (case-insensitive); anything that fails to compile
 * (an unbalanced group, say) falls back to a literal substring match instead
 * of refusing outright — a typo in regex syntax should still find text, not
 * produce a confusing parser error to someone who just meant plain words.
 *
 * @param {string} pattern
 * @returns {RegExp}
 */
export function buildGrepPattern(pattern) {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return new RegExp(escapeRegExp(pattern), 'i');
  }
}

/**
 * Declaration shapes common enough across mainstream languages to be "good
 * enough to find a definition fast" without parsing anything: JS/TS
 * function/class/const/let/var/interface/type, Python def/class, Rust/Go
 * fn/func, plus a generic `name(...) {`/`name(...):` method-shorthand line —
 * each optionally preceded by `export`/`default`/`async`. NOT a real parser:
 * a symbol assigned across multiple lines, or declared inside an unusual
 * construct, may simply not match. That is the accepted tradeoff for staying
 * a regex layered on `/grep` instead of a persisted index.
 *
 * Deliberately case-SENSITIVE, unlike `buildGrepPattern()` — a symbol name
 * is an identifier, and `Foo`/`foo` are different symbols in every language
 * this pattern set targets.
 *
 * @param {string} name
 * @returns {RegExp}
 */
export function buildSymbolPattern(name) {
  const escaped = escapeRegExp(name);
  const prefix = '^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?';
  const shapes = [
    `function\\*?\\s+${escaped}\\b`,
    `class\\s+${escaped}\\b`,
    `(?:const|let|var)\\s+${escaped}\\b`,
    `def\\s+${escaped}\\b`,
    `(?:interface|type|struct|enum)\\s+${escaped}\\b`,
    `fn\\s+${escaped}\\b`,
    `func\\s+${escaped}\\b`,
    `${escaped}\\s*\\([^)]*\\)\\s*[{:]`,
  ];
  return new RegExp(`${prefix}(?:${shapes.join('|')})`);
}

/**
 * Walk a project's real files (excluding `fileAccess.js`'s standard noise
 * directories), testing every text line against `regex`. Directories-first
 * traversal isn't needed here (unlike `listFiles()`'s Explorer-style
 * listing) since results are ranked by match order, not display order.
 *
 * @param {string} projectRoot
 * @param {RegExp} regex
 * @param {{page?: number, pageSize?: number, ignore?: string[], maxMatches?: number,
 *   maxFilesScanned?: number}} [options] `maxMatches`/`maxFilesScanned` default to
 *   this module's own constants — overridable only so tests can exercise the
 *   truncation behaviour without creating thousands of real files.
 * @returns {{matches: {file: string, line: number, text: string}[], page: number,
 *   pageCount: number, total: number, filesScanned: number, truncated: boolean}}
 * @throws {import('./fileAccess.js').FileAccessError}
 */
export function searchFiles(projectRoot, regex, {
  page = 1, pageSize = DEFAULT_SEARCH_PAGE_SIZE, ignore = DEFAULT_IGNORE_DIRS,
  maxMatches = MAX_MATCHES, maxFilesScanned = MAX_FILES_SCANNED,
} = {}) {
  const root = resolveWithinProject(projectRoot, '');
  const matches = [];
  let filesScanned = 0;
  let truncated = false;

  const stack = [root];
  walk: while (stack.length) { // eslint-disable-line no-labels -- the clearest way to break two loops on a hard cap
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // eslint-disable-line no-continue -- an unreadable subfolder contributes nothing
    }

    for (const entry of entries) {
      if (ignore.includes(entry.name)) continue; // eslint-disable-line no-continue
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue; // eslint-disable-line no-continue
      }
      if (!entry.isFile()) continue; // eslint-disable-line no-continue

      filesScanned += 1;
      if (filesScanned > maxFilesScanned) {
        truncated = true;
        break walk; // eslint-disable-line no-labels
      }

      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue; // eslint-disable-line no-continue -- vanished between readdir and stat
      }
      if (stat.size === 0 || stat.size > MAX_SEARCH_FILE_BYTES) continue; // eslint-disable-line no-continue

      let binary;
      try {
        binary = looksBinary(full);
      } catch {
        continue; // eslint-disable-line no-continue -- unreadable is not a match
      }
      if (binary) continue; // eslint-disable-line no-continue

      let content;
      try {
        content = fs.readFileSync(full, 'utf8');
      } catch {
        continue; // eslint-disable-line no-continue
      }

      const relative = path.relative(root, full).replace(/\\/g, '/');
      const lines = content.split(/\r\n|\r|\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (!regex.test(lines[i])) continue; // eslint-disable-line no-continue
        const text = lines[i].trim();
        matches.push({
          file: relative,
          line: i + 1,
          text: text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text,
        });
        if (matches.length >= maxMatches) {
          truncated = true;
          break walk; // eslint-disable-line no-labels
        }
      }
    }
  }

  const total = matches.length;
  const clampedPageSize = Math.max(1, pageSize);
  const pageCount = Math.max(1, Math.ceil(total / clampedPageSize));
  const clampedPage = Math.min(Math.max(1, page), pageCount);
  const start = (clampedPage - 1) * clampedPageSize;

  return {
    matches: matches.slice(start, start + clampedPageSize),
    page: clampedPage,
    pageCount,
    total,
    filesScanned,
    truncated,
  };
}

export default {
  DEFAULT_SEARCH_PAGE_SIZE, MAX_MATCHES, MAX_FILES_SCANNED, MAX_SEARCH_FILE_BYTES,
  escapeRegExp, buildGrepPattern, buildSymbolPattern, searchFiles,
};
