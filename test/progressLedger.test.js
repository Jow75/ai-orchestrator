/**
 * Tests for the per-run progress ledger (the audit trail the incident lacked).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProgressLedger } from '../src/progress/progressLedger.js';
import { silentLogger } from '../src/infra/logger.js';

function ledger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-ledger-'));
  return new ProgressLedger({ ledgerDir: dir, logger: silentLogger });
}

test('records runs and returns them oldest → newest', () => {
  const l = ledger();
  l.record({ project: 'p', sessionId: 's', run: 1, cause: 'completed', progressed: true });
  l.record({ project: 'p', sessionId: 's', run: 2, cause: 'completed', progressed: false });

  const recent = l.recent('p', 10);
  assert.equal(recent.length, 2);
  assert.equal(recent[0].run, 1);
  assert.equal(recent[1].run, 2);
  assert.equal(recent[1].progressed, false);
});

test('recent(n) returns only the last n records', () => {
  const l = ledger();
  for (let i = 1; i <= 5; i += 1) {
    l.record({ project: 'p', sessionId: 's', run: i, cause: 'completed', progressed: true });
  }
  const recent = l.recent('p', 2);
  assert.deepEqual(recent.map((r) => r.run), [4, 5]);
});

test('truncates very long result text', () => {
  const l = ledger();
  l.record({
    project: 'p', sessionId: 's', run: 1, cause: 'completed', progressed: true,
    resultText: 'x'.repeat(10_000),
  });
  const [record] = l.recent('p', 1);
  assert.ok(record.resultText.length <= 2_000);
});

test('records are isolated per project', () => {
  const l = ledger();
  l.record({ project: 'alpha', sessionId: 's', run: 1, cause: 'completed', progressed: true });
  l.record({ project: 'beta', sessionId: 's', run: 1, cause: 'completed', progressed: true });
  assert.equal(l.recent('alpha').length, 1);
  assert.equal(l.recent('beta').length, 1);
});
