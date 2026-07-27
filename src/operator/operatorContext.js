/**
 * operatorContext.js — Phase 12 M2: which project a remote channel is "in".
 *
 * The directive's Priority 2: `/project Remote Work` changes the active
 * context, and every later command applies to that project until it changes.
 * The selection must be REMEMBERED — a phone conversation that forgets which
 * project it is in between two messages is not a console, it is a form.
 *
 * Keyed by CHANNEL, not globally: `telegram:6522731464`. Today there is one
 * owner on one channel, so a single global value would work — but the whole
 * point of the M2 architecture is that Telegram is merely the first client.
 * When the desktop (M3) and a future Discord/web client attach, each needs its
 * own cursor, and retrofitting a key onto a global value later means migrating
 * a live file. Keying it now costs one string and forecloses that.
 *
 * Persisted at `state/operator/context.json` through the same atomic write as
 * every other piece of state. Absent `contextFile` ⇒ safe in-memory no-op.
 */

import { writeJsonAtomic, readJsonSafe } from '../state/statePersistence.js';

export class OperatorContext {
  /**
   * @param {object} options
   * @param {string} [options.contextFile] - state/operator/context.json.
   * @param {object} options.logger
   */
  constructor({ contextFile, logger }) {
    this.contextFile = contextFile;
    this.logger = logger;
    /** Fallback when no file is configured (tests, minimal harnesses). */
    this.memory = { channels: {} };
  }

  /** Compose the storage key for a channel + chat. */
  static key(channel, chatId) {
    return chatId ? `${channel}:${chatId}` : String(channel);
  }

  load() {
    if (!this.contextFile) return this.memory;
    return readJsonSafe(this.contextFile, { logger: this.logger }) ?? { channels: {} };
  }

  save(record) {
    if (!this.contextFile) {
      this.memory = record;
      return;
    }
    try {
      writeJsonAtomic(this.contextFile, record);
    } catch (error) {
      this.logger?.warn('Failed to persist operator context', { error: error.message });
    }
  }

  /**
   * The project this channel currently has selected, or null.
   *
   * @param {string} channel - e.g. 'telegram'.
   * @param {string|number} [chatId]
   * @returns {string|null}
   */
  activeProject(channel, chatId) {
    const record = this.load();
    return record.channels?.[OperatorContext.key(channel, chatId)]?.project ?? null;
  }

  /** The full context entry for a channel (project + when + by), or null. */
  get(channel, chatId) {
    return this.load().channels?.[OperatorContext.key(channel, chatId)] ?? null;
  }

  /**
   * Select a project for this channel.
   *
   * @param {string} channel
   * @param {string|number} chatId
   * @param {string} project
   * @param {string} [by] - Who selected it (audit trail).
   * @returns {{project: string, selectedAt: string, previous: string|null}}
   */
  select(channel, chatId, project, by) {
    const record = this.load();
    record.channels ??= {};
    const key = OperatorContext.key(channel, chatId);
    const previous = record.channels[key]?.project ?? null;
    record.channels[key] = {
      channel,
      chatId: chatId != null ? String(chatId) : null,
      project,
      selectedAt: new Date().toISOString(),
      ...(by ? { by } : {}),
    };
    this.save(record);
    return { project, selectedAt: record.channels[key].selectedAt, previous };
  }

  /** Forget this channel's selection (e.g. its project was removed). */
  clear(channel, chatId) {
    const record = this.load();
    const key = OperatorContext.key(channel, chatId);
    if (!record.channels?.[key]) return false;
    delete record.channels[key];
    this.save(record);
    return true;
  }

  /**
   * Drop any selection pointing at a project that no longer exists.
   *
   * Called when the registry is consulted, so a deleted project can never
   * leave a channel silently addressing something that isn't there — the
   * operator gets "no project selected" (actionable) instead of a confusing
   * "project not found" on every subsequent command.
   *
   * @param {string[]} validProjects
   * @returns {string[]} The channel keys that were cleared.
   */
  pruneMissing(validProjects) {
    const valid = new Set(validProjects);
    const record = this.load();
    const cleared = [];
    for (const [key, entry] of Object.entries(record.channels ?? {})) {
      if (entry?.project && !valid.has(entry.project)) {
        delete record.channels[key];
        cleared.push(key);
      }
    }
    if (cleared.length) this.save(record);
    return cleared;
  }

  /** Every channel with a selection (for the API / diagnostics). */
  all() {
    return Object.values(this.load().channels ?? {});
  }
}

export default OperatorContext;
