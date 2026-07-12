/**
 * notificationEngine.js — Notification Engine.
 *
 * Listens to orchestrator domain events and fans them out to the enabled
 * channels (desktop, webhook, Discord, Telegram, email). Which events
 * notify, and through which channels, is entirely configuration-driven.
 *
 * Phase 10F: every event carries a severity ('info' | 'warning' |
 * 'critical'); a global `notifications.minSeverity` and per-channel
 * `minSeverity` filter what each channel receives — keep the desktop
 * chatty while only paging the phone on what matters. New events cover
 * approvals (10A), human-action pauses, verification failures, releases
 * (10J), and the daily/weekly summaries (10G).
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

/** Severity ranks (10F). Anything unlisted defaults to 'info'. */
export const SEVERITY_RANK = Object.freeze({ info: 0, warning: 1, critical: 2 });

/** Default severity per event. Overridable via config `notifications.eventSeverity`. */
export const EVENT_SEVERITY = Object.freeze({
  'session:launched': 'info',
  'session:rate-limited': 'warning',
  'session:network-error': 'warning',
  'session:crashed': 'warning',
  'session:resumed': 'info',
  'session:gave-up': 'critical',
  'mission:blocked': 'critical',
  'session:recovered': 'warning',
  'mission:complete': 'info',
  'orchestrator:recovered-after-reboot': 'warning',
  'approval:required': 'critical',
  'approval:resolved': 'info',
  'human-action:required': 'critical',
  'task:verification-failed': 'warning',
  'task:done': 'info',
  'release:created': 'info',
  'summary:daily': 'info',
  'summary:weekly': 'info',
});

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
  'mission:blocked': ({ project, reason, reportPath }) => ({
    title: `⛔ Blocked — ${project}`,
    message:
      `Stopped to avoid wasting usage: ${reason}` +
      (reportPath ? `\nDiagnostic report: ${reportPath}` : ''),
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
  // ── Phase 10 events ─────────────────────────────────────────────────────
  'approval:required': ({ project, request, title, message }) => ({
    title: title ?? `🔔 Approval required — ${project}`,
    message: truncate(message ?? `Request ${request?.id} (${request?.category}) awaits your decision.`, 1200),
  }),
  'approval:resolved': ({ project, request }) => ({
    title: `Approval ${request?.status} — ${project}`,
    message: `Request ${request?.id} (${request?.category}) was ${request?.status}` +
      (request?.decisionNote ? `: ${truncate(request.decisionNote, 200)}` : '.'),
  }),
  'human-action:required': ({ project, title, message, request }) => ({
    title: title ?? `🙋 Human action required — ${project}`,
    message: truncate(message ?? `Request ${request?.id} needs you to act, then reply DONE ${request?.id}.`, 1200),
  }),
  'task:verification-failed': ({ project, taskId, attempt, maxRuns, failedChecks }) => ({
    title: `Verification failed — ${project}`,
    message: `Task "${taskId}" attempt ${attempt}/${maxRuns} did not pass: ${truncate(failedChecks ?? '', 300)}`,
  }),
  'task:done': ({ project, taskId }) => ({
    title: `Task done — ${project}`,
    message: `Task "${taskId}" completed and verified.`,
  }),
  'release:created': ({ project, version, notesPath }) => ({
    title: `📦 Release prepared — ${project}`,
    message: `Version ${version} release notes and verification report are ready.` +
      (notesPath ? `\n${notesPath}` : ''),
  }),
  'summary:daily': ({ text }) => ({
    title: '📊 Daily summary — AI-Orchestrator',
    message: truncate(text ?? 'No activity recorded.', 1500),
  }),
  'summary:weekly': ({ text }) => ({
    title: '📊 Weekly summary — AI-Orchestrator',
    message: truncate(text ?? 'No activity recorded.', 1500),
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

    /** Phase 10F: global severity floor + per-event overrides. */
    this.minSeverity = config.minSeverity ?? 'info';
    this.eventSeverity = { ...EVENT_SEVERITY, ...(config.eventSeverity ?? {}) };

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
        const channel = new ChannelClass({ config: config[name], logger });
        // A channel may raise (never lower) its own severity floor.
        channel.minSeverity = config[name].minSeverity ?? null;
        this.channels.push(channel);
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

    // Phase 10F: severity filtering — global floor first, then per-channel.
    const severity = this.eventSeverity[event] ?? 'info';
    const rank = SEVERITY_RANK[severity] ?? 0;
    if (rank < (SEVERITY_RANK[this.minSeverity] ?? 0)) return;

    const { title, message } = render(payload);

    await Promise.allSettled(
      this.channels.map(async (channel) => {
        if (channel.minSeverity && rank < (SEVERITY_RANK[channel.minSeverity] ?? 0)) return;
        try {
          await channel.send({ title, message, event, payload, severity });
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
