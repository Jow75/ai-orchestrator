/**
 * fileAccess.js — Phase 13 M6: the filesystem is never a raw filesystem.
 *
 * Every operation here resolves Project → Registry entry → Project root →
 * Canonical path before touching disk, and REFUSES anything that would land
 * outside that root. This is the highest-blast-radius new surface in Phase
 * 13, so the guard is centralized here — there is exactly ONE path-traversal
 * check in the codebase, and every command reuses it, rather than each
 * command growing its own slightly-different copy.
 *
 * The one precedent this deliberately does NOT copy: `validateSingleTask()`
 * (`src/mission/missionPlan.js`) resolves a task's `prompt` path with
 * `path.join(workingDirectory, entry.prompt)` and only checks the result
 * EXISTS — never that it stays inside the project. That was safe there only
 * because task prompts come from the project's OWN config file, edited by
 * the person who owns the machine. A path typed into Telegram has no such
 * guarantee, so this module holds a strictly stronger invariant.
 *
 * `resolveWithinProject()` is a two-layer check:
 *
 *  1. TEXTUAL containment — `path.resolve()` the candidate against the
 *     project root, then `path.relative(root, resolved)`. This alone catches
 *     every spelling of "outside the project" Node's own path algebra can
 *     express: `../../etc/passwd`, an absolute POSIX path, a Windows drive
 *     letter (`C:\Windows`), a Windows *drive-relative* path (`C:foo` — the
 *     obscure form with no separator after the colon, which `path.isAbsolute`
 *     alone does NOT flag as absolute), a UNC path (`\\server\share`), and
 *     any mix of `/`/`\` separators — because `path.resolve()` normalizes all
 *     of them before comparison, there is no pattern to blacklist, only a
 *     destination to check.
 *  2. REAL-PATH containment — `fs.realpathSync()` on both the project root
 *     and the resolved target, then the same relative check again. This is
 *     what the textual layer structurally cannot see: a symlink or NTFS
 *     junction that LIVES inside the project but whose target does not.
 *
 * Every refusal says why, in plain language, and none of them attempt to
 * "fix" the input back onto a valid path — an invalid path is refused, never
 * silently reinterpreted.
 */

import fs from 'node:fs';
import path from 'node:path';
// archiver@8 is a pure-ESM rewrite with no default export — it publishes
// named classes (ZipArchive/TarArchive/JsonArchive) instead of the classic
// archiver(format, options) factory function older docs/tutorials describe.
import { ZipArchive } from 'archiver';

/** Directories never shown in a listing, and never included in a download. */
export const DEFAULT_IGNORE_DIRS = Object.freeze([
  'node_modules', '.git', 'dist', 'build', '.next', '.venv', '__pycache__',
  'logs', 'tmp', 'temp', '.cache', 'coverage',
]);

/** How many entries one directory listing returns before pagination kicks in. */
export const DEFAULT_PAGE_SIZE = 30;

/** How many bytes of a file are sniffed for a NUL byte to detect "binary". */
export const SNIFF_BYTES = 8_000;

/** A file access request was refused, or the target does not exist. */
export class FileAccessError extends Error {
  constructor(message, { code = 'refused' } = {}) {
    super(message);
    this.name = 'FileAccessError';
    /** 'refused' (escapes the project / not a real project) | 'not-found'. */
    this.code = code;
    this.userFacing = true;
  }
}

/** True when `resolved` is NOT inside `root` (both already absolute). */
function escapesRoot(root, resolved) {
  const relative = path.relative(root, resolved);
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

/**
 * The one fact "this project's folder isn't on disk" reduces to, shared by
 * every caller that needs to say it — this module's own throws below, plus
 * `/git` and `/mission` elsewhere, which used to each word it slightly
 * differently. Callers prepend their own lead-in ("This project's ", a
 * project name, or nothing) since the right subject depends on context.
 *
 * @param {string} [dir]
 * @returns {string}
 */
export function missingFolderDetail(dir) {
  return `folder does not exist on disk: ${dir || 'not set'}`;
}

/**
 * Shared page math — clamp `pageSize`, compute how many pages `total` items
 * make, clamp the requested `page` into range, and return the slice bounds.
 * The identical "clamp → slice" arithmetic every paginated command
 * (`/files`, `/log`, `/grep`/`/symbol`) needs, done once instead of once per
 * module.
 *
 * @param {number} total
 * @param {{page?: number, pageSize?: number, maxPageSize?: number}} [options]
 *   `maxPageSize` additionally caps `pageSize` itself (used by `/log`, so one
 *   page can never become a wall of text regardless of what was requested).
 * @returns {{page: number, pageCount: number, pageSize: number, start: number, end: number}}
 */
export function paginate(total, { page = 1, pageSize = DEFAULT_PAGE_SIZE, maxPageSize } = {}) {
  const clampedPageSize = Math.max(1, maxPageSize ? Math.min(pageSize, maxPageSize) : pageSize);
  const pageCount = Math.max(1, Math.ceil(total / clampedPageSize));
  const clampedPage = Math.min(Math.max(1, page), pageCount);
  const start = (clampedPage - 1) * clampedPageSize;
  return {
    page: clampedPage, pageCount, pageSize: clampedPageSize, start, end: start + clampedPageSize,
  };
}

/**
 * Resolve `relativePath` against a project's real, on-disk root, refusing
 * anything that would land outside it. See the module docstring for the
 * two-layer algorithm.
 *
 * @param {string} projectRoot - The project's configured `workingDirectory`.
 * @param {string} relativePath - Owner-supplied, untrusted. '' / undefined
 *   means "the project root itself".
 * @returns {string} The real, absolute path — guaranteed inside projectRoot.
 * @throws {FileAccessError}
 */
export function resolveWithinProject(projectRoot, relativePath) {
  let realRoot;
  try {
    realRoot = fs.realpathSync(projectRoot);
  } catch {
    throw new FileAccessError(`This project's ${missingFolderDetail(projectRoot)}`);
  }

  const raw = String(relativePath ?? '').trim();
  const resolved = path.resolve(realRoot, raw);

  // Layer 1: textual containment (see module docstring). Runs before any
  // further filesystem access, so a deliberately out-of-bounds guess never
  // even reaches a stat() call.
  if (escapesRoot(realRoot, resolved)) {
    throw new FileAccessError(`"${raw || '.'}" resolves outside the project. Refused.`);
  }

  // Layer 2: real-path containment — the symlink/junction case layer 1
  // cannot see, because it never touches the filesystem.
  let realTarget;
  try {
    realTarget = fs.realpathSync(resolved);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new FileAccessError(`"${raw || '.'}" does not exist in this project.`, { code: 'not-found' });
    }
    throw new FileAccessError(`Could not resolve "${raw}": ${error.message}`);
  }
  if (escapesRoot(realRoot, realTarget)) {
    throw new FileAccessError(`"${raw || '.'}" points outside the project (via a symlink or junction). Refused.`);
  }
  return realTarget;
}

/**
 * One directory level of a project — Explorer-style, never a recursive
 * full-tree walk (a project with a deep tree must not turn one command into
 * an unbounded scan). Directories first, then alphabetical within each
 * group; paginated so a huge directory returns a bounded page rather than
 * either an unbounded list or a silent truncation.
 *
 * @param {string} projectRoot
 * @param {string} subPath - Relative to the project root; '' = the root.
 * @param {{page?: number, pageSize?: number, ignore?: string[]}} [options]
 * @returns {{path: string, entries: {name: string, type: 'dir'|'file', size?: number}[],
 *   page: number, pageCount: number, total: number}}
 * @throws {FileAccessError}
 */
export function listFiles(projectRoot, subPath, {
  page = 1, pageSize = DEFAULT_PAGE_SIZE, ignore = DEFAULT_IGNORE_DIRS,
} = {}) {
  const target = resolveWithinProject(projectRoot, subPath);
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) {
    throw new FileAccessError(`"${subPath || '.'}" is a file, not a directory. Use /file to read it.`);
  }

  let entries;
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch (error) {
    throw new FileAccessError(`Could not list "${subPath || '.'}": ${error.message}`);
  }

  const rows = entries
    .filter((entry) => !ignore.includes(entry.name))
    .map((entry) => {
      const isDir = entry.isDirectory();
      let size;
      if (!isDir) {
        try {
          size = fs.statSync(path.join(target, entry.name)).size;
        } catch {
          size = undefined;
        }
      }
      return { name: entry.name, type: isDir ? 'dir' : 'file', size };
    })
    .sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name)));

  const total = rows.length;
  const paged = paginate(total, { page, pageSize });

  return {
    path: subPath ? String(subPath).trim().replace(/\\/g, '/') : '.',
    entries: rows.slice(paged.start, paged.end),
    page: paged.page,
    pageCount: paged.pageCount,
    total,
  };
}

/**
 * Extension-agnostic binary detection: a NUL byte anywhere in the first
 * `SNIFF_BYTES` means "not text" — the same heuristic `git` and most editors
 * use, and one that needs no file-extension allowlist to stay correct for a
 * project written in a language this codebase has never heard of.
 *
 * @param {string} filePath - Must already be a resolved, real path.
 * @returns {boolean}
 */
export function looksBinary(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const bytesRead = fs.readSync(fd, buffer, 0, SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Sum the size of everything that WOULD be archived — i.e. respecting the
 * same exclusion list `createProjectArchive()` uses. Checking the post-
 * exclusion size (not the raw directory size) is deliberate: a project with
 * a small source tree and a huge `node_modules` must not be refused for a
 * size that will never actually be zipped.
 *
 * @param {string} projectRoot
 * @param {{ignore?: string[]}} [options]
 * @returns {{bytes: number, files: number}}
 */
export function estimateArchiveSize(projectRoot, { ignore = DEFAULT_IGNORE_DIRS } = {}) {
  if (!fs.existsSync(projectRoot)) {
    throw new FileAccessError(`This project's ${missingFolderDetail(projectRoot)}`);
  }
  let bytes = 0;
  let files = 0;
  const stack = [projectRoot];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // eslint-disable-line no-continue -- an unreadable subfolder just contributes nothing
    }
    for (const entry of entries) {
      if (ignore.includes(entry.name)) continue; // eslint-disable-line no-continue
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          bytes += fs.statSync(full).size;
          files += 1;
        } catch {
          // A file that vanished between readdir and stat contributes nothing.
        }
      }
    }
  }
  return { bytes, files };
}

/**
 * Zip a project's working directory into `downloadsDir`, excluding the same
 * noise `estimateArchiveSize()` already excluded from the size check, so
 * "how big will this be" and "what actually gets zipped" can never disagree.
 * Streams via `archiver` (bounded memory regardless of project size — see
 * docs/PHASE_13_PLAN.md decision D3 for why a dependency was chosen over a
 * hand-rolled zip writer).
 *
 * @param {string} projectRoot
 * @param {string} projectName
 * @param {{downloadsDir: string, ignore?: string[]}} options
 * @returns {Promise<string>} The real path of the created .zip.
 */
export async function createProjectArchive(projectRoot, projectName, { downloadsDir, ignore = DEFAULT_IGNORE_DIRS }) {
  if (!fs.existsSync(projectRoot)) {
    // readdir-glob treats an ENOENT cwd as "zero matches", not an error — left
    // unchecked, this would silently produce a valid, complete-looking, EMPTY
    // zip for a project whose folder has vanished, instead of failing clearly.
    throw new FileAccessError(`This project's ${missingFolderDetail(projectRoot)}`);
  }
  fs.mkdirSync(downloadsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeName = String(projectName).replace(/[^\w.-]+/g, '_') || 'project';
  const zipPath = path.join(downloadsDir, `${safeName}-${stamp}.zip`);

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      archive.destroy();
      reject(error);
    };
    output.on('close', () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    output.on('error', fail);
    archive.on('error', fail);
    archive.pipe(output);
    archive.glob('**/*', {
      cwd: projectRoot,
      dot: false,
      nodir: true,
      // `skip` stops the walk from ever DESCENDING into an excluded
      // directory (readdir-glob's `ignore` only filters entries AFTER
      // walking them — for something the size of a real node_modules, that
      // difference is the whole ballgame). `**/name` matches the name at
      // any depth, including the project root itself.
      skip: ignore.map((name) => `**/${name}`),
    });
    archive.finalize().catch(fail);
  });

  return zipPath;
}

/**
 * Delete generated archives older than `maxAgeMs`. Called on daemon start
 * and after every new zip — a `/download-project` session leaves no trace
 * once its file has aged out, so the machine's disk never quietly fills up
 * with one-off exports nobody came back for.
 *
 * @param {string} downloadsDir
 * @param {number} maxAgeMs
 * @returns {number} How many files were removed.
 */
export function pruneOldDownloads(downloadsDir, maxAgeMs) {
  if (!fs.existsSync(downloadsDir)) return 0;
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const name of fs.readdirSync(downloadsDir)) {
    const full = path.join(downloadsDir, name);
    try {
      const stat = fs.statSync(full);
      if (stat.isFile() && stat.mtimeMs < cutoff) {
        fs.unlinkSync(full);
        removed += 1;
      }
    } catch {
      // A file removed by something else between readdir and stat is fine.
    }
  }
  return removed;
}

export default {
  DEFAULT_IGNORE_DIRS, DEFAULT_PAGE_SIZE, FileAccessError,
  resolveWithinProject, listFiles, looksBinary, estimateArchiveSize,
  createProjectArchive, pruneOldDownloads, missingFolderDetail, paginate,
};
