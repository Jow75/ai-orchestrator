/**
 * eventStore.js — Phase 12 M2: the durable, ordered event log.
 *
 * Append-only JSONL at `state/events/events.jsonl`. One line, one fact. This
 * is the spine the directive asks for: every interface becomes a READER of
 * this log rather than a participant in mission logic.
 *
 * Why JSONL and not the `writeJsonAtomic` whole-file rewrite every other store
 * here uses: those stores hold small, mutable, bounded documents (a task
 * queue, a lifecycle record). An event log is unbounded and append-only, and
 * rewriting the whole file per event would be O(n²) over a day of operation
 * and would lose the entire history to one bad write. It uses the same
 * `appendJsonl`/`readJsonl` primitives the mission timeline has used since P0
 * — a torn final line from a crash mid-append is skipped, rather than costing
 * the thousands of intact lines before it.
 *
 * SINGLE WRITER BY DESIGN. The daemon is the only process that appends. That
 * is not an incidental fact — it is what makes `seq` a real monotonic sequence
 * rather than a hopeful one, and it is the same "exactly one owner" principle
 * M1 established for the Telegram inbound channel. Mission workers deliberately
 * do NOT write events: they write the state files they always have, and the
 * daemon derives events from them (operator/missionMonitor.js). That keeps the
 * worker path byte-for-byte pre-Phase-12 and keeps this log ordered.
 *
 * Absent `eventsDir` ⇒ every method is a safe no-op returning empty results,
 * matching MemoryStore/ApprovalStore/MissionLifecycle: a hand-built harness
 * that predates this phase must never crash on a missing optional collaborator.
 */

import fs from 'node:fs';
import path from 'node:path';
import { appendJsonl, readJsonl } from '../state/statePersistence.js';
import { isKnownEventType } from './eventTypes.js';

/** Live log file name; archives are `events-<ISO-ish>.jsonl` beside it. */
export const LOG_FILENAME = 'events.jsonl';

/** Rotate once the live log passes this size (bytes). */
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/** How many events `read()`/`recent()` return when no limit is given. */
export const DEFAULT_LIMIT = 100;

export class EventStore {
  /**
   * @param {object} options
   * @param {string} [options.eventsDir] - state/events. Absent ⇒ no-op store.
   * @param {object} options.logger
   * @param {number} [options.maxBytes] - Rotation threshold.
   */
  constructor({ eventsDir, logger, maxBytes = DEFAULT_MAX_BYTES }) {
    this.eventsDir = eventsDir;
    this.logger = logger;
    this.maxBytes = maxBytes;
    this.listeners = new Set();
    /**
     * The next sequence number. Recovered from the log's last line at first
     * use, so a service restart continues the sequence instead of replaying
     * numbers a previous run already issued.
     */
    this.nextSeq = null;
  }

  /** Absolute path of the live log. */
  get file() {
    return this.eventsDir ? path.join(this.eventsDir, LOG_FILENAME) : null;
  }

  /**
   * Subscribe to events as they are appended, in this process.
   *
   * This is a convenience for the daemon's own collaborators (the operator
   * gateway wants to react now, not on the next poll). It is NOT the contract:
   * the file is. A subscriber that misses an event because it attached late
   * can always catch up with `read({sinceSeq})`.
   *
   * @param {(event: object) => void} listener
   * @returns {() => void} Unsubscribe.
   */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Recover the sequence counter from the tail of the live log. */
  loadSeq() {
    if (this.nextSeq !== null) return this.nextSeq;
    const last = this.readRaw().at(-1);
    this.nextSeq = (last?.seq ?? 0) + 1;
    return this.nextSeq;
  }

  /**
   * Append one fact.
   *
   * Never throws: an observability failure must not disturb supervision, the
   * same contract the timeline and lifecycle stores have held since P0. A
   * refused (unknown) type is logged and dropped rather than written, so a
   * typo can't quietly enter the permanent record.
   *
   * @param {object} event
   * @param {string} event.type - One of {@link import('./eventTypes.js').EVENT_TYPES}.
   * @param {string} [event.project] - The project this fact is about.
   * @param {string} [event.actor] - Who caused it ('telegram:owner', 'daemon', 'cli', …).
   * @param {object} [event.payload] - Type-specific detail.
   * @returns {object|null} The written event, or null when not written.
   */
  append({ type, project, actor, payload } = {}) {
    if (!this.eventsDir) return null;
    if (!isKnownEventType(type)) {
      this.logger?.warn('Refusing to append an unknown event type', { type });
      return null;
    }

    const event = {
      seq: this.loadSeq(),
      type,
      at: new Date().toISOString(),
      ...(project ? { project } : {}),
      ...(actor ? { actor } : {}),
      ...(payload !== undefined && payload !== null ? { payload } : {}),
    };

    try {
      this.rotateIfNeeded();
      appendJsonl(this.file, event);
      this.nextSeq = event.seq + 1;
    } catch (error) {
      this.logger?.warn('Failed to append event', { type, error: error.message });
      return null;
    }

    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger?.warn('Event listener failed', { type, error: error.message });
      }
    }
    return event;
  }

  /**
   * Move the live log aside once it grows past `maxBytes`.
   *
   * The archive keeps its sequence numbers, so the history stays orderable
   * across rotations even though `read()` only serves the live file (see the
   * class note on `read`).
   */
  rotateIfNeeded() {
    let size = 0;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return; // no file yet
    }
    if (size < this.maxBytes) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try {
      fs.renameSync(this.file, path.join(this.eventsDir, `events-${stamp}.jsonl`));
      this.logger?.info('Rotated the event log', { sizeBytes: size });
    } catch (error) {
      this.logger?.warn('Could not rotate the event log', { error: error.message });
    }
  }

  /**
   * Parse every intact line of the LIVE log. Torn lines are skipped by
   * `readJsonl`, never fatal.
   *
   * @returns {object[]}
   */
  readRaw() {
    if (!this.eventsDir) return [];
    try {
      return readJsonl(this.file).filter((event) => event && typeof event === 'object');
    } catch (error) {
      this.logger?.warn('Could not read the event log', { error: error.message });
      return [];
    }
  }

  /**
   * Query the log.
   *
   * Serves the LIVE file only. Rotated archives remain on disk for forensics
   * but are deliberately not merged in: this API exists to answer "what has
   * happened lately" for a phone and a dashboard, and silently walking an
   * unbounded archive set to answer it would make a cheap call arbitrarily
   * expensive. At the 5 MB default that is tens of thousands of recent events.
   *
   * @param {object} [query]
   * @param {number} [query.sinceSeq] - Exclusive: only events after this seq.
   * @param {string} [query.project] - Only this project's events.
   * @param {string[]} [query.types] - Only these types.
   * @param {number} [query.limit] - Most recent N of the matches.
   * @returns {object[]} Oldest first.
   */
  read({ sinceSeq, project, types, limit = DEFAULT_LIMIT } = {}) {
    const typeSet = types?.length ? new Set(types) : null;
    const matches = this.readRaw().filter((event) => {
      if (sinceSeq !== undefined && !(event.seq > sinceSeq)) return false;
      if (project && event.project !== project) return false;
      if (typeSet && !typeSet.has(event.type)) return false;
      return true;
    });
    return limit > 0 ? matches.slice(-limit) : matches;
  }

  /** The most recent `limit` events (oldest first), optionally per project. */
  recent(limit = DEFAULT_LIMIT, project) {
    return this.read({ limit, project });
  }

  /** The highest sequence number written, or 0 when the log is empty. */
  latestSeq() {
    return this.readRaw().at(-1)?.seq ?? 0;
  }
}

export default EventStore;
