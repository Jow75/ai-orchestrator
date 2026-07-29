/**
 * Tests for operator/operatorGateway.js — Phase 12 M2.
 *
 * This is the M2 half of the exclusivity contract M1 established (see
 * approvalPollOwnership.test.js for the M1 half). The rule is the same and the
 * reason is the same: Telegram's getUpdates is offset-acknowledged, so a
 * message read by the wrong component is DESTROYED, not merely missed.
 *
 * M2's specific risk is subtler than M1's. It is not two processes — it is one
 * process reading the same feed twice, once for commands and once for
 * decisions. So the central assertion here is a call count: exactly ONE
 * consuming read per provider per tick, with both grammars served from it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import OperatorGateway from '../src/operator/operatorGateway.js';
import ApprovalManager from '../src/approvals/approvalManager.js';
import ApprovalStore from '../src/approvals/approvalStore.js';
import EventStore from '../src/events/eventStore.js';
import { ORCHESTRATOR_DEFAULTS } from '../src/config/defaults.js';
import { silentLogger } from '../src/infra/logger.js';

/** A Telegram-shaped provider that counts every consuming read. */
function routingProvider() {
  return {
    name: 'telegram',
    canReceive: true,
    canRoute: true,
    messageReads: 0,
    decisionReads: 0,
    inbox: [],
    sent: [],
    documents: [],
    sendFails: false,
    documentFails: false,
    async publish() {},
    async fetchMessages() {
      this.messageReads += 1;
      return this.inbox.splice(0);
    },
    async fetchDecisions() {
      this.decisionReads += 1;
      return [];
    },
    async sendText(text) {
      if (this.sendFails) throw new Error('telegram is down');
      this.sent.push(text);
      return { messageId: '1' };
    },
    async sendDocument(attachment) {
      if (this.documentFails) throw new Error('attach failed');
      this.documents.push(attachment);
      return { messageId: '2' };
    },
  };
}

/** A pre-M2 provider: it can receive decisions but cannot route commands. */
function decisionOnlyProvider() {
  return {
    name: 'legacy',
    canReceive: true,
    canRoute: false,
    decisionReads: 0,
    queued: [],
    async publish() {},
    async fetchDecisions() {
      this.decisionReads += 1;
      return this.queued.splice(0);
    },
  };
}

/**
 * A router stand-in that records what it was asked and answers predictably.
 * `reply` may be a string (the common case), a function of the message, or —
 * Phase 13 M6 — a full `{reply, attachment}` object (or a function returning
 * one), so attachment-delivery tests can drive the same stand-in.
 */
function recordingRouter(reply = 'ok') {
  return {
    seen: [],
    async handle(message) {
      this.seen.push(message);
      const value = typeof reply === 'function' ? reply(message) : reply;
      return typeof value === 'string' || value === null ? { reply: value } : value;
    },
  };
}

function managerWith(providers) {
  const approvalsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-gateway-'));
  return new ApprovalManager({
    config: ORCHESTRATOR_DEFAULTS.approvals,
    store: new ApprovalStore({ approvalsDir, logger: silentLogger }),
    providers,
    logger: silentLogger,
  });
}

function events() {
  const eventsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-gw-events-'));
  return new EventStore({ eventsDir, logger: silentLogger });
}

test('one tick performs exactly ONE consuming read per routing provider', async () => {
  const provider = routingProvider();
  provider.inbox.push(
    { text: '/projects', from: 'moses', chatId: '42' },
    { text: 'APPROVE A7', from: 'moses', chatId: '42' }
  );
  const router = recordingRouter();
  const gateway = new OperatorGateway({
    router, approvalManager: managerWith([provider]), events: events(), logger: silentLogger,
  });

  const result = await gateway.tick();

  assert.equal(provider.messageReads, 1, 'the offset-stateful call was made once');
  assert.equal(provider.decisionReads, 0, 'and NOT a second time for decisions');
  assert.equal(result.handled, 2, 'both messages were routed from that single read');
  assert.deepEqual(router.seen.map((m) => m.text), ['/projects', 'APPROVE A7']);
});

test('every routed message carries its channel and sender to the router', async () => {
  const provider = routingProvider();
  provider.inbox.push({ text: '/status', from: 'moses', chatId: '1234567890' });
  const router = recordingRouter();
  const gateway = new OperatorGateway({
    router, approvalManager: managerWith([provider]), logger: silentLogger,
  });

  await gateway.tick();

  assert.deepEqual(router.seen[0], {
    text: '/status', channel: 'telegram', chatId: '1234567890', from: 'moses',
  });
});

test('the reply goes back on the same channel and is recorded as sent', async () => {
  const provider = routingProvider();
  provider.inbox.push({ text: '/projects', from: 'moses', chatId: '42' });
  const store = events();
  const gateway = new OperatorGateway({
    router: recordingRouter('Projects (2)'),
    approvalManager: managerWith([provider]),
    events: store,
    logger: silentLogger,
  });

  await gateway.tick();

  assert.deepEqual(provider.sent, ['Projects (2)']);
  assert.equal(store.read({ types: ['notification.sent'] }).length, 1);
});

test('a null reply sends nothing', async () => {
  const provider = routingProvider();
  provider.inbox.push({ text: '   ', from: 'moses', chatId: '42' });
  const gateway = new OperatorGateway({
    router: recordingRouter(null), approvalManager: managerWith([provider]), logger: silentLogger,
  });

  await gateway.tick();

  assert.deepEqual(provider.sent, []);
});

test('a failure to SEND the reply never re-runs the command', async () => {
  const provider = routingProvider();
  provider.sendFails = true;
  provider.inbox.push({ text: '/stop alpha', from: 'moses', chatId: '42' });
  const router = recordingRouter('stopped');
  const gateway = new OperatorGateway({
    router, approvalManager: managerWith([provider]), logger: silentLogger,
  });

  await gateway.tick();
  await gateway.tick();

  assert.equal(router.seen.length, 1,
    '"/stop was applied twice because the confirmation failed to send" is not a trade worth making');
});

test('a provider that throws on read does not stop the others', async () => {
  const broken = routingProvider();
  broken.name = 'broken';
  broken.fetchMessages = async () => { throw new Error('network down'); };
  const working = routingProvider();
  working.inbox.push({ text: '/help', from: 'moses', chatId: '42' });
  const router = recordingRouter();
  const gateway = new OperatorGateway({
    router, approvalManager: managerWith([broken, working]), logger: silentLogger,
  });

  const result = await gateway.tick();

  assert.equal(result.handled, 1);
  assert.deepEqual(working.sent, ['ok']);
});

test('a pre-M2 decision-only provider is still polled, exactly once, the old way', async () => {
  const legacy = decisionOnlyProvider();
  const manager = managerWith([legacy]);
  const request = manager.store.create('alpha', {
    category: 'implementation-plan', approvalClass: 'review', title: 'Plan review',
  });
  legacy.queued.push({ requestId: request.id, decision: 'approved', by: 'owner' });

  const gateway = new OperatorGateway({
    router: recordingRouter(), approvalManager: manager, logger: silentLogger,
  });
  const result = await gateway.tick();

  assert.equal(legacy.decisionReads, 1);
  assert.equal(result.resolved.length, 1);
  assert.equal(manager.store.get('alpha', request.id).status, 'approved');
});

test('a routing provider is NOT also polled as a decision provider', async () => {
  const routing = routingProvider();
  const legacy = decisionOnlyProvider();
  const gateway = new OperatorGateway({
    router: recordingRouter(), approvalManager: managerWith([routing, legacy]), logger: silentLogger,
  });

  await gateway.tick();

  assert.equal(routing.messageReads, 1);
  assert.equal(routing.decisionReads, 0, 'reading it twice is the bug this component exists to prevent');
  assert.equal(legacy.decisionReads, 1);
});

test('the provider list is read live, so a swapped provider is honoured', async () => {
  const manager = managerWith([]);
  const gateway = new OperatorGateway({
    router: recordingRouter(), approvalManager: manager, logger: silentLogger,
  });
  assert.equal(gateway.active, false, 'nothing configured yet');

  const provider = routingProvider();
  provider.inbox.push({ text: '/help', from: 'moses', chatId: '42' });
  manager.providers = [provider];

  assert.equal(gateway.active, true);
  await gateway.tick();
  assert.equal(provider.messageReads, 1, 'a stale captured list would have polled nothing');
});

test('with nothing to poll the loop refuses to arm a timer', () => {
  const gateway = new OperatorGateway({
    router: recordingRouter(), approvalManager: managerWith([]), logger: silentLogger,
  });

  assert.equal(gateway.start(), false);
  assert.equal(gateway.timer, null);
});

test('starting is idempotent and stopping disarms', async () => {
  const provider = routingProvider();
  const gateway = new OperatorGateway({
    router: recordingRouter(), approvalManager: managerWith([provider]),
    logger: silentLogger, pollIntervalMs: 10_000,
  });

  assert.equal(gateway.start(), true);
  const timer = gateway.timer;
  assert.equal(gateway.start(), false, 'a second start does not arm a second timer');
  assert.equal(gateway.timer, timer);

  gateway.stop();
  assert.equal(gateway.timer, null);
});

// ────────────────────────────────── Phase 13 M6: attachment delivery ──────

test('a reply carrying an attachment sends the text, then the document', async () => {
  const provider = routingProvider();
  provider.inbox.push({ text: '/file README.md', from: 'moses', chatId: '42' });
  const router = recordingRouter({ reply: '📄 README.md', attachment: { filePath: '/tmp/README.md' } });
  const store = events();
  const gateway = new OperatorGateway({
    router, approvalManager: managerWith([provider]), events: store, logger: silentLogger,
  });

  await gateway.tick();

  assert.deepEqual(provider.sent, ['📄 README.md']);
  assert.deepEqual(provider.documents, [{ filePath: '/tmp/README.md' }]);
  assert.equal(store.read({ types: ['notification.sent'] }).length, 2, 'one event for the text, one for the attachment');
});

test('an attachment-only reply (no text) still gets delivered', async () => {
  const provider = routingProvider();
  provider.inbox.push({ text: '/download_project', from: 'moses', chatId: '42' });
  const router = recordingRouter({ reply: null, attachment: { filePath: '/tmp/proj.zip' } });
  const gateway = new OperatorGateway({
    router, approvalManager: managerWith([provider]), logger: silentLogger,
  });

  await gateway.tick();

  assert.deepEqual(provider.sent, []);
  assert.deepEqual(provider.documents, [{ filePath: '/tmp/proj.zip' }]);
});

test('a provider with no sendDocument (duck-typed) silently never gets asked for one', async () => {
  const provider = routingProvider();
  delete provider.sendDocument;
  provider.inbox.push({ text: '/file README.md', from: 'moses', chatId: '42' });
  const router = recordingRouter({ reply: 'text only', attachment: { filePath: '/tmp/README.md' } });
  const gateway = new OperatorGateway({
    router, approvalManager: managerWith([provider]), logger: silentLogger,
  });

  await assert.doesNotReject(() => gateway.tick());
  assert.deepEqual(provider.sent, ['text only']);
});

test('a failed attachment send is logged but never disturbs the text reply already sent', async () => {
  const provider = routingProvider();
  provider.documentFails = true;
  provider.inbox.push({ text: '/file huge.bin', from: 'moses', chatId: '42' });
  const router = recordingRouter({ reply: 'sending…', attachment: { filePath: '/tmp/huge.bin' } });
  const gateway = new OperatorGateway({
    router, approvalManager: managerWith([provider]), logger: silentLogger,
  });

  await assert.doesNotReject(() => gateway.tick());
  assert.deepEqual(provider.sent, ['sending…'], 'the text still went out despite the attachment failing');
});

test('broadcast pushes to every routing channel and survives a dead one', async () => {
  const good = routingProvider();
  const dead = routingProvider();
  dead.name = 'dead';
  dead.sendFails = true;
  const store = events();
  const gateway = new OperatorGateway({
    router: recordingRouter(), approvalManager: managerWith([good, dead]),
    events: store, logger: silentLogger,
  });

  const sent = await gateway.broadcast('▶️ alpha — Coding');

  assert.equal(sent, 1);
  assert.deepEqual(good.sent, ['▶️ alpha — Coding']);
  assert.equal(store.read({ types: ['notification.sent'] }).length, 1);
});

test('broadcast with no channels sends nothing and records nothing', async () => {
  const store = events();
  const gateway = new OperatorGateway({
    router: recordingRouter(), approvalManager: managerWith([]), events: store, logger: silentLogger,
  });

  assert.equal(await gateway.broadcast('anything'), 0);
  assert.equal(store.read().length, 0);
});
