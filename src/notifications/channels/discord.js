/**
 * channels/discord.js — Discord webhook channel.
 * Configure with a Discord channel webhook URL
 * (Server Settings → Integrations → Webhooks → New Webhook).
 */

/** Abort a hung Discord call after this long. */
const REQUEST_TIMEOUT_MS = 15_000;

export class DiscordChannel {
  constructor({ config, logger }) {
    this.name = 'discord';
    this.config = config;
    this.logger = logger;
  }

  /** @param {{title: string, message: string}} notification */
  async send({ title, message }) {
    if (!this.config.webhookUrl) {
      throw new Error('discord channel enabled but "webhookUrl" is not configured');
    }

    const response = await fetch(this.config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: `**${title}**\n${message}` }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Discord webhook responded ${response.status}`);
    }
  }
}

export default DiscordChannel;
