/**
 * approvalProvider.js — Phase 10C: the provider-independent approval
 * interface.
 *
 * Every remote approval channel (Telegram, email today; WhatsApp, Discord,
 * Slack, push notifications tomorrow) implements this same tiny surface, so
 * the Approval Manager never knows which product is on the other end:
 *
 *   name          A short id ('telegram', 'email', ...).
 *   canReceive    Whether the provider can carry decisions BACK. A
 *                 publish-only provider (email today) still notifies the
 *                 owner — the decision just arrives via another surface
 *                 (CLI, API, desktop, or a two-way provider).
 *   publish()     Deliver one approval request to the owner.
 *   fetchDecisions()  Poll for owner responses (two-way providers only).
 *                 Returns [{requestId, decision, note, by}] — decisions are
 *                 applied to the store by the Approval Manager, never here.
 *
 * Adding a future provider = subclass, implement publish() (and optionally
 * fetchDecisions()), register it in App. Nothing else changes.
 *
 * ── Phase 12 M2 additions ────────────────────────────────────────────────
 *
 *   canRoute      Whether the provider can hand back RAW owner messages, not
 *                 just parsed decisions. False for every provider that
 *                 predates M2, so nothing changes for them.
 *   fetchMessages()  Poll for everything the owner said, unparsed:
 *                 [{text, at, from, chatId, messageId}]. The Core Service
 *                 routes these through the operator grammar.
 *   sendText()    Reply in the same channel. Approvals only ever needed
 *                 publish(); a console needs to answer questions.
 *
 * WHY fetchMessages EXISTS AT ALL. `fetchDecisions()` parses each update and
 * DISCARDS anything that is not a decision — which was correct when the only
 * inbound grammar was "APPROVE A7", and became a bug the moment the owner
 * could type "/projects". Telegram's getUpdates is offset-acknowledged (see
 * telegramProvider.js), so a discarded message is gone forever, not merely
 * ignored. Widening the grammar therefore REQUIRED a single read that sees
 * every message once, and routes it once — which is exactly the "exactly one
 * inbound owner" rule M1 established, applied one level up.
 */

export class ApprovalProvider {
  /**
   * @param {object} options
   * @param {object} options.config - This provider's config block.
   * @param {object} options.logger - Module logger.
   */
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
    this.name = 'base';
    this.canReceive = false;
    /** Phase 12 M2: does this provider implement fetchMessages()/sendText()? */
    this.canRoute = false;
  }

  /**
   * Deliver one approval request to the owner.
   * @param {{request: object, title: string, message: string}} _publication
   */
  /* eslint-disable-next-line no-unused-vars */
  async publish(_publication) {
    throw new Error(`${this.name} provider does not implement publish()`);
  }

  /**
   * Poll for owner decisions. Two-way providers override this.
   * @returns {Promise<{requestId: string, decision: string, note?: string, by?: string}[]>}
   */
  async fetchDecisions() {
    return [];
  }

  /**
   * Phase 12 M2: poll for RAW owner messages. Routing providers override this.
   *
   * Every message the owner sent since the last call, already restricted to
   * the authorized sender — authorization is the provider's job because only
   * it knows what identity means on its own transport.
   *
   * @returns {Promise<{text: string, at?: string, from?: string, chatId?: string, messageId?: string}[]>}
   */
  async fetchMessages() {
    return [];
  }

  /**
   * Phase 12 M2: send a plain reply on this channel.
   * @param {string} _text
   */
  /* eslint-disable-next-line no-unused-vars */
  async sendText(_text) {
    throw new Error(`${this.name} provider does not implement sendText()`);
  }
}

/**
 * Parse one owner reply into a decision, shared by every text-based
 * provider so the reply grammar is identical everywhere:
 *
 *   APPROVE A7            approve request A7
 *   REJECT A7 too risky   reject, with an optional note
 *   MODIFY A7 skip step 3 approve with a modification note
 *   DONE A7               human action completed (10A human-interaction)
 *
 * Case-insensitive; a leading '/' (bot-command style) is tolerated.
 *
 * @param {string} text - The raw reply text.
 * @returns {{requestId: string, decision: string, note?: string}|null}
 */
export function parseDecisionText(text) {
  const match = (text ?? '').trim().match(/^\/?(approve|reject|modify|done)\s+(\S+)(?:\s+([\s\S]+))?$/i);
  if (!match) return null;
  const verb = match[1].toLowerCase();
  const decision = { approve: 'approved', reject: 'rejected', modify: 'modified', done: 'done' }[verb];
  return {
    requestId: match[2],
    decision,
    ...(match[3] ? { note: match[3].trim() } : {}),
  };
}

export default { ApprovalProvider, parseDecisionText };
