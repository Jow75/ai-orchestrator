/**
 * operatorGateway.js — Phase 12 M2: the one place inbound messages enter.
 *
 * M1 established that Telegram's `getUpdates` is offset-acknowledged, so it can
 * have exactly ONE reader per machine — a second reader does not merely miss
 * messages, it destroys the first reader's. M1 satisfied that by making the
 * daemon the only process that polls.
 *
 * M2 hits the same rule one level up. `ApprovalManager.pollProvidersOnce()`
 * reads the channel and keeps only decision-shaped replies; everything else is
 * consumed and discarded. That was correct when "APPROVE A7" was the entire
 * grammar. The moment the owner can type "/projects", a second reader would be
 * needed for commands — and the two would eat each other exactly as two
 * daemons would.
 *
 * So the gateway becomes the single reader, and the split happens AFTER the
 * read, in memory, where it is free:
 *
 *      provider.fetchMessages()        ← the one and only consuming read
 *              │
 *              ▼
 *      commandGrammar.parseCommand()
 *              │
 *      ┌───────┴────────┐
 *      ▼                ▼
 *   decision         command / free text
 *   → ApprovalManager.applyRemoteDecision()  (the identical store path
 *     that pollProvidersOnce has always used, including the once-only
 *     'approval:resolved' emission workers depend on)
 *              │
 *              ▼
 *          Event Store
 *
 * The daemon therefore no longer calls `pollProvidersOnce()` for a routing
 * provider. It is NOT removed: a standalone `ai-orchestrator start` with no
 * daemon still uses it, unchanged, which is what keeps the Phase 12 Invariant
 * true through a second milestone.
 *
 * A provider that can receive but cannot route (a future one-way-parse
 * provider) is still polled here the old way, in the same tick, so there is
 * still exactly one reader per provider.
 */

/** Default inbound poll cadence when the daemon config does not say. */
export const DEFAULT_POLL_MS = 10_000;

export class OperatorGateway {
  /**
   * @param {object} deps
   * @param {import('./commandRouter.js').CommandRouter} deps.router
   * @param {import('../approvals/approvalManager.js').ApprovalManager} deps.approvalManager
   * @param {import('../events/eventStore.js').EventStore} [deps.events]
   * @param {object} deps.logger
   * @param {number} [deps.pollIntervalMs]
   */
  constructor({ router, approvalManager, events, logger, pollIntervalMs = DEFAULT_POLL_MS }) {
    this.router = router;
    this.approvalManager = approvalManager;
    this.events = events;
    this.logger = logger;
    this.pollIntervalMs = pollIntervalMs;
    this.timer = null;
  }

  /**
   * Providers that hand back raw messages (the operator console).
   *
   * Derived on every read rather than captured at construction. The provider
   * list is owned by the Approval Manager, and a gateway holding its own copy
   * would silently keep polling a provider that had been replaced — reading
   * an offset-acknowledged feed with a stale object is exactly the class of
   * bug this whole component exists to make impossible.
   */
  get routing() {
    return this.approvalManager.providers.filter((p) => p.canRoute);
  }

  /** Providers that can only hand back parsed decisions (the pre-M2 shape). */
  get decisionOnly() {
    return this.approvalManager.providers.filter((p) => p.canReceive && !p.canRoute);
  }

  /** Whether there is anything to poll at all. */
  get active() {
    return this.routing.length > 0 || this.decisionOnly.length > 0;
  }

  /** Start the inbound loop. Idempotent. */
  start() {
    if (this.timer || !this.active) return false;
    this.timer = setInterval(() => {
      this.tick().catch((error) => {
        this.logger?.warn('Operator gateway tick failed', { error: error.message });
      });
    }, this.pollIntervalMs);
    this.timer.unref();
    this.logger?.info('Operator interface listening (exclusive inbound owner)', {
      intervalMs: this.pollIntervalMs,
      routing: this.routing.map((p) => p.name),
      decisionOnly: this.decisionOnly.map((p) => p.name),
    });
    // Answer anything sent while the service was down, immediately.
    this.tick().catch(() => {});
    return true;
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One inbound round across every provider.
   *
   * @returns {Promise<{handled: number, resolved: object[]}>}
   */
  async tick() {
    let handled = 0;
    const resolved = [];

    for (const provider of this.routing) {
      let messages = [];
      try {
        // eslint-disable-next-line no-await-in-loop
        messages = await provider.fetchMessages();
      } catch (error) {
        this.logger?.warn('Inbound poll failed', { provider: provider.name, error: error.message });
        continue;
      }
      for (const message of messages) {
        // eslint-disable-next-line no-await-in-loop
        await this.deliver(provider, message);
        handled += 1;
      }
    }

    // Providers that only speak "decision": polled exactly as before M2.
    for (const provider of this.decisionOnly) {
      let decisions = [];
      try {
        // eslint-disable-next-line no-await-in-loop
        decisions = await provider.fetchDecisions();
      } catch (error) {
        this.logger?.warn('Approval provider poll failed', {
          provider: provider.name, error: error.message,
        });
        continue;
      }
      for (const { requestId, decision, note, by } of decisions) {
        const result = this.approvalManager.applyRemoteDecision({
          requestId, decision, note, by, via: provider.name,
        });
        if (result.ok) resolved.push(result.request);
      }
    }

    return { handled, resolved };
  }

  /**
   * Route one message and answer it.
   *
   * A failure to REPLY is logged but never retried: the command itself already
   * ran (or already refused), and re-running it to get the reply out would be
   * strictly worse than the owner missing one message — "/stop was applied
   * twice because the confirmation failed to send" is not a trade worth making.
   */
  async deliver(provider, message) {
    const { reply } = await this.router.handle({
      text: message.text,
      channel: provider.name,
      chatId: message.chatId,
      from: message.from,
    });
    if (!reply) return null;

    try {
      await provider.sendText(reply);
      this.events?.append({
        type: 'notification.sent',
        actor: `daemon:${provider.name}`,
        payload: { kind: 'operator-reply', chars: reply.length },
      });
    } catch (error) {
      this.logger?.warn('Could not send operator reply', {
        provider: provider.name, error: error.message,
      });
    }
    return reply;
  }

  /**
   * Push an unsolicited message to every routing channel (progress updates,
   * see missionMonitor.js). Best-effort, never throws — a dead channel must
   * not disturb supervision, the same contract the notification engine has
   * held since P0.
   *
   * @param {string} text
   * @returns {Promise<number>} How many channels accepted it.
   */
  async broadcast(text) {
    let sent = 0;
    await Promise.allSettled(this.routing.map(async (provider) => {
      try {
        await provider.sendText(text);
        sent += 1;
      } catch (error) {
        this.logger?.warn('Could not push an operator update', {
          provider: provider.name, error: error.message,
        });
      }
    }));
    if (sent) {
      this.events?.append({
        type: 'notification.sent',
        actor: 'daemon',
        payload: { kind: 'operator-push', channels: sent },
      });
    }
    return sent;
  }
}

export default OperatorGateway;
