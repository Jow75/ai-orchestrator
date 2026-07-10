/**
 * Unit tests for cliDriver.js — the generic, config-driven CLI engine
 * driver. Uses a throwaway Node script as a stand-in "engine" so the tests
 * are cross-platform and need no real AI CLI installed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliDriver } from '../src/drivers/cliDriver.js';
import { classifyExit } from '../src/core/exitClassifier.js';
import { silentLogger } from '../src/infra/logger.js';

/** Write a tiny Node "engine" script and return its path + working dir. */
function makeEngine(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-cli-'));
  const script = path.join(dir, 'engine.js');
  fs.writeFileSync(script, body);
  return { dir, script };
}

function driver() {
  return new CliDriver({ logger: silentLogger });
}

test('delivers the prompt on stdin and streams output; exit 0', async () => {
  const { dir, script } = makeEngine(`
    let data = '';
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => { process.stdout.write('ENGINE_SAW:' + data); process.exit(0); });
  `);
  const project = { name: 'p', workingDirectory: dir, cli: { command: process.execPath, args: [script] } };
  const run = await driver().launch({ project, prompt: 'hello-prompt', engineSessionId: null });
  const exit = await run.waitForExit();
  assert.equal(exit.code, 0);
  assert.match(exit.outputTail, /ENGINE_SAW:hello-prompt/);
});

test('passes the prompt as an arg when promptArg is set', async () => {
  const { dir, script } = makeEngine(`
    process.stdout.write('ARGV:' + process.argv.slice(2).join(','));
    process.exit(0);
  `);
  const project = {
    name: 'p', workingDirectory: dir,
    cli: { command: process.execPath, args: [script], promptArg: '--task' },
  };
  const run = await driver().launch({ project, prompt: 'do-the-thing', engineSessionId: null });
  const exit = await run.waitForExit();
  assert.match(exit.outputTail, /ARGV:--task,do-the-thing/);
});

test('a non-zero exit is reported as an error result', async () => {
  const { dir, script } = makeEngine('process.exit(3);');
  const project = { name: 'p', workingDirectory: dir, cli: { command: process.execPath, args: [script] } };
  const run = await driver().launch({ project, prompt: 'x', engineSessionId: null });
  const exit = await run.waitForExit();
  assert.equal(exit.code, 3);
  assert.equal(exit.resultIsError, true);
});

test('configured usage-limit patterns classify the exit as a usage limit', async () => {
  const { dir, script } = makeEngine("process.stdout.write('CUSTOM_QUOTA_HIT now'); process.exit(0);");
  const d = driver();
  const project = {
    name: 'p', workingDirectory: dir,
    cli: { command: process.execPath, args: [script], usageLimitPatterns: ['CUSTOM_QUOTA_HIT'] },
  };
  const run = await d.launch({ project, prompt: 'x', engineSessionId: null });
  const exit = await run.waitForExit();
  const verdict = classifyExit(exit, d.exitPatterns);
  assert.equal(verdict.cause, 'usage-limit');
});

test('launch without a command throws a clear error', async () => {
  await assert.rejects(
    () => driver().launch({ project: { name: 'p', cli: {} }, prompt: 'x', engineSessionId: null }),
    /needs a "command"/
  );
});

test('checkInstallation succeeds for node and fails for a bogus command', async () => {
  const okResult = await driver().checkInstallation(process.execPath);
  assert.equal(okResult.ok, true);
  const badResult = await driver().checkInstallation('definitely-not-a-real-command-xyz');
  assert.equal(badResult.ok, false);
});
