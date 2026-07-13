/**
 * Unit tests for approvalManager.js — the Phase 10A centerpiece: policy
 * evaluation, publish fan-out, decision waiting (store + provider paths),
 * human-action requests, and timeout expiry.
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

const BASE_CONFIG = {
  ...ORCHESTRATOR_DEFAULTS.approvals,
  decisionPollMs: 10, // fast polling for tests
};

function manager({ config = {}, providers = [] } = {}) {
  const approvalsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-apmgr-'));
  const store = new ApprovalStore({ approvalsDir, logger: silentLogger });
  return {
    store,
    manager: new ApprovalManager({
      config: { ...BASE_CONFIG, ...config }, store, providers, logger: silentLogger,
    }),
  };
}

/** A controllable fake provider. */
function fakeProvider({ canReceive = true } = {}) {
  return {
    name: 'fake',
    canReceive,
    published: [],
    queuedDecisions: [],
    async publish(publication) {
      this.published.push(publication);
    },
    async fetchDecisions() {
      return this.queuedDecisions.splice(0);
    },
  };
}

test('automatic work is auto-approved and recorded as an audit trail', async () => {
  const { manager: m, store } = manager();
  const result = await m.requestApproval({
    project: 'proj', category: 'tests', title: 'run tests',
  });
  assert.equal(result.approved, true);
  assert.equal(result.auto, true);
  assert.equal(store.list('proj')[0].status, 'auto-approved');
});

test('an owner gate publishes to providers and emits approval:required', async () => {
  const provider = fakeProvider();
  const { manager: m } = manager({ providers: [provider] });
  const events = [];
  m.on('approval:required', (e) => events.push(e));

  const result = await m.requestApproval({
    project: 'proj', category: 'production-deployment', title: 'deploy!',
  });
  assert.equal(result.approved, false);
  assert.equal(result.request.status, 'pending');
  assert.equal(provider.published.length, 1);
  assert.match(provider.published[0].message, new RegExp(`APPROVE ${result.request.id}`));
  assert.equal(events.length, 1);
});

test('waitForDecision returns once a provider reply resolves the request', async () => {
  const provider = fakeProvider();
  const { manager: m } = manager({ providers: [provider] });
  const resolved = [];
  m.on('approval:resolved', (e) => resolved.push(e.request.status));

  const { request } = await m.requestApproval({
    project: 'proj', category: 'secrets', title: 'rotate key',
  });
  // The "owner" replies on the second poll.
  setTimeout(() => {
    provider.queuedDecisions.push({ requestId: request.id, decision: 'approved', by: 'owner' });
  }, 15);

  const final = await m.waitForDecision(request);
  assert.equal(final.status, 'approved');
  assert.equal(final.via, 'fake');
  assert.deepEqual(resolved, ['approved']);
});

test('waitForDecision sees a decision made directly through the store (CLI path)', async () => {
  const { manager: m, store } = manager();
  const { request } = await m.requestApproval({
    project: 'proj', category: 'financial', title: 'buy credits',
  });
  setTimeout(() => {
    store.resolve('proj', request.id, { decision: 'rejected', note: 'too pricey', via: 'cli' });
  }, 15);
  const final = await m.waitForDecision(request);
  assert.equal(final.status, 'rejected');
  assert.equal(final.decisionNote, 'too pricey');
});

test('waitForDecision expires the request after decisionTimeoutMs', async () => {
  const { manager: m } = manager({ config: { decisionTimeoutMs: 30 } });
  const { request } = await m.requestApproval({
    project: 'proj', category: 'secrets', title: 'never answered',
  });
  const final = await m.waitForDecision(request);
  assert.equal(final.status, 'expired');
});

test('waitForDecision honors a per-project decisionTimeoutMs override', async () => {
  // Global says wait forever; the project itself sets a 30ms timeout.
  const { manager: m } = manager({ config: { decisionTimeoutMs: 0 } });
  const { request } = await m.requestApproval({
    project: 'proj', category: 'secrets', title: 'project-scoped timeout',
  });
  const final = await m.waitForDecision(request, {
    projectConfig: { approvals: { decisionTimeoutMs: 30 } },
  });
  assert.equal(final.status, 'expired');
});

test('waitForDecision aborts cleanly (request stays pending) on operator stop', async () => {
  const { manager: m } = manager();
  const { request } = await m.requestApproval({
    project: 'proj', category: 'secrets', title: 'will be aborted',
  });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  const final = await m.waitForDecision(request, { signal: controller.signal });
  assert.equal(final.status, 'pending');
});

test('requestHumanAction publishes what/why/action/where and asks for DONE', async () => {
  const provider = fakeProvider();
  const { manager: m } = manager({ providers: [provider] });
  const events = [];
  m.on('human-action:required', (e) => events.push(e));

  const result = await m.requestHumanAction({
    project: 'proj', category: 'captcha',
    what: 'A CAPTCHA appeared.', why: 'The signup page requires it.',
    actionRequired: 'Solve the CAPTCHA in the browser.', where: 'C:/work/proj',
  });
  assert.equal(result.approved, false);
  assert.equal(events.length, 1);
  const message = provider.published[0].message;
  assert.match(message, /What happened: A CAPTCHA appeared\./);
  assert.match(message, /Why it stopped:/);
  assert.match(message, /Action required:/);
  assert.match(message, /Where: C:\/work\/proj/);
  assert.match(message, new RegExp(`DONE ${result.request.id}`));
});

test('a failing provider never breaks the request (publish is best-effort)', async () => {
  const broken = {
    name: 'broken', canReceive: false,
    async publish() { throw new Error('boom'); },
    async fetchDecisions() { return []; },
  };
  const { manager: m } = manager({ providers: [broken] });
  const result = await m.requestApproval({
    project: 'proj', category: 'secrets', title: 'still recorded',
  });
  assert.equal(result.request.status, 'pending'); // persisted despite the failure
});

test('conservative mode pauses even automatic categories; autonomous auto-approves reviews', async () => {
  const conservative = manager({ config: { mode: 'conservative' } });
  const paused = await conservative.manager.requestApproval({
    project: 'proj', category: 'tests', title: 'tests',
  });
  assert.equal(paused.approved, false);

  const autonomous = manager({ config: { mode: 'autonomous' } });
  const review = await autonomous.manager.requestImplementationReview({
    project: 'proj',
    summary: {
      project: 'proj', objective: 'do things', estimatedDuration: '1h',
      estimatedFilesChanged: '3', tasks: [], risks: [], affectedSystems: [], files: [],
    },
  });
  assert.equal(review.approved, true);
});

test('per-project mode override wins over the global mode', async () => {
  const { manager: m } = manager({ config: { mode: 'conservative' } });
  const result = await m.requestApproval({
    project: 'proj', category: 'tests', title: 'tests',
    projectConfig: { approvals: { mode: 'autonomous' } },
  });
  assert.equal(result.approved, true);
});
