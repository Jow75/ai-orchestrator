/**
 * Unit tests for operator/logVisibility.js (Phase 14 M2) — a read-only tail
 * of the real orchestrator log file for the `/log` command. Runs against a
 * real throwaway directory with real winston-shaped JSON lines, the same way
 * gitVisibility.test.js exercises real git rather than mocking it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { latestLogFile, readLogTail, DEFAULT_LOG_LINES } from '../src/operator/logVisibility.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aio-logvis-'));
}

function writeLine(dir, file, record) {
  fs.appendFileSync(path.join(dir, file), `${JSON.stringify(record)}\n`);
}

test('an empty directory has no log file, and readLogTail() returns null', () => {
  const dir = tmpDir();
  assert.equal(latestLogFile(dir), null);
  assert.equal(readLogTail(dir, 'alpha'), null);
});

test('a directory that does not exist at all behaves the same as empty', () => {
  const dir = path.join(tmpDir(), 'never-created');
  assert.equal(latestLogFile(dir), null);
  assert.equal(readLogTail(dir, 'alpha'), null);
});

test('latestLogFile() picks the most recently modified orchestrator-*.log file, ignoring error-*.log', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'orchestrator-2026-07-29.log'), '');
  fs.writeFileSync(path.join(dir, 'error-2026-07-30.log'), '');
  // Give the second orchestrator file a strictly later mtime.
  const older = path.join(dir, 'orchestrator-2026-07-29.log');
  const newer = path.join(dir, 'orchestrator-2026-07-30.log');
  fs.writeFileSync(newer, '');
  const now = Date.now();
  fs.utimesSync(older, new Date(now - 60_000), new Date(now - 60_000));
  fs.utimesSync(newer, new Date(now), new Date(now));

  assert.equal(latestLogFile(dir), newer);
});

test('lines are returned newest first, filtered to the given project', () => {
  const dir = tmpDir();
  const file = 'orchestrator-2026-07-30.log';
  writeLine(dir, file, { timestamp: '2026-07-30T10:00:00.000Z', level: 'info', module: 'orchestrator', project: 'alpha', message: 'alpha line 1' });
  writeLine(dir, file, { timestamp: '2026-07-30T10:00:01.000Z', level: 'info', module: 'daemon', message: 'daemon startup, no project' });
  writeLine(dir, file, { timestamp: '2026-07-30T10:00:02.000Z', level: 'warn', module: 'orchestrator', project: 'beta', message: 'beta line 1' });
  writeLine(dir, file, { timestamp: '2026-07-30T10:00:03.000Z', level: 'error', module: 'orchestrator', project: 'alpha', message: 'alpha line 2' });

  const tail = readLogTail(dir, 'alpha');
  assert.equal(tail.file, file);
  assert.equal(tail.total, 2);
  assert.deepEqual(tail.lines.map((l) => l.message), ['alpha line 2', 'alpha line 1']);
});

test('project matching is case-insensitive against the stored project field', () => {
  const dir = tmpDir();
  const file = 'orchestrator-2026-07-30.log';
  writeLine(dir, file, { timestamp: '2026-07-30T10:00:00.000Z', level: 'info', project: 'Remote Work', message: 'hello' });

  const tail = readLogTail(dir, 'remote work');
  assert.equal(tail.total, 1);
  assert.equal(tail.lines[0].message, 'hello');
});

test('with no project given, every line in the file is included, tagged or not', () => {
  const dir = tmpDir();
  const file = 'orchestrator-2026-07-30.log';
  writeLine(dir, file, { timestamp: '2026-07-30T10:00:00.000Z', level: 'info', project: 'alpha', message: 'alpha line' });
  writeLine(dir, file, { timestamp: '2026-07-30T10:00:01.000Z', level: 'info', message: 'untagged line' });

  const tail = readLogTail(dir, undefined);
  assert.equal(tail.total, 2);
});

test('a project with no matching lines gets a real, empty result — not null', () => {
  const dir = tmpDir();
  const file = 'orchestrator-2026-07-30.log';
  writeLine(dir, file, { timestamp: '2026-07-30T10:00:00.000Z', level: 'info', project: 'beta', message: 'beta only' });

  const tail = readLogTail(dir, 'alpha');
  assert.equal(tail.total, 0);
  assert.deepEqual(tail.lines, []);
});

test('malformed lines are skipped rather than throwing', () => {
  const dir = tmpDir();
  const file = 'orchestrator-2026-07-30.log';
  fs.appendFileSync(path.join(dir, file), 'not json at all\n');
  writeLine(dir, file, { timestamp: '2026-07-30T10:00:00.000Z', level: 'info', project: 'alpha', message: 'real line' });

  const tail = readLogTail(dir, 'alpha');
  assert.equal(tail.total, 1);
  assert.equal(tail.lines[0].message, 'real line');
});

test('pagination: page 1 is the newest DEFAULT_LOG_LINES lines, page 2 the next batch', () => {
  const dir = tmpDir();
  const file = 'orchestrator-2026-07-30.log';
  const count = DEFAULT_LOG_LINES + 5;
  for (let i = 1; i <= count; i += 1) {
    writeLine(dir, file, {
      timestamp: `2026-07-30T10:00:${String(i).padStart(2, '0')}.000Z`,
      level: 'info',
      project: 'alpha',
      message: `line ${i}`,
    });
  }

  const page1 = readLogTail(dir, 'alpha', { page: 1 });
  assert.equal(page1.total, count);
  assert.equal(page1.pageCount, 2);
  assert.equal(page1.lines.length, DEFAULT_LOG_LINES);
  assert.equal(page1.lines[0].message, `line ${count}`, 'newest line leads page 1');

  const page2 = readLogTail(dir, 'alpha', { page: 2 });
  assert.equal(page2.lines.length, 5);
  assert.equal(page2.lines[0].message, `line ${count - DEFAULT_LOG_LINES}`);
});

test('a page number past the end clamps to the last real page', () => {
  const dir = tmpDir();
  const file = 'orchestrator-2026-07-30.log';
  writeLine(dir, file, { timestamp: '2026-07-30T10:00:00.000Z', level: 'info', project: 'alpha', message: 'only line' });

  const tail = readLogTail(dir, 'alpha', { page: 99 });
  assert.equal(tail.page, 1);
  assert.equal(tail.pageCount, 1);
  assert.equal(tail.lines.length, 1);
});
