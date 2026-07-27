/**
 * Phase 12 M1 — the polling-ownership contract (evidence item E3).
 *
 * Telegram's getUpdates is offset-acknowledged: polling with `offset=N+1`
 * permanently discards every update up to N. Two processes polling one bot
 * therefore destroy each other's messages, and an "APPROVE A7" consumed by
 * the wrong process means the mission waiting on A7 waits forever.
 *
 * These tests pin the fix from both sides:
 *   - a worker (receiveDecisions: false) never touches the inbound channel;
 *   - a worker still SEES decisions the daemon writes, through the store
 *     re-read waitForDecision has performed since Phase 10.
 *
 * The second half is the part that makes the first half safe, so it is tested
 * with a real ApprovalStore shared by two managers — the same file-backed
 * hand-off that happens between two real processes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApprovalManager } from '../src/approvals/approvalManager.js';
import { ApprovalStore } from '../src/approvals/approvalStore.js';
import { ORCHESTRATOR_DEFAULTS } from '../src/config/defaults.js';
import { silentLogger } from '../src/infra/logger.js';

const BASE_CONFIG = { ...ORCHESTRATOR_DEFAULTS.approvals, decisionPollMs: 5 };

/** A provider that counts inbound polls — the resource under contention. */
function countingProvider() {
  return {
    name: 'telegram-ish',
    canReceive: true,
    fetchCalls: 0,
    published: [],
    queuedDecisions: [],
    async publish(publication) {
      this.published.push(publication);
    },
    async fetchDecisions() {
      this.fetchCalls += 1;
      return this.queuedDecisions.splice(0);
    },
  };
}

function sharedStore() {
  const approvalsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-poll-own-'));
  return new ApprovalStore({ approvalsDir, logger: silentLogger });
}

test('a worker (receiveDecisions:false) never polls the inbound channel', async () => {
  const provider = countingProvider();
  const worker = new ApprovalManager({
    config: BASE_CONFIG,
    store: sharedStore(),
    providers: [provider],
    logger: silentLogger,
    receiveDecisions: false,
  });

  const resolved = await worker.pollProvidersOnce();

  assert.deepEqual(resolved, []);
  assert.equal(provider.fetchCalls, 0, 'the offset-stateful call was never made');
});

test('the default is unchanged: every pre-Phase-12 caller still polls', async () => {
  const provider = countingProvider();
  const legacy = new ApprovalManager({
    config: BASE_CONFIG,
    store: sharedStore(),
    providers: [provider],
    logger: silentLogger,
    // no receiveDecisions — exactly how App constructed this before Phase 12
  });

  await legacy.pollProvidersOnce();

  assert.equal(legacy.receiveDecisions, true);
  assert.equal(provider.fetchCalls, 1);
});

test('a worker still PUBLISHES its requests — only receiving is withdrawn', async () => {
  const provider = countingProvider();
  const worker = new ApprovalManager({
    config: { ...BASE_CONFIG, mode: 'cautious' },
    store: sharedStore(),
    providers: [provider],
    logger: silentLogger,
    receiveDecisions: false,
  });

  const result = await worker.requestApproval({
    project: 'demo', category: 'implementation-plan', title: 'Plan review',
  });

  assert.equal(result.approved, false);
  assert.equal(provider.published.length, 1, 'outbound is stateless and stays with the worker');
  assert.equal(provider.fetchCalls, 0);
});

test('a decision the DAEMON receives resolves the request a WORKER is waiting on', async () => {
  const store = sharedStore();
  const provider = countingProvider();

  // The daemon: the one process on the machine that receives.
  const daemon = new ApprovalManager({
    config: BASE_CONFIG, store, providers: [provider], logger: silentLogger,
    receiveDecisions: true,
  });
  // The worker: publishes, waits, never receives.
  const worker = new ApprovalManager({
    config: BASE_CONFIG, store, providers: [provider], logger: silentLogger,
    receiveDecisions: false,
  });

  const { request } = await worker.requestApproval({
    project: 'demo', category: 'implementation-plan', title: 'Plan review',
  });
  assert.ok(request, 'a pending request exists');

  const resolvedEvents = [];
  worker.on('approval:resolved', (event) => resolvedEvents.push(event));

  // The owner replies on their phone; the DAEMON is what reads it.
  provider.queuedDecisions.push({ requestId: request.id, decision: 'approved', by: 'owner' });
  const waiting = worker.waitForDecision(request);
  const appliedByDaemon = await daemon.pollProvidersOnce();

  const finalRequest = await waiting;

  assert.equal(appliedByDaemon.length, 1, 'the daemon applied the remote decision');
  assert.equal(finalRequest.status, 'approved', 'and the worker saw it through the store');
  assert.equal(provider.fetchCalls, 1, 'exactly ONE process consumed the update');
  assert.equal(resolvedEvents.length, 1, 'announced exactly once, as Phase 10 guarantees');
});

test('a worker with a queued inbound decision it must not read still waits', async () => {
  const store = sharedStore();
  const provider = countingProvider();
  const worker = new ApprovalManager({
    config: BASE_CONFIG, store, providers: [provider], logger: silentLogger,
    receiveDecisions: false,
  });

  const { request } = await worker.requestApproval({
    project: 'demo', category: 'implementation-plan', title: 'Plan review',
  });
  provider.queuedDecisions.push({ requestId: request.id, decision: 'approved', by: 'owner' });

  // Abort quickly: the point is that the worker does NOT resolve this itself.
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 60);
  const result = await worker.waitForDecision(request, { signal: controller.signal });

  assert.equal(result.status, 'pending', 'the worker never consumed the update itself');
  assert.equal(provider.fetchCalls, 0);
  assert.equal(provider.queuedDecisions.length, 1, 'the message is still there for the daemon');
});
