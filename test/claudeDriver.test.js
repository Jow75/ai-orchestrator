/**
 * Tests for Claude-specific knowledge: CLI argument construction and
 * usage-limit reset-time parsing. (Process spawning itself is exercised by
 * the mock-driver integration tests, not here.)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeDriver } from '../src/drivers/claudeDriver.js';
import { classifyExit, ExitCause } from '../src/core/exitClassifier.js';
import { silentLogger } from '../src/infra/logger.js';

const driver = new ClaudeDriver({ logger: silentLogger });

test('buildArgs: fresh headless run', () => {
  const args = driver.buildArgs(
    { model: '', permissionMode: '', allowedTools: [], disallowedTools: [], extraArgs: [], maxTurns: 0 },
    null
  );
  assert.deepEqual(args, ['-p', '--output-format', 'stream-json', '--verbose']);
});

test('buildArgs: resume includes --resume with the engine session id', () => {
  const args = driver.buildArgs(
    { model: '', permissionMode: '', allowedTools: [], disallowedTools: [], extraArgs: [], maxTurns: 0 },
    'abc-123'
  );
  assert.ok(args.includes('--resume'));
  assert.equal(args[args.indexOf('--resume') + 1], 'abc-123');
});

test('buildArgs: all optional settings are forwarded', () => {
  const args = driver.buildArgs(
    {
      model: 'claude-sonnet-5',
      permissionMode: 'acceptEdits',
      dangerouslySkipPermissions: true,
      maxTurns: 50,
      allowedTools: ['Read', 'Bash(git:*)'],
      disallowedTools: ['WebSearch'],
      extraArgs: ['--add-dir', 'C:/extra'],
    },
    null
  );
  assert.ok(args.includes('--model') && args.includes('claude-sonnet-5'));
  assert.ok(args.includes('--permission-mode') && args.includes('acceptEdits'));
  assert.ok(args.includes('--dangerously-skip-permissions'));
  assert.ok(args.includes('--max-turns') && args.includes('50'));
  assert.ok(args.includes('Read,Bash(git:*)'));
  assert.ok(args.includes('WebSearch'));
  assert.ok(args.includes('--add-dir') && args.includes('C:/extra'));
});

// ── Phase 13 M5: machine-wide default model ─────────────────────────────

test('buildArgs: with no defaultModelProvider, identical to before this milestone (regression)', () => {
  const bare = new ClaudeDriver({ logger: silentLogger }); // no closure passed at all
  const args = bare.buildArgs({ model: '' }, null);
  assert.ok(!args.includes('--model'));
});

test('buildArgs: falls back to the default model only when the project sets none', () => {
  const driverWithDefault = new ClaudeDriver({
    logger: silentLogger,
    defaultModelProvider: () => 'opus',
  });

  const withoutProjectModel = driverWithDefault.buildArgs({ model: '' }, null);
  assert.equal(withoutProjectModel[withoutProjectModel.indexOf('--model') + 1], 'opus');

  const withProjectModel = driverWithDefault.buildArgs({ model: 'haiku' }, null);
  assert.equal(withProjectModel[withProjectModel.indexOf('--model') + 1], 'haiku',
    'an explicit per-project model always wins over the machine-wide default');
});

test('buildArgs: the closure is read fresh on every call — a change applies to the NEXT launch only', () => {
  let current = 'sonnet';
  const driverWithDefault = new ClaudeDriver({
    logger: silentLogger,
    defaultModelProvider: () => current,
  });

  const first = driverWithDefault.buildArgs({ model: '' }, null);
  assert.equal(first[first.indexOf('--model') + 1], 'sonnet');

  current = 'opus'; // simulates /model opus landing between two launches
  const second = driverWithDefault.buildArgs({ model: '' }, null);
  assert.equal(second[second.indexOf('--model') + 1], 'opus');

  // The FIRST args array is a plain, already-returned array — nothing
  // retroactively changes it, matching "never interrupts an active mission."
  assert.equal(first[first.indexOf('--model') + 1], 'sonnet');
});

test('extractLimitResetTime: epoch-seconds form', () => {
  const epochSeconds = Math.floor(Date.now() / 1000) + 3600;
  const parsed = driver.extractLimitResetTime(
    `Claude AI usage limit reached|${epochSeconds}`
  );
  assert.ok(parsed instanceof Date);
  assert.equal(Math.floor(parsed.getTime() / 1000), epochSeconds);
});

test('extractLimitResetTime: "resets at 3am" form points to the future', () => {
  const parsed = driver.extractLimitResetTime('Your limit resets at 3am (UTC)');
  assert.ok(parsed instanceof Date);
  assert.ok(parsed.getTime() > Date.now());
  assert.equal(parsed.getHours(), 3);
});

test('extractLimitResetTime: "resets 11:30pm" with minutes', () => {
  const parsed = driver.extractLimitResetTime('5-hour limit reached ∙ resets 11:30pm');
  assert.ok(parsed instanceof Date);
  assert.equal(parsed.getHours(), 23);
  assert.equal(parsed.getMinutes(), 30);
});

test('extractLimitResetTime: 24-hour clock form', () => {
  const parsed = driver.extractLimitResetTime('usage limit reached, resets at 19:15');
  assert.ok(parsed instanceof Date);
  assert.equal(parsed.getHours(), 19);
  assert.equal(parsed.getMinutes(), 15);
});

test('extractLimitResetTime: returns null when nothing parses', () => {
  assert.equal(driver.extractLimitResetTime('no limits mentioned here'), null);
});

test('exitPatterns route real Claude limit messages to USAGE_LIMIT', () => {
  for (const message of [
    'Claude AI usage limit reached|1799999999',
    "You've reached your usage limit.",
    '5-hour limit reached ∙ resets 3am',
    'Usage limit reached — your limit resets at 4pm (Africa/Nairobi)',
  ]) {
    const verdict = classifyExit(
      { code: 1, signal: null, outputTail: message },
      driver.exitPatterns
    );
    assert.equal(verdict.cause, ExitCause.USAGE_LIMIT, `message: ${message}`);
  }
});

test('exitPatterns route connection failures to NETWORK', () => {
  const verdict = classifyExit(
    { code: 1, signal: null, outputTail: 'TypeError: fetch failed — getaddrinfo ENOTFOUND api.anthropic.com' },
    driver.exitPatterns
  );
  assert.equal(verdict.cause, ExitCause.NETWORK);
});
