/**
 * telegramProvider.js — Phase 10C: two-way Telegram approval provider.
 *
 * Publishes approval requests through the same bot API the Telegram
 * notification channel uses, and POLLS for owner replies via `getUpdates`
 * (long-poll offset persisted at `state/approvals/telegram.offset` so a
 * restart never re-processes old replies). Replies use the shared grammar
 * from approvalProvider.js: "APPROVE A7", "REJECT A7 note", "MODIFY A7
 * note", "DONE A7".
 *
 * Only messages from the configured `chatId` are honored — a stranger
 * messaging the bot cannot approve anything.
 */

import { ApprovalProvider, parseDecisionText } from './approvalProvider.js';
import { writeJsonAtomic, readJsonSafe } from '../../state/statePersistence.js';

/** Abort a hung Telegram call after this long. */
const REQUEST_TIMEOUT_MS = 15_000;

export class TelegramApprovalProvider extends ApprovalProvider {
  /**
   * @param {object} options
   * @param {object} options.config - { botToken, chatId }.
   * @param {object} options.logger
   * @param {string} [options.offsetFile] - Where the getUpdates offset is
   *   persisted. Absent ⇒ offset kept in memory only (tests).
   * @param {Function} [options.fetchFn] - Injectable fetch (tests).
   */
  constructor({ config, logger, offsetFile, fetchFn }) {
    super({ config, logger });
    this.name = 'telegram';
    this.canReceive = true;
    this.offsetFile = offsetFile;
    this.fetchFn = fetchFn ?? globalThis.fetch;
    this.memoryOffset = 0;
  }

  api(method) {
    return `https://api.telegram.org/bot${this.config.botToken}/${method}`;
  }

  requireConfig() {
    if (!this.config.botToken || !this.config.chatId) {
      throw new Error('telegram approval provider needs "botToken" and "chatId"');
    }
  }

  /** @param {{title: string, message: string}} publication */
  async publish({ title, message }) {
    this.requireConfig();
    const response = await this.fetchFn(this.api('sendMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: this.config.chatId, text: `${title}\n\n${message}` }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Telegram API responded ${response.status}`);
  }

  loadOffset() {
    if (!this.offsetFile) return this.memoryOffset;
    return readJsonSafe(this.offsetFile, { logger: this.logger })?.offset ?? 0;
  }

  saveOffset(offset) {
    this.memoryOffset = offset;
    if (!this.offsetFile) return;
    try {
      writeJsonAtomic(this.offsetFile, { offset });
    } catch (error) {
      this.logger.warn('Failed to persist Telegram update offset', { error: error.message });
    }
  }

  /** Poll getUpdates and parse decision replies from the owner's chat. */
  async fetchDecisions() {
    this.requireConfig();
    const offset = this.loadOffset();
    const response = await this.fetchFn(
      `${this.api('getUpdates')}?offset=${offset + 1}&timeout=0`,
      { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
    );
    if (!response.ok) throw new Error(`Telegram API responded ${response.status}`);
    const body = await response.json();
    if (!body.ok || !Array.isArray(body.result)) return [];

    const decisions = [];
    let maxUpdateId = offset;
    for (const update of body.result) {
      maxUpdateId = Math.max(maxUpdateId, update.update_id ?? 0);
      const message = update.message ?? update.edited_message;
      if (!message?.text) continue;
      // Only the configured owner chat may decide anything.
      if (String(message.chat?.id) !== String(this.config.chatId)) continue;
      const parsed = parseDecisionText(message.text);
      if (parsed) {
        decisions.push({ ...parsed, by: message.from?.username ?? 'telegram-owner' });
      }
    }
    if (maxUpdateId > offset) this.saveOffset(maxUpdateId);
    return decisions;
  }
}

export default TelegramApprovalProvider;
