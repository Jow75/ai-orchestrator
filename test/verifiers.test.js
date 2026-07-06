/**
 * Tests for the Verification Engine (core): the individual verifiers and
 * the registry that runs them. "Claude does not determine success —
 * verification determines success" is the principle under test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runVerifiers, isKnownVerifierType, listVerifierTypes,
} from '../src/verify/verifierRegistry.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aio-verify-'));
}

test('registry knows its built-in types', () => {
  assert.ok(isKnownVerifierType('file-exists'));
  assert.ok(isKnownVerifierType('command'));
  assert.ok(isKnownVerifierType('output-contains'));
  assert.ok(isKnownVerifierType('files-changed'));
  assert.ok(isKnownVerifierType('json-schema'));
  assert.ok(isKnownVerifierType('lint'));
  assert.ok(isKnownVerifierType('dependency'));
  assert.equal(isKnownVerifierType('nonsense'), false);
  assert.deepEqual(
    listVerifierTypes(),
    ['command', 'dependency', 'file-exists', 'files-changed', 'json-schema', 'lint', 'output-contains']
  );
});

test('unknown verifier type fails clearly instead of throwing', () => {
  const { passed, results } = runVerifiers([{ type: 'not-a-real-type' }], {});
  assert.equal(passed, false);
  assert.match(results[0].detail, /Unknown verifier type/);
});

test('a throwing verifier config fails only itself, not the whole run', () => {
  // command verifier with a run string this shell cannot execute at all
  // still returns a normal failed result rather than propagating.
  const { passed, results } = runVerifiers(
    [{ type: 'file-exists' }], // missing required "path" -> throws-safe path
    { workingDirectory: tempDir() }
  );
  assert.equal(passed, false);
  assert.match(results[0].detail, /missing "path"/);
});

test('file-exists: passes when the file is present', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
  const { passed } = runVerifiers(
    [{ type: 'file-exists', path: 'a.txt' }],
    { workingDirectory: dir }
  );
  assert.equal(passed, true);
});

test('file-exists: fails when the file is absent', () => {
  const { passed, results } = runVerifiers(
    [{ type: 'file-exists', path: 'missing.txt' }],
    { workingDirectory: tempDir() }
  );
  assert.equal(passed, false);
  assert.match(results[0].detail, /Not found/);
});

test('command: passes on the expected exit code', () => {
  const { passed } = runVerifiers(
    [{ type: 'command', run: process.platform === 'win32' ? 'exit 0' : 'true', expectExit: 0 }],
    { workingDirectory: tempDir() }
  );
  assert.equal(passed, true);
});

test('command: fails and reports the actual exit code on mismatch', () => {
  const { passed, results } = runVerifiers(
    [{ type: 'command', run: process.platform === 'win32' ? 'exit 3' : 'exit 3', expectExit: 0 }],
    { workingDirectory: tempDir() }
  );
  assert.equal(passed, false);
  assert.match(results[0].detail, /exited 3/);
});

test('output-contains: plain substring match', () => {
  const { passed } = runVerifiers(
    [{ type: 'output-contains', pattern: 'all good' }],
    { resultText: 'run finished: all good', outputTail: '' }
  );
  assert.equal(passed, true);
});

test('output-contains: regex mode', () => {
  const { passed } = runVerifiers(
    [{ type: 'output-contains', pattern: '\\d+ tests passed', regex: true }],
    { resultText: '42 tests passed', outputTail: '' }
  );
  assert.equal(passed, true);
});

test('output-contains: invalid regex fails cleanly', () => {
  const { passed, results } = runVerifiers(
    [{ type: 'output-contains', pattern: '(unterminated', regex: true }],
    { resultText: 'x', outputTail: '' }
  );
  assert.equal(passed, false);
  assert.match(results[0].detail, /Invalid regex/);
});

test('files-changed: passes when required paths were created/modified', () => {
  const { passed } = runVerifiers(
    [{ type: 'files-changed', paths: ['src/index.js'] }],
    { changes: { created: ['src/index.js'], modified: [] } }
  );
  assert.equal(passed, true);
});

test('files-changed: directory-prefix matching', () => {
  const { passed } = runVerifiers(
    [{ type: 'files-changed', paths: ['src/utils/'] }],
    { changes: { created: [], modified: ['src/utils/helpers.js'] } }
  );
  assert.equal(passed, true);
});

test('files-changed: fails when nothing matches', () => {
  const { passed, results } = runVerifiers(
    [{ type: 'files-changed', paths: ['src/index.js'] }],
    { changes: { created: ['other.js'], modified: [] } }
  );
  assert.equal(passed, false);
  assert.match(results[0].detail, /Not changed/);
});

test('files-changed: no prior change data (first run) fails, not throws', () => {
  const { passed, results } = runVerifiers(
    [{ type: 'files-changed', paths: ['a.js'] }],
    { changes: null }
  );
  assert.equal(passed, false);
  assert.match(results[0].detail, /No change data/);
});

test('multiple verifiers must ALL pass', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
  const { passed, results } = runVerifiers(
    [
      { type: 'file-exists', path: 'a.txt' },
      { type: 'file-exists', path: 'b.txt' },
    ],
    { workingDirectory: dir }
  );
  assert.equal(passed, false);
  assert.equal(results[0].passed, true);
  assert.equal(results[1].passed, false);
});

test('empty verifier list trivially passes', () => {
  assert.equal(runVerifiers([], {}).passed, true);
  assert.equal(runVerifiers(undefined, {}).passed, true);
});

// ── Phase P6: json-schema, lint, dependency ─────────────────────────────────

test('json-schema: passes when the file conforms', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ name: 'app', port: 8080 }));
  const { passed } = runVerifiers(
    [{
      type: 'json-schema', path: 'config.json',
      schema: {
        type: 'object', required: ['name', 'port'],
        properties: { name: { type: 'string' }, port: { type: 'integer', minimum: 1 } },
      },
    }],
    { workingDirectory: dir }
  );
  assert.equal(passed, true);
});

test('json-schema: reports the specific field and reason on mismatch', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port: 'not-a-number' }));
  const { passed, results } = runVerifiers(
    [{
      type: 'json-schema', path: 'config.json',
      schema: {
        type: 'object', required: ['name', 'port'],
        properties: { name: { type: 'string' }, port: { type: 'integer' } },
      },
    }],
    { workingDirectory: dir }
  );
  assert.equal(passed, false);
  assert.match(results[0].detail, /missing required property "name"/);
  assert.match(results[0].detail, /at "\$\.port": expected integer, got string/);
});

test('json-schema: invalid JSON in the target file fails cleanly', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'config.json'), '{not valid json');
  const { passed, results } = runVerifiers(
    [{ type: 'json-schema', path: 'config.json', schema: { type: 'object' } }],
    { workingDirectory: dir }
  );
  assert.equal(passed, false);
  assert.match(results[0].detail, /not valid JSON/);
});

test('json-schema: missing target file fails with "Not found"', () => {
  const { passed, results } = runVerifiers(
    [{ type: 'json-schema', path: 'missing.json', schema: { type: 'object' } }],
    { workingDirectory: tempDir() }
  );
  assert.equal(passed, false);
  assert.match(results[0].detail, /Not found/);
});

test('json-schema: can load the schema from a schemaFile', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify({ ok: true }));
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({ type: 'object', required: ['ok'] }));
  const { passed } = runVerifiers(
    [{ type: 'json-schema', path: 'data.json', schemaFile: 'schema.json' }],
    { workingDirectory: dir }
  );
  assert.equal(passed, true);
});

test('lint: exits 0 -> passes with a clean-lint detail', () => {
  const { passed, results } = runVerifiers(
    [{ type: 'lint', run: 'node -e "process.exit(0)"' }],
    { workingDirectory: tempDir() }
  );
  assert.equal(passed, true);
  assert.match(results[0].detail, /lint clean/);
});

test('lint: parses ESLint-style JSON output into a specific problem list', () => {
  const dir = tempDir();
  const eslintJson = JSON.stringify([
    { filePath: '/repo/src/a.js', messages: [{ ruleId: 'no-unused-vars', message: "'x' is never used", line: 12 }] },
  ]);
  // A temp script file sidesteps cross-shell quoting entirely (Windows
  // cmd.exe vs POSIX sh mangle inline `node -e "..."` differently).
  const scriptFile = path.join(dir, 'fake-lint.js');
  fs.writeFileSync(scriptFile, `console.log(${JSON.stringify(eslintJson)});\nprocess.exit(1);\n`);
  const { passed, results } = runVerifiers(
    [{ type: 'lint', run: `node "${scriptFile}"` }],
    { workingDirectory: dir }
  );
  assert.equal(passed, false);
  assert.match(results[0].detail, /src\/a\.js:12 \[no-unused-vars\] 'x' is never used/);
});

test('lint: non-JSON output falls back to the generic exit-code/output detail', () => {
  const dir = tempDir();
  const scriptFile = path.join(dir, 'fake-lint-plain.js');
  fs.writeFileSync(scriptFile, "console.log('plain text error');\nprocess.exit(1);\n");
  const { passed, results } = runVerifiers(
    [{ type: 'lint', run: `node "${scriptFile}"` }],
    { workingDirectory: dir }
  );
  assert.equal(passed, false);
  assert.match(results[0].detail, /exited 1, expected 0/);
  assert.match(results[0].detail, /plain text error/);
});

test('dependency: passes when declared and installed', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { express: '^4.0.0' } }));
  fs.mkdirSync(path.join(dir, 'node_modules', 'express'), { recursive: true });
  const { passed, results } = runVerifiers(
    [{ type: 'dependency', name: 'express' }],
    { workingDirectory: dir }
  );
  assert.equal(passed, true);
  assert.match(results[0].detail, /declared in dependencies and installed/);
});

test('dependency: declared but not installed reports the actual gap', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { express: '^4.0.0' } }));
  const { passed, results } = runVerifiers(
    [{ type: 'dependency', name: 'express' }],
    { workingDirectory: dir }
  );
  assert.equal(passed, false);
  assert.match(results[0].detail, /not installed/);
  assert.match(results[0].detail, /npm install/);
});

test('dependency: not declared at all fails clearly', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: {} }));
  const { passed, results } = runVerifiers(
    [{ type: 'dependency', name: 'express' }],
    { workingDirectory: dir }
  );
  assert.equal(passed, false);
  assert.match(results[0].detail, /is not declared/);
});

test('dependency: installed:false skips the node_modules check', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { eslint: '^9.0.0' } }));
  const { passed } = runVerifiers(
    [{ type: 'dependency', name: 'eslint', installed: false }],
    { workingDirectory: dir }
  );
  assert.equal(passed, true);
});

test('dependency: missing package.json fails clearly', () => {
  const { passed, results } = runVerifiers(
    [{ type: 'dependency', name: 'express' }],
    { workingDirectory: tempDir() }
  );
  assert.equal(passed, false);
  assert.match(results[0].detail, /No package\.json found/);
});
