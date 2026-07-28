/**
 * Unit tests for operator/operatorContext.js — Phase 12 M2 Priority 2.
 *
 * "Selecting a project changes the active context. Every future command
 * applies only to that project until changed. The active project must be
 * remembered." These tests pin the remembering — including across a new
 * instance, which is what a service restart looks like from disk — and the
 * one case that would otherwise strand a conversation: the selected project
 * ceasing to exist.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import OperatorContext from '../src/operator/operatorContext.js';
import { silentLogger } from '../src/infra/logger.js';

function context() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-opctx-'));
  const contextFile = path.join(dir, 'context.json');
  return { contextFile, context: new OperatorContext({ contextFile, logger: silentLogger }) };
}

test('nothing is selected until something is selected', () => {
  const { context: c } = context();
  assert.equal(c.activeProject('telegram', '123'), null);
  assert.deepEqual(c.all(), []);
});

test('a selection is remembered, and survives a new instance (a service restart)', () => {
  const { contextFile, context: c } = context();
  const result = c.select('telegram', '1234567890', 'Remote Work', 'moses');

  assert.equal(result.project, 'Remote Work');
  assert.equal(result.previous, null);

  const afterRestart = new OperatorContext({ contextFile, logger: silentLogger });
  assert.equal(afterRestart.activeProject('telegram', '1234567890'), 'Remote Work');
  assert.equal(afterRestart.get('telegram', '1234567890').by, 'moses');
});

test('selections are per channel — the phone and the desktop keep their own cursor', () => {
  const { context: c } = context();
  c.select('telegram', '111', 'Calculator');
  c.select('desktop', null, 'THE FINISHER');

  assert.equal(c.activeProject('telegram', '111'), 'Calculator');
  assert.equal(c.activeProject('desktop'), 'THE FINISHER');
  assert.equal(c.activeProject('telegram', '999'), null, 'a different chat is a different cursor');
  assert.equal(c.all().length, 2);
});

test('re-selecting reports what it replaced', () => {
  const { context: c } = context();
  c.select('telegram', '1', 'alpha');
  const result = c.select('telegram', '1', 'beta');

  assert.equal(result.previous, 'alpha');
  assert.equal(c.activeProject('telegram', '1'), 'beta');
});

test('a selection pointing at a deleted project is pruned, not left to fail forever', () => {
  const { context: c } = context();
  c.select('telegram', '1', 'deleted-project');
  c.select('desktop', null, 'alpha');

  const cleared = c.pruneMissing(['alpha', 'beta']);

  assert.deepEqual(cleared, ['telegram:1']);
  assert.equal(c.activeProject('telegram', '1'), null, 'answerable as "none selected"');
  assert.equal(c.activeProject('desktop'), 'alpha', 'a valid selection is untouched');
});

test('clear removes one channel and reports whether there was anything to remove', () => {
  const { context: c } = context();
  c.select('telegram', '1', 'alpha');

  assert.equal(c.clear('telegram', '1'), true);
  assert.equal(c.clear('telegram', '1'), false);
  assert.equal(c.activeProject('telegram', '1'), null);
});

test('with no context file the store still works, in memory', () => {
  const c = new OperatorContext({ logger: silentLogger });
  c.select('telegram', '1', 'alpha');

  assert.equal(c.activeProject('telegram', '1'), 'alpha');
});
