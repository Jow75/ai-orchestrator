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

import fs from 'node:fs';
import { formatDuration } from '../infra/time.js';
import { renderMissionCardText } from './missionCard.js';
import DesktopChannel from './channels/desktop.js';
import WebhookChannel from './channels/webhook.js';
import DiscordChannel from './channels/discord.js';
import TelegramChannel from './channels/telegram.js';
import EmailChannel from './channels/email.js';

/** Severity ranks (10F). Anything unlisted defaults to 'info'. */
export const SEVERITY_RANK = Object.freeze({ info: 0, warning: 1, critical: 2 });

/**
 * Events the Approval Manager's own two-way providers (approvals.providers.
 * telegram/email) ACTUALLY publish themselves — just the initial request
 * (see `publish()` in telegramProvider.js/emailProvider.js). Phase 11 M2:
 * when a channel's matching approval provider is ALSO enabled, that channel
 * skips these two events by default — otherwise a single request sends two
 * near-identical messages (provider + channel) to the very same
 * chat/mailbox, which is exactly the "more than one message per approval"
 * duplication a live walkthrough found.
 *
 * Deliberately does NOT include 'approval:resolved': NEITHER provider ever
 * announces a resolution (only `publish()` exists — there is no "tell the
 * owner it was decided" call). A live M2 validation pass caught this: an
 * earlier version of this list included 'approval:resolved', which silently
 * suppressed the ONLY channel that ever announces a decision made out-of-
 * band (CLI/API/desktop) while the owner wasn't on Telegram — a real
 * regression, not a duplicate. A decision made THROUGH Telegram needs no
 * such echo (the owner's own reply already told them), but a decision made
 * elsewhere must still reach them.
 */
export const APPROVAL_PROVIDER_EVENTS = Object.freeze([
  'approval:required', 'human-action:required',
]);

/**
 * Where to find a REAL, attachable file for an event's payload — only
 * events with a STRUCTURED file reference qualify (not freeform agent
 * prose, which formatTelegramText already protects as text). When a
 * channel supports `sendDocument` (currently only Telegram) and the path
 * resolves to a real file, the actual artifact is attached as a follow-up
 * to the text notification — never just a bare filename mention.
 */
export const EVENT_ATTACHMENT = Object.freeze({
  'mission:blocked': (payload) => payload.reportPath ?? null,
  'release:created': (payload) => payload.notesPath ?? null,
});

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
  'mission:blocked': ({ project, reason, reportPath, card }) => ({
    title: `⛔ Blocked — ${project}`,
    // Phase 11 M2: an executive Mission Card (task/file/test/commit
    // summary + the operator's exact next command) when the orchestrator
    // supplied one; the diagnostic report is ALSO attached as a real file
    // (see EVENT_ATTACHMENT) for channels that support it, but its path is
    // still named here for channels that don't.
    message: card
      ? `${renderMissionCardText(card)}${reportPath ? `\nDiagnostic report: ${reportPath}` : ''}`
      : `Stopped to avoid wasting usage: ${reason}` + (reportPath ? `\nDiagnostic report: ${reportPath}` : ''),
  }),
  'session:recovered': ({ project, after }) => ({
    title: `Recovered — ${project}`,
    message: `Interrupted session found (${after}); resuming automatically.`,
  }),
  'mission:complete': ({ project, summary, card }) => ({
    title: `🎉 Mission complete — ${project}`,
    message: card
      ? `${renderMissionCardText(card)}\n\n${truncate(summary ?? '', 300)}`.trim()
      : truncate(summary ?? 'The mission is complete.', 400),
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
   * @param {import('./notificationState.js').NotificationState} [options.notificationState]
   *   Phase 11 M2: idempotency for events with a stable identity (approval/
   *   human-action requests). Absent ⇒ every notification is always sent —
   *   the pre-M2 behaviour, and what every existing caller/test still gets.
   * @param {object} [options.approvalsConfig] - The global `approvals`
   *   config block. Phase 11 M2: used ONLY to auto-derive, per channel,
   *   which events its matching approval provider already covers (see
   *   APPROVAL_PROVIDER_EVENTS). Omit (as every ad-hoc CLI-constructed
   *   engine — `notify test`/`notify resend` — deliberately does) to skip
   *   auto-exclusion entirely.
   */
  constructor({ config, logger, notificationState = null, approvalsConfig = null }) {
    this.config = config;
    this.logger = logger;
    this.notificationState = notificationState;
    this.reminderMs = config.reminderMs ?? 0;
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
        // Phase 11 M2: auto-exclude approval events this channel's own
        // provider already delivers; an operator can still name EXTRA
        // events to exclude via config[name].excludeEvents (merged, not
        // replaced) for any channel/event combination.
        const autoExcluded = ['telegram', 'email'].includes(name) && approvalsConfig?.providers?.[name]?.enabled
          ? APPROVAL_PROVIDER_EVENTS
          : [];
        channel.excludeEvents = [...new Set([...(config[name].excludeEvents ?? []), ...autoExcluded])];
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

    // Phase 11 M2: idempotency for events with a stable identity — never
    // resend the SAME approval notification just because a poll loop (or a
    // resumed process) noticed the request still exists.
    const key = dedupeKeyFor(event, payload);
    if (this.notificationState && !this.notificationState.shouldSend(payload.project, key, { reminderMs: this.reminderMs })) {
      this.logger.info('Notification suppressed (already sent; no reminder due)', {
        event, project: payload.project, key,
      });
      return;
    }

    const { title, message } = render(payload);

    // Phase 11 M2: a REAL, attachable file for this event (a structured
    // reportPath/notesPath, never freeform agent prose — see EVENT_ATTACHMENT).
    const attachmentPath = EVENT_ATTACHMENT[event]?.(payload) ?? null;
    const hasAttachment = attachmentPath && fs.existsSync(attachmentPath);

    const channelIds = {};
    let anySent = false;
    await Promise.allSettled(
      this.channels.map(async (channel) => {
        if (channel.excludeEvents?.includes(event)) return;
        if (channel.minSeverity && rank < (SEVERITY_RANK[channel.minSeverity] ?? 0)) return;
        try {
          const result = await channel.send({ title, message, event, payload, severity });
          anySent = true;
          if (result?.messageId) channelIds[channel.name] = result.messageId;
        } catch (error) {
          this.logger.warn('Notification channel failed', {
            channel: channel.name,
            event,
            error: error.message,
          });
          return; // don't attempt the attachment if the text itself failed
        }
        // Attach the real file as a follow-up — never just a bare filename
        // mention — when this channel supports it. Best-effort: a failed
        // attachment never undoes the text notification that already sent.
        if (hasAttachment && channel.sendDocument) {
          try {
            await channel.sendDocument({ filePath: attachmentPath, caption: title });
          } catch (error) {
            this.logger.warn('Attachment delivery failed; text notification still sent', {
              channel: channel.name, event, attachmentPath, error: error.message,
            });
          }
        }
      })
    );

    if (key) {
      this.notificationState?.recordSent(payload.project, key, {
        status: anySent ? 'sent' : 'failed', channelIds,
      });
    }
  }
}

function truncate(text, maxChars) {
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

/**
 * The dedupe key for an event, or null when the event has no stable
 * identity (most events — crash counts, rate-limit waits, etc. — are each
 * genuinely distinct occurrences and are never deduped). Approval/
 * human-action requests DO have a stable identity (the request id); the
 * "required" and "resolved" notifications for the SAME id use different
 * keys so each still fires once — that's a real state change, not a repeat.
 */
export function dedupeKeyFor(event, payload) {
  if (event === 'approval:required' || event === 'human-action:required') {
    return payload.request?.id ?? null;
  }
  if (event === 'approval:resolved') {
    return payload.request?.id ? `${payload.request.id}:resolved` : null;
  }
  return null;
}

export default NotificationEngine;
