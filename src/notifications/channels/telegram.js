/**
 * channels/telegram.js — Telegram bot channel.
 * Configure with a bot token (from @BotFather) and the target chat id.
 */

/** Abort a hung Telegram call after this long. */
const REQUEST_TIMEOUT_MS = 15_000;

export class TelegramChannel {
  constructor({ config, logger }) {
    this.name = 'telegram';
    this.config = config;
    this.logger = logger;
  }

  /** @param {{title: string, message: string}} notification */
  async send({ title, message }) {
    const { botToken, chatId } = this.config;
    if (!botToken || !chatId) {
      throw new Error('telegram channel enabled but "botToken"/"chatId" are not configured');
    }

    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: `${title}\n${message}`,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
    );

    if (!response.ok) {
      throw new Error(`Telegram API responded ${response.status}`);
    }
  }
}

export default TelegramChannel;
