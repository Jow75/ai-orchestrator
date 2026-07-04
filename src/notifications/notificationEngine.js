/**
 * notificationEngine.js — Notification Engine.
 *
 * Listens to orchestrator domain events and fans them out to the enabled
 * channels (desktop, webhook, Discord, Telegram, email). Which events
 * notify, and through which channels, is entirely configuration-driven.
 *
 * Channel failures are logged and swallowed: a dead webhook must never
 * disturb supervision.
 */

import { formatDuration } from '../infra/time.js';
import DesktopChannel from './channels/desktop.js';
import WebhookChannel from './channels/webhook.js';
import DiscordChannel from './channels/discord.js';
import TelegramChannel from './channels/telegram.js';
import EmailChannel from './channels/email.js';

/** How each orchestrator event renders as a human notification. */
const EVENT_MESSAGES = {
  'session:launched': ({ project, resumed, pid }) => ({
    title: `AI-Orchestrator — ${project}`,
    message: `${resumed ? 'Resumed' : 'Launched'} agent session (pid ${pid}).`,
  }),
  'session:rate-limited': ({ project, resumeAt, waitMs }) => ({
    title: `Usage limit — ${project}`,
    message: `Agent hit its usage limit. Waiting ${formatDuration(waitMs)}; auto-resume at ${new Date(resumeAt).toLocaleString()}.`,
  }),
  'session:network-error': ({ project, retryInMs }) => ({
    title: `Network problem — ${project}`,
    message: `Run failed on a network error. Retrying in ${formatDuration(retryInMs)}.`,
  }),
  'session:crashed': ({ project, consecutiveCrashes, restartInMs }) => ({
    title: `Agent crashed — ${project}`,
    message: `Crash #${consecutiveCrashes}. Restarting in ${formatDuration(restartInMs)}.`,
  }),
  'session:resumed': ({ project }) => ({
    title: `Resumed — ${project}`,
    message: 'Session resumed; the mission continues.',
  }),
  'session:gave-up': ({ project, reason }) => ({
    title: `Needs attention — ${project}`,
    message: `Supervision stopped: ${reason}`,
  }),
  'session:recovered': ({ project, after }) => ({
    title: `Recovered — ${project}`,
    message: `Interrupted session found (${after}); resuming automatically.`,
  }),
  'mission:complete': ({ project, summary }) => ({
    title: `🎉 Mission complete — ${project}`,
    message: truncate(summary ?? 'The mission is complete.', 400),
  }),
  'orchestrator:recovered-after-reboot': ({ project }) => ({
    title: 'AI-Orchestrator recovered',
    message: `Unclean shutdown detected (reboot/power loss). Resuming ${project ?? 'the interrupted mission'}.`,
  }),
};

export class NotificationEngine {
  /**
   * @param {object} options
   * @param {object} options.config - The `notifications` config block.
   * @param {object} options.logger - Module logger.
   */
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
    this.subscribedEvents = new Set(config.events ?? []);

    /** Only channels enabled in config are constructed at all. */
    this.channels = [];
    const channelClasses = {
      desktop: DesktopChannel,
      webhook: WebhookChannel,
      discord: DiscordChannel,
      telegram: TelegramChannel,
      email: EmailChannel,
    };
    for (const [name, ChannelClass] of Object.entries(channelClasses)) {
      if (config[name]?.enabled) {
        this.channels.push(new ChannelClass({ config: config[name], logger }));
      }
    }

    this.logger.info('Notification engine ready', {
      channels: this.channels.map((c) => c.name),
      events: [...this.subscribedEvents],
    });
  }

  /**
   * Subscribe to every notifiable event on an emitter (the orchestrator).
   *
   * @param {import('node:events').EventEmitter} emitter
   */
  attach(emitter) {
    for (const event of Object.keys(EVENT_MESSAGES)) {
      emitter.on(event, (payload) => {
        if (this.subscribedEvents.has(event)) {
          this.notify(event, payload);
        }
      });
    }
  }

  /**
   * Send one notification through every enabled channel (best-effort).
   *
   * @param {string} event - Orchestrator event name.
   * @param {object} payload - Event payload.
   */
  async notify(event, payload) {
    const render = EVENT_MESSAGES[event];
    if (!render) return;
    const { title, message } = render(payload);

    await Promise.allSettled(
      this.channels.map(async (channel) => {
        try {
          await channel.send({ title, message, event, payload });
        } catch (error) {
          this.logger.warn('Notification channel failed', {
            channel: channel.name,
            event,
            error: error.message,
          });
        }
      })
    );
  }
}

function truncate(text, maxChars) {
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

export default NotificationEngine;
