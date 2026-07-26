/**
 * channels/telegram.js — Telegram bot channel.
 * Configure with a bot token (from @BotFather) and the target chat id.
 *
 * Phase 11 M2: messages are sent with `parse_mode: 'HTML'` and run through
 * `formatTelegramText` first — the fix for a confirmed live-walkthrough bug
 * where a bare mention of "README.md" rendered as a dead link (`.md` is
 * coincidentally also a ccTLD, and Telegram auto-linkifies unformatted
 * text). `sendDocument` attaches a REAL file directly — always preferred
 * over merely naming one in text when an actual file is available (see
 * notifications/attachments.js).
 */

import fs from 'node:fs';
import path from 'node:path';
import { escapeHtml, formatTelegramText } from '../telegramFormat.js';

/** Abort a hung Telegram call after this long. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Telegram's bot-API document size ceiling. */
export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

export class TelegramChannel {
  /**
   * @param {object} options
   * @param {object} options.config - { botToken, chatId }.
   * @param {object} options.logger
   * @param {Function} [options.fetchFn] - Injectable fetch (tests).
   */
  constructor({ config, logger, fetchFn }) {
    this.name = 'telegram';
    this.config = config;
    this.logger = logger;
    this.fetchFn = fetchFn ?? globalThis.fetch;
  }

  api(method) {
    return `https://api.telegram.org/bot${this.config.botToken}/${method}`;
  }

  requireConfig() {
    if (!this.config.botToken || !this.config.chatId) {
      throw new Error('telegram channel enabled but "botToken"/"chatId" are not configured');
    }
  }

  /**
   * @param {{title: string, message: string}} notification
   * @returns {Promise<{messageId?: string}>}
   */
  async send({ title, message }) {
    this.requireConfig();

    const response = await this.fetchFn(this.api('sendMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: this.config.chatId,
        text: `${escapeHtml(title)}\n${formatTelegramText(message)}`,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Telegram API responded ${response.status}`);
    }
    const body = await response.json().catch(() => ({}));
    const id = body?.result?.message_id;
    return { messageId: id != null ? String(id) : undefined };
  }

  /**
   * Attach a real file directly — the top of the file-sharing priority
   * (see the Phase 11 master prompt): never send a bare filename as text
   * when the actual artifact can be delivered instead.
   *
   * @param {{filePath: string, caption?: string}} attachment
   * @returns {Promise<{messageId?: string}>}
   * @throws If the file is missing, too large, or the API call fails —
   *   callers (see notifications/attachments.js) decide the text fallback.
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

    if (!response.ok) {
      throw new Error(`Telegram API responded ${response.status}`);
    }
    const body = await response.json().catch(() => ({}));
    const id = body?.result?.message_id;
    return { messageId: id != null ? String(id) : undefined };
  }
}

export default TelegramChannel;
