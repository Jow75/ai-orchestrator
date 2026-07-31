/**
 * Unit tests for operator/repoSearch.js (Phase 14 M3) — the `/grep`/`/symbol`
 * primitive. Runs against real, throwaway directories — no mocking of the
 * filesystem — same discipline `gitVisibility.test.js`/`logVisibility.test.js`
 * already use for their own real-facts modules.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileAccessError } from '../src/operator/fileAccess.js';
import {
  escapeRegExp, buildGrepPattern, buildSymbolPattern, searchFiles,
  ANNOTATION_TAGS, buildTodoPattern, matchedTag,
} from '../src/operator/repoSearch.js';

function tmpProject(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-reposearch-'));
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(dir, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

// ── escapeRegExp / buildGrepPattern ──────────────────────────────────────

test('escapeRegExp neutralizes every regex metacharacter', () => {
  const escaped = escapeRegExp('a.b*c?d[e]f(g)h+i^j$k{l}m|n\\o');
  assert.doesNotThrow(() => new RegExp(escaped));
  assert.match('a.b*c?d[e]f(g)h+i^j$k{l}m|n\\o', new RegExp(escaped));
});

test('buildGrepPattern uses a valid pattern as a real, case-insensitive regex', () => {
  const regex = buildGrepPattern('fo+bar');
  assert.equal(regex.test('a FOOOBAR line'), true);
  assert.equal(regex.test('nothing here'), false);
});

test('buildGrepPattern falls back to a literal match when the input is not a valid regex', () => {
  const regex = buildGrepPattern('what(is[this');
  assert.equal(regex.test('literally what(is[this here'), true);
  assert.equal(regex.test('unrelated'), false);
});

// ── buildSymbolPattern ───────────────────────────────────────────────────

test('buildSymbolPattern matches common declaration shapes across languages', () => {
  const regex = buildSymbolPattern('DriverRegistry');
  assert.equal(regex.test('export class DriverRegistry {'), true);
  assert.equal(regex.test('class DriverRegistry:'), true);
  assert.equal(regex.test('  const DriverRegistry = {'), true);
  assert.equal(regex.test('function DriverRegistry(options) {'), true);
  assert.equal(regex.test('def DriverRegistry(self):'), true);
  assert.equal(regex.test('  DriverRegistry(config) {'), true);
});

test('buildSymbolPattern does not match an unrelated identifier or a mere mention', () => {
  const regex = buildSymbolPattern('DriverRegistry');
  assert.equal(regex.test('const OtherThing = {'), false);
  assert.equal(regex.test('  // see DriverRegistry for details'), false);
  assert.equal(regex.test('import { DriverRegistry } from "./driverRegistry.js";'), false);
});

test('buildSymbolPattern is case-sensitive, unlike buildGrepPattern', () => {
  const regex = buildSymbolPattern('DriverRegistry');
  assert.equal(regex.test('class driverregistry {'), false);
});

// ── buildTodoPattern / matchedTag (Phase 14 M4) ──────────────────────────

test('buildTodoPattern matches every default annotation tag as a whole word', () => {
  const regex = buildTodoPattern();
  for (const tag of ANNOTATION_TAGS) {
    assert.equal(regex.test(`// ${tag}: something`), true, `expected ${tag} to match`);
  }
});

test('buildTodoPattern is case-sensitive — lowercase prose is not mistaken for an annotation', () => {
  const regex = buildTodoPattern();
  assert.equal(regex.test('please note that this needs review'), false);
  assert.equal(regex.test('this is a hack to work around a bug'), false);
});

test('buildTodoPattern does not match a tag as a substring of a longer word', () => {
  const regex = buildTodoPattern();
  assert.equal(regex.test('const NOTEBOOK = {}'), false);
  assert.equal(regex.test('function HACKATHON() {}'), false);
});

test('buildTodoPattern accepts a narrower custom tag list', () => {
  const regex = buildTodoPattern(['TODO', 'FIXME']);
  assert.equal(regex.test('// TODO: later'), true);
  assert.equal(regex.test('// BUG: nope, not in this list'), false);
});

test('matchedTag reports which specific tag fired on a matched line', () => {
  assert.equal(matchedTag('// TODO: fix this'), 'TODO');
  assert.equal(matchedTag('// FIXME: memory leak'), 'FIXME');
  assert.equal(matchedTag('// DEPRECATED: use the new API'), 'DEPRECATED');
});

test('matchedTag returns null for a line that matches none of the tags', () => {
  assert.equal(matchedTag('const x = 1;'), null);
});

// ── searchFiles ───────────────────────────────────────────────────────────

test('searchFiles finds matches across nested directories', () => {
  const dir = tmpProject({
    'src/a.js': 'const x = 1;\nfunction hello() { return TODO; }\n',
    'src/nested/b.js': '// TODO: fix this\nconst y = 2;\n',
    'c.js': 'nothing to see here\n',
  });
  const results = searchFiles(dir, buildGrepPattern('TODO'));
  assert.equal(results.total, 2);
  const files = results.matches.map((m) => m.file).sort();
  assert.deepEqual(files, ['src/a.js', 'src/nested/b.js']);
});

test('searchFiles reports the real 1-based line number and trimmed text of each match', () => {
  const dir = tmpProject({ 'a.js': 'line one\nline two TODO\nline three\n' });
  const results = searchFiles(dir, buildGrepPattern('TODO'));
  assert.equal(results.matches.length, 1);
  assert.equal(results.matches[0].line, 2);
  assert.equal(results.matches[0].text, 'line two TODO');
});

test('searchFiles never descends into node_modules/.git/etc — the same ignore list /files uses', () => {
  const dir = tmpProject({
    'node_modules/pkg/index.js': 'TODO in a dependency',
    '.git/COMMIT_EDITMSG': 'TODO in git internals',
    'src/real.js': 'TODO in real source',
  });
  const results = searchFiles(dir, buildGrepPattern('TODO'));
  assert.equal(results.total, 1);
  assert.equal(results.matches[0].file, 'src/real.js');
});

test('searchFiles skips binary files instead of matching garbage bytes or throwing', () => {
  const dir = tmpProject({ 'text.js': 'TODO here\n' });
  fs.writeFileSync(path.join(dir, 'binary.dat'), Buffer.from([0x00, 0x01, 0x54, 0x4f, 0x44, 0x4f]));
  const results = searchFiles(dir, buildGrepPattern('TODO'));
  assert.equal(results.total, 1);
  assert.equal(results.matches[0].file, 'text.js');
});

test('searchFiles paginates results the same way listFiles() paginates entries', () => {
  const lines = Array.from({ length: 25 }, (_, i) => `TODO number ${i}`).join('\n');
  const dir = tmpProject({ 'many.js': lines });
  const page1 = searchFiles(dir, buildGrepPattern('TODO'), { pageSize: 10, page: 1 });
  assert.equal(page1.total, 25);
  assert.equal(page1.pageCount, 3);
  assert.equal(page1.matches.length, 10);
  assert.equal(page1.matches[0].text, 'TODO number 0');

  const page3 = searchFiles(dir, buildGrepPattern('TODO'), { pageSize: 10, page: 3 });
  assert.equal(page3.matches.length, 5);
  assert.equal(page3.matches[0].text, 'TODO number 20');
});

test('searchFiles clamps an out-of-range page to the last real page, like listFiles()', () => {
  const dir = tmpProject({ 'a.js': 'TODO one\nTODO two\n' });
  const results = searchFiles(dir, buildGrepPattern('TODO'), { pageSize: 10, page: 99 });
  assert.equal(results.page, 1);
  assert.equal(results.matches.length, 2);
});

test('searchFiles honestly reports truncation when the match cap is hit, never a silent partial result', () => {
  const files = {};
  for (let i = 0; i < 20; i += 1) {
    files[`f${i}.js`] = Array.from({ length: 30 }, () => 'TODO').join('\n');
  }
  const dir = tmpProject(files); // 600 real matches available
  const results = searchFiles(dir, buildGrepPattern('TODO'), { maxMatches: 500, pageSize: 500 });
  assert.equal(results.total, 500);
  assert.equal(results.truncated, true);
});

test('searchFiles reports truncation when the file-scan cap is hit, even with zero matches', () => {
  const files = {};
  for (let i = 0; i < 10; i += 1) files[`f${i}.js`] = 'nothing here\n';
  const dir = tmpProject(files);
  const results = searchFiles(dir, buildGrepPattern('NEVER_MATCHES'), { maxFilesScanned: 5 });
  assert.equal(results.total, 0);
  assert.equal(results.truncated, true);
  assert.equal(results.filesScanned, 6);
});

test('an empty project reports zero matches, not an error', () => {
  const dir = tmpProject({});
  const results = searchFiles(dir, buildGrepPattern('anything'));
  assert.equal(results.total, 0);
  assert.deepEqual(results.matches, []);
});

test('searchFiles refuses a project root that does not exist on disk', () => {
  const dir = tmpProject({});
  fs.rmSync(dir, { recursive: true, force: true });
  assert.throws(() => searchFiles(dir, buildGrepPattern('x')), FileAccessError);
});
