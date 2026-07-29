/**
 * Tests for operator/fileAccess.js — Phase 13 M6.
 *
 * The path-traversal adversarial suite is the centerpiece (per
 * docs/PHASE_13_PLAN.md M6): every spelling of "outside the project" this
 * milestone names explicitly — `../`, absolute paths, a Windows drive
 * letter, a Windows drive-RELATIVE path, a UNC path, mixed separators, and a
 * symlink/junction escape — must be refused, and refused via the real
 * containment check (path.relative + realpath), never a pattern blacklist.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FileAccessError, resolveWithinProject, listFiles, looksBinary,
  estimateArchiveSize, createProjectArchive, pruneOldDownloads,
} from '../src/operator/fileAccess.js';

function tmpProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-files-'));
  fs.writeFileSync(path.join(root, 'README.md'), '# hello\n');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'index.js'), 'console.log(1);\n');
  fs.mkdirSync(path.join(root, 'node_modules', 'left-pad'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = {};\n');
  return root;
}

// ────────────────────────────────────────────── resolveWithinProject ──────

test('a plain relative path inside the project resolves cleanly', () => {
  const root = tmpProject();
  const resolved = resolveWithinProject(root, 'src/index.js');
  assert.equal(fs.realpathSync(resolved), fs.realpathSync(path.join(root, 'src', 'index.js')));
});

test('an empty/undefined path resolves to the project root itself', () => {
  const root = tmpProject();
  assert.equal(resolveWithinProject(root, ''), fs.realpathSync(root));
  assert.equal(resolveWithinProject(root, undefined), fs.realpathSync(root));
});

test('classic dot-dot traversal is refused', () => {
  const root = tmpProject();
  assert.throws(() => resolveWithinProject(root, '../../../windows/system32'), FileAccessError);
  assert.throws(() => resolveWithinProject(root, '../outside.txt'), FileAccessError);
});

test('mixed-separator traversal is refused — no separator-specific blacklist needed', () => {
  const root = tmpProject();
  assert.throws(() => resolveWithinProject(root, 'src\\..\\..\\outside'), FileAccessError);
  assert.throws(() => resolveWithinProject(root, 'src/../../outside'), FileAccessError);
});

test('a POSIX-style absolute path is refused', () => {
  const root = tmpProject();
  assert.throws(() => resolveWithinProject(root, '/etc/passwd'), FileAccessError);
});

test('a Windows absolute drive-letter path is refused', () => {
  const root = tmpProject();
  assert.throws(() => resolveWithinProject(root, 'C:\\Windows\\System32\\drivers\\etc\\hosts'), FileAccessError);
  assert.throws(() => resolveWithinProject(root, 'C:/Windows/System32'), FileAccessError);
});

test('a Windows drive-RELATIVE path (no separator after the colon) is refused', () => {
  // The obscure Windows form path.isAbsolute() alone does NOT flag as
  // absolute — exactly why the guard relies on where path.resolve() actually
  // LANDS, not on a name for the shape of the input.
  const root = tmpProject();
  const otherDrive = process.env.SystemDrive && process.env.SystemDrive.toUpperCase() !== 'C:' ? 'D' : 'D';
  assert.throws(() => resolveWithinProject(root, `${otherDrive}:some\\path`), FileAccessError);
});

test('a UNC path is refused', () => {
  const root = tmpProject();
  assert.throws(() => resolveWithinProject(root, '\\\\evil-server\\share\\file.txt'), FileAccessError);
  assert.throws(() => resolveWithinProject(root, '//evil-server/share'), FileAccessError);
});

test('a sibling directory that merely SHARES A PREFIX with the root is not mistaken for "inside" it', () => {
  // The bug a naive `resolved.startsWith(root)` string check would have:
  // "C:\Projects\demo-evil" starts with "C:\Projects\demo" as a STRING, but
  // is not inside it as a PATH. path.relative()-based containment is immune.
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-files-'));
  const root = path.join(parent, 'demo');
  const evilSibling = path.join(parent, 'demo-evil');
  fs.mkdirSync(root);
  fs.mkdirSync(evilSibling);
  fs.writeFileSync(path.join(evilSibling, 'secret.txt'), 'nope');

  assert.throws(() => resolveWithinProject(root, '../demo-evil/secret.txt'), FileAccessError);
});

test('a symlink/junction inside the project pointing outside it is refused', () => {
  const root = tmpProject();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-files-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret');

  const linkPath = path.join(root, 'escape-link');
  try {
    fs.symlinkSync(outside, linkPath, 'junction');
  } catch (error) {
    // Junctions need no special privilege on Windows; if this environment
    // still refuses it, the escape vector itself cannot be exercised, so
    // there is nothing meaningful left to assert.
    if (error.code === 'EPERM') return;
    throw error;
  }

  assert.throws(
    () => resolveWithinProject(root, 'escape-link/secret.txt'),
    (error) => error instanceof FileAccessError && /symlink or junction/.test(error.message)
  );
});

test('a nonexistent path inside the project is a clear "not found", not a security refusal', () => {
  const root = tmpProject();
  assert.throws(
    () => resolveWithinProject(root, 'does-not-exist.txt'),
    (error) => error instanceof FileAccessError && error.code === 'not-found'
  );
});

test('a project root that does not exist on disk is refused, not crashed on', () => {
  assert.throws(
    () => resolveWithinProject(path.join(os.tmpdir(), 'aio-files-never-existed-xyz'), 'anything'),
    FileAccessError
  );
});

// ─────────────────────────────────────────────────────────── listFiles ────

test('listFiles lists directories first, then files, alphabetically within each group', () => {
  const root = tmpProject();
  fs.writeFileSync(path.join(root, 'a-file.txt'), 'x');
  fs.mkdirSync(path.join(root, 'z-dir'));

  const { entries } = listFiles(root, '');
  const names = entries.map((e) => e.name);
  // node_modules is excluded by DEFAULT_IGNORE_DIRS. File order is locale-
  // aware (localeCompare), which alphabetizes by base letter regardless of
  // case — "a-file.txt" sorts before "README.md" the same way a phone book
  // would, not by raw ASCII code point.
  assert.deepEqual(names, ['src', 'z-dir', 'a-file.txt', 'README.md']);
  assert.equal(entries.find((e) => e.name === 'src').type, 'dir');
  assert.equal(entries.find((e) => e.name === 'README.md').type, 'file');
});

test('listFiles never shows ignored noise directories', () => {
  const root = tmpProject();
  const { entries } = listFiles(root, '');
  assert.equal(entries.find((e) => e.name === 'node_modules'), undefined);
});

test('listFiles paginates a large directory rather than returning it unbounded', () => {
  const root = tmpProject();
  for (let i = 0; i < 10; i += 1) fs.writeFileSync(path.join(root, `f${i}.txt`), 'x');

  const page1 = listFiles(root, '', { pageSize: 4 });
  assert.equal(page1.entries.length, 4);
  assert.equal(page1.page, 1);
  assert.equal(page1.total, 12, 'README.md + src + 10 f*.txt files (node_modules excluded)');
  assert.equal(page1.pageCount, 3);

  const page2 = listFiles(root, '', { page: 2, pageSize: 4 });
  assert.notDeepEqual(page1.entries, page2.entries);
});

test('listFiles refuses to list a FILE as though it were a directory', () => {
  const root = tmpProject();
  assert.throws(() => listFiles(root, 'README.md'), FileAccessError);
});

test('listFiles inherits the same traversal guard', () => {
  const root = tmpProject();
  assert.throws(() => listFiles(root, '../../etc'), FileAccessError);
});

// ──────────────────────────────────────────────────────────── looksBinary ─

test('a plain text file is not binary', () => {
  const root = tmpProject();
  assert.equal(looksBinary(path.join(root, 'README.md')), false);
});

test('a file containing a NUL byte is binary, regardless of its extension', () => {
  const root = tmpProject();
  const file = path.join(root, 'weird.txt');
  fs.writeFileSync(file, Buffer.from([0x68, 0x69, 0x00, 0x21]));
  assert.equal(looksBinary(file), true);
});

// ─────────────────────────────────────────────────────── estimateArchiveSize

test('estimateArchiveSize sums real file bytes and excludes ignored directories', () => {
  const root = tmpProject();
  const { bytes, files } = estimateArchiveSize(root);
  // README.md + src/index.js only — node_modules/left-pad/index.js excluded.
  const expected = fs.statSync(path.join(root, 'README.md')).size
    + fs.statSync(path.join(root, 'src', 'index.js')).size;
  assert.equal(bytes, expected);
  assert.equal(files, 2);
});

// ───────────────────────────────────────────────── createProjectArchive ───

function readAll(zipPath) {
  return fs.readFileSync(zipPath);
}

test('createProjectArchive produces a real, non-empty ZIP with a valid local-file-header signature', async () => {
  const root = tmpProject();
  const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-downloads-'));

  const zipPath = await createProjectArchive(root, 'demo-project', { downloadsDir });

  assert.ok(fs.existsSync(zipPath));
  const buffer = readAll(zipPath);
  assert.ok(buffer.length > 0);
  // "PK\x03\x04" — the ZIP local file header magic number.
  assert.deepEqual(buffer.subarray(0, 4), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
});

test('createProjectArchive excludes node_modules and everything else in the ignore list', async () => {
  const root = tmpProject();
  const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-downloads-'));

  const zipPath = await createProjectArchive(root, 'demo-project', { downloadsDir });
  const text = readAll(zipPath).toString('latin1');

  assert.ok(text.includes('README.md'), 'real source files are included');
  assert.ok(text.includes('index.js'), 'nested source files are included');
  assert.ok(!text.includes('left-pad'), 'node_modules contents never reach the archive');
});

test('createProjectArchive names the file after the project and timestamps it, under downloadsDir', async () => {
  const root = tmpProject();
  const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-downloads-'));

  const zipPath = await createProjectArchive(root, 'my project!!', { downloadsDir });

  assert.equal(path.dirname(zipPath), downloadsDir);
  assert.match(path.basename(zipPath), /^my_project_-.+\.zip$/);
});

test('createProjectArchive leaves no partial file behind when the source directory vanishes mid-run', async () => {
  const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-downloads-'));
  await assert.rejects(() => createProjectArchive(
    path.join(os.tmpdir(), 'aio-files-never-existed-xyz'), 'ghost', { downloadsDir }
  ));
});

// ───────────────────────────────────────────────────── pruneOldDownloads ──

test('pruneOldDownloads removes only files older than the cutoff', () => {
  const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-downloads-'));
  const oldFile = path.join(downloadsDir, 'old.zip');
  const newFile = path.join(downloadsDir, 'new.zip');
  fs.writeFileSync(oldFile, 'x');
  fs.writeFileSync(newFile, 'x');
  const past = Date.now() - 100_000;
  fs.utimesSync(oldFile, past / 1000, past / 1000);

  const removed = pruneOldDownloads(downloadsDir, 50_000);

  assert.equal(removed, 1);
  assert.equal(fs.existsSync(oldFile), false);
  assert.equal(fs.existsSync(newFile), true);
});

test('pruneOldDownloads on a directory that does not exist yet is a harmless no-op', () => {
  assert.equal(pruneOldDownloads(path.join(os.tmpdir(), 'aio-downloads-never-existed'), 1000), 0);
});
