/**
 * notificationState.js — Phase 11 M2: per-notification idempotency.
 *
 * Machine-owned state at `state/notifications/<project>.json`, keyed by a
 * caller-supplied dedupe key. Today the only events with a stable identity
 * are approval/human-action requests (keyed by request id — the "required"
 * and "resolved" notifications for the same request use DIFFERENT keys, so
 * each still fires exactly once; that is a genuine state change, not a
 * duplicate). Events with no stable identity are never deduped here — see
 * `dedupeKeyFor` in notificationEngine.js.
 *
 * The guarantee (Phase 11 master prompt): once a notification for a given
 * key has been sent, it is never sent again UNLESS
 *   - the previous delivery failed (every channel errored that round), or
 *   - an explicit reminder interval has elapsed, or
 *   - the operator explicitly requests a resend (`notify resend`), or
 *   - the caller uses a different key because the underlying state changed.
 *
 * Fail-safe: no key, or no store configured, always allows sending —
 * silently dropping a genuinely new alert is worse than one extra send.
 */

import path from 'node:path';
import { writeJsonAtomic, readJsonSafe } from '../state/statePersistence.js';

export class NotificationState {
  /**
   * @param {object} options
   * @param {string} [options.notificationsDir] - state/notifications/.
   *   Absent ⇒ every method is a safe pass-through (always send).
   * @param {object} options.logger
   */
  constructor({ notificationsDir, logger }) {
    this.notificationsDir = notificationsDir;
    this.logger = logger;
  }

  file(project) {
    return path.join(this.notificationsDir, `${project}.json`);
  }

  /** The full per-key record map for a project (never null). */
  load(project) {
    if (!this.notificationsDir) return {};
    return readJsonSafe(this.file(project), { logger: this.logger }) ?? {};
  }

  save(project, record) {
    if (!this.notificationsDir) return;
    try {
      writeJsonAtomic(this.file(project), record);
    } catch (error) {
      this.logger.warn('Failed to persist notification state', { project, error: error.message });
    }
  }

  /**
   * Whether a notification for `key` should actually be sent right now.
   *
   * @param {string} project
   * @param {string|null|undefined} key - Dedupe key; falsy ⇒ always send.
   * @param {{reminderMs?: number}} [options]
   * @returns {boolean}
   */
  shouldSend(project, key, { reminderMs = 0 } = {}) {
    if (!key || !this.notificationsDir) return true;
    const entry = this.load(project)[key];
    if (!entry?.notificationSent) return true; // never sent (or explicitly reset — see forceResend)
    if (entry.status === 'failed') return true; // nothing was actually delivered last time
    if (reminderMs > 0) {
      const last = Date.parse(entry.lastReminder ?? entry.notificationTime ?? '');
      if (Number.isFinite(last) && Date.now() - last >= reminderMs) return true;
    }
    return false;
  }

  /**
   * Record the outcome of a send for `key`. `notificationTime` is set once
   * (the first successful/attempted send); `lastReminder` always advances,
   * so a later reminder interval is measured from the most recent send.
   *
   * @param {string} project
   * @param {string|null|undefined} key - No-op when falsy.
   * @param {{status: 'sent'|'failed', channelIds?: {telegram?: string, email?: string}}} outcome
   */
  recordSent(project, key, { status, channelIds = {} }) {
    if (!key || !this.notificationsDir) return;
    const record = this.load(project);
    const now = new Date().toISOString();
    const previous = record[key];
    record[key] = {
      notificationSent: true,
      notificationTime: previous?.notificationTime ?? now,
      lastReminder: now,
      status,
      telegramMessageId: channelIds.telegram ?? previous?.telegramMessageId ?? null,
      emailMessageId: channelIds.email ?? previous?.emailMessageId ?? null,
    };
    this.save(project, record);
  }

  /**
   * Operator-requested resend (`notify resend`): clears the sent flag so
   * the very next `notify()` call for this key is delivered, bypassing the
   * dedup entirely. A no-op if the key was never sent (nothing to resend).
   */
  forceResend(project, key) {
    if (!key || !this.notificationsDir) return;
    const record = this.load(project);
    if (record[key]) {
      record[key] = { ...record[key], notificationSent: false };
      this.save(project, record);
    }
  }
}

export default NotificationState;
