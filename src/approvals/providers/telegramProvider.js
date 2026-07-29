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

import fs from 'node:fs';
import path from 'node:path';
import { ApprovalProvider, parseDecisionText } from './approvalProvider.js';
import { writeJsonAtomic, readJsonSafe } from '../../state/statePersistence.js';
import { escapeHtml, formatTelegramText } from '../../notifications/telegramFormat.js';
import { sendLongText } from '../../notifications/telegramSplit.js';
import { MAX_DOCUMENT_BYTES } from '../../notifications/channels/telegram.js';

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
    /** Phase 12 M2: this provider can hand back raw messages and reply. */
    this.canRoute = true;
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

  /**
   * @param {{title: string, message: string}} publication
   * @returns {Promise<{messageId?: string}>}
   */
  async publish({ title, message }) {
    this.requireConfig();
    // Phase 11 M2: same fix as the notification channel — HTML parse_mode
    // + formatTelegramText, so a plan/summary that mentions a filename
    // ("README.md") never renders as a dead link on the owner's phone.
    const text = `${escapeHtml(title)}\n\n${formatTelegramText(message)}`;
    // Phase 13 M1: one message when it fits, numbered continuations when it
    // doesn't — see notifications/telegramSplit.js.
    return sendLongText({ text, send: (part, opts) => this.postMessage(part, opts) });
  }

  /**
   * Send exactly one already-final message string.
   *
   * @param {string} text
   * @param {{plain?: boolean}} [options] - `plain: true` sends without
   *   `parse_mode` — the retry path when Telegram rejects an HTML payload.
   * @returns {Promise<{messageId?: string}>}
   */
  async postMessage(text, { plain = false } = {}) {
    const response = await this.fetchFn(this.api('sendMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: this.config.chatId,
        text,
        ...(plain ? {} : { parse_mode: 'HTML' }),
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Telegram API responded ${response.status}`);
    const body = await response.json().catch(() => ({}));
    const id = body?.result?.message_id;
    return { messageId: id != null ? String(id) : undefined };
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

  /**
   * Phase 12 M2: poll getUpdates and return every message from the owner's
   * chat, UNPARSED.
   *
   * This is the single read that consumes the offset. `fetchDecisions()` is
   * now implemented on top of it (below) so there is exactly one place that
   * advances the offset, whichever grammar the caller cares about — two
   * readers of an offset-acknowledged feed destroy each other's messages, and
   * that failure mode is the reason the Core Service exists at all.
   *
   * Only the configured `chatId` is honoured. A stranger messaging the bot is
   * dropped here, before any parsing, so no command surface added later can
   * accidentally become reachable by someone who is not the owner.
   *
   * @returns {Promise<{text: string, at: string, from: string, chatId: string, messageId: string}[]>}
   */
  async fetchMessages() {
    this.requireConfig();
    const offset = this.loadOffset();
    const response = await this.fetchFn(
      `${this.api('getUpdates')}?offset=${offset + 1}&timeout=0`,
      { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
    );
    if (!response.ok) throw new Error(`Telegram API responded ${response.status}`);
    const body = await response.json();
    if (!body.ok || !Array.isArray(body.result)) return [];

    const messages = [];
    let maxUpdateId = offset;
    for (const update of body.result) {
      maxUpdateId = Math.max(maxUpdateId, update.update_id ?? 0);
      const message = update.message ?? update.edited_message;
      if (!message?.text) continue;
      // Only the configured owner chat may say anything to this system.
      if (String(message.chat?.id) !== String(this.config.chatId)) continue;
      messages.push({
        text: message.text,
        at: message.date ? new Date(message.date * 1000).toISOString() : new Date().toISOString(),
        from: message.from?.username ?? 'telegram-owner',
        chatId: String(message.chat.id),
        messageId: String(message.message_id),
      });
    }
    if (maxUpdateId > offset) this.saveOffset(maxUpdateId);
    return messages;
  }

  /**
   * Poll for decision replies from the owner's chat.
   *
   * Unchanged in behaviour since Phase 10C — it still consumes the offset and
   * still returns only decision-shaped replies. It now derives them from
   * `fetchMessages()` so the parsing and the chat restriction live in one
   * place. This is the path a STANDALONE orchestrator (no daemon) still takes,
   * which is why it must keep working exactly as it always has.
   */
  async fetchDecisions() {
    const messages = await this.fetchMessages();
    const decisions = [];
    for (const message of messages) {
      const parsed = parseDecisionText(message.text);
      if (parsed) decisions.push({ ...parsed, by: message.from });
    }
    return decisions;
  }

  /**
   * Phase 12 M2.2: publish the command menu Telegram shows in the chat.
   *
   * SCOPED TO THE OWNER'S CHAT, not to the bot globally. The provider has
   * dropped every message from any other chat since Phase 10C
   * (`fetchMessages`), so a global menu would advertise a control surface to
   * strangers that the system would then refuse to honour — an invitation to
   * probe, and a misleading one. `BotCommandScopeChat` makes the menu match the
   * permission: the one person who can use these commands is the one person who
   * can see them.
   *
   * Best-effort by contract. A menu is a convenience; a failure to publish one
   * must never take down the inbound channel, so this reports rather than
   * throws — the caller decides whether anyone needs to hear about it.
   *
   * @param {{command: string, description: string}[]} commands - From
   *   operator/commandMenu.js. Built by the caller so this method stays a
   *   transport and the grammar stays the single source of the list.
   * @returns {Promise<{ok: boolean, count: number, error?: string}>}
   */
  async registerCommands(commands) {
    this.requireConfig();
    if (!Array.isArray(commands) || !commands.length) {
      return { ok: false, count: 0, error: 'no commands to register' };
    }
    try {
      const response = await this.fetchFn(this.api('setMyCommands'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commands,
          scope: { type: 'chat', chat_id: Number(this.config.chatId) || this.config.chatId },
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body?.ok === false) {
        // Telegram's `description` says exactly which entry it rejected, which
        // is the only useful thing to log — "HTTP 400" is not actionable.
        return { ok: false, count: 0, error: body?.description ?? `Telegram API responded ${response.status}` };
      }
      return { ok: true, count: commands.length };
    } catch (error) {
      return { ok: false, count: 0, error: error.message };
    }
  }

  /**
   * What Telegram currently shows for this chat.
   *
   * Used to skip a redundant write on every service start — the daemon starts
   * at every logon, and re-publishing an identical menu is a network call that
   * buys nothing. Returns null when the answer cannot be established, which the
   * caller must treat as "unknown", not as "empty": registering again is
   * harmless, whereas assuming a menu exists when it does not leaves the owner
   * without one forever.
   *
   * @returns {Promise<{command: string, description: string}[]|null>}
   */
  async fetchRegisteredCommands() {
    this.requireConfig();
    try {
      const response = await this.fetchFn(this.api('getMyCommands'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: { type: 'chat', chat_id: Number(this.config.chatId) || this.config.chatId },
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body?.ok === false || !Array.isArray(body?.result)) return null;
      return body.result;
    } catch {
      return null;
    }
  }

  /**
   * Phase 12 M2: reply in the owner's chat.
   *
   * Same HTML formatting as `publish()` and the notification channel, for the
   * same Phase 11 M2 reason: without it, a reply that merely mentions
   * "README.md" renders as a dead link on the owner's phone.
   *
   * @param {string} text
   * @returns {Promise<{messageId?: string}>}
   */
  async sendText(text) {
    this.requireConfig();
    // Phase 13 M1: one message when it fits, numbered continuations when it
    // doesn't — see notifications/telegramSplit.js.
    return sendLongText({
      text: formatTelegramText(text),
      send: (part, opts) => this.postMessage(part, opts),
    });
  }

  /**
   * Phase 13 M6: attach a real file directly, in reply to a `/file` or
   * `/download-project` command. Mirrors `channels/telegram.js`'s
   * `sendDocument()` exactly (same size ceiling, same multipart shape) —
   * per docs/PHASE_13_PLAN.md decision D4, this provider is where it
   * belongs rather than the one-way notification channel, because
   * `POST /api/operator/command` must see the identical `{reply, attachment}`
   * contract a phone gets, and only THIS provider serves that router.
   *
   * @param {{filePath: string, caption?: string}} attachment
   * @returns {Promise<{messageId?: string}>}
   * @throws If the file is missing, too large, or the API call fails.
   */
  async sendDocument({ filePath, caption }) {
    this.requireConfig();
    if (!fs.existsSync(filePath)) {
      throw new Error(`Cannot attach "${filePath}" — file not found.`);
    }
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_DOCUMENT_BYTES) {
      throw new Error(
        `Cannot attach "${filePath}" — ${stat.size} bytes exceeds Telegram's ${MAX_DOCUMENT_BYTES}-byte document limit.`
      );
    }

    const form = new FormData();
    form.set('chat_id', this.config.chatId);
    if (caption) form.set('caption', formatTelegramText(caption));
    if (caption) form.set('parse_mode', 'HTML');
    const buffer = fs.readFileSync(filePath);
    form.set('document', new Blob([buffer]), path.basename(filePath));

    const response = await this.fetchFn(this.api('sendDocument'), {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Telegram API responded ${response.status}`);
    const body = await response.json().catch(() => ({}));
    const id = body?.result?.message_id;
    return { messageId: id != null ? String(id) : undefined };
  }
}

export default TelegramApprovalProvider;
