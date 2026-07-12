/**
 * missionScheduler.js — Phase 10G: scheduled missions.
 *
 * Missions that launch themselves: daily, weekly, one-shot ("once"), or
 * full cron schedules, defined in the user-editable `config/schedules.json`
 * and tracked in machine-owned `state/schedules.json`.
 *
 * The scheduler NEVER supervises anything itself — when a schedule is due
 * it spawns the real `bin/ai-orchestrator.js start <project>` as a
 * detached child (exactly how the desktop app starts missions), so every
 * supervision guarantee stays in one code path.
 *
 * Missed-schedule recovery: each schedule's due time is computed from the
 * LAST completed run (or when the schedule was first seen), so an occurrence
 * that passed while the machine slept is still due when the watcher wakes —
 * unless the schedule sets `recoverMissed: false`, in which case a run only
 * fires within `missedGraceMs` of its scheduled time.
 *
 * The `watch()` loop also owns the daily/weekly summary notifications
 * (config `notifications.summaries`) — they are just schedules whose
 * "mission" is building a digest and handing it to the notification engine.
 */

import path from 'node:path';
import { spawn } from 'node:child_process';
import { writeJsonAtomic, readJsonSafe } from '../state/statePersistence.js';
import { isPidAlive } from '../state/heartbeat.js';
import { sleep } from '../infra/time.js';
import { nextCronOccurrence, parseCron } from './cronExpression.js';

/** Schedule types supported by `nextOccurrence`. */
export const SCHEDULE_TYPES = Object.freeze(['daily', 'weekly', 'once', 'cron']);

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** Without `recoverMissed`, a due run only fires within this window. */
const DEFAULT_MISSED_GRACE_MS = 10 * 60_000;

export class MissionScheduler {
  /**
   * @param {object} options
   * @param {string} options.schedulesFile - config/schedules.json (user-owned).
   * @param {string} options.stateFile - state/schedules.json (machine-owned).
   * @param {string} [options.heartbeatFile] - To skip launching while an
   *   orchestrator already runs.
   * @param {string} options.rootDir - Installation root (locates the CLI).
   * @param {object} options.logger
   * @param {Function} [options.spawnFn] - Injectable process spawner (tests).
   * @param {import('../notifications/notificationEngine.js').NotificationEngine} [options.notifications]
   *   For summary digests; optional.
   * @param {Function} [options.buildSummary] - ({sinceMs}) => string, for
   *   the summary schedules (see activitySummary.js). Optional.
   */
  constructor({
    schedulesFile, stateFile, heartbeatFile, rootDir, logger,
    spawnFn, notifications, buildSummary,
  }) {
    this.schedulesFile = schedulesFile;
    this.stateFile = stateFile;
    this.heartbeatFile = heartbeatFile;
    this.rootDir = rootDir;
    this.logger = logger;
    this.spawnFn = spawnFn ?? defaultSpawn;
    this.notifications = notifications ?? null;
    this.buildSummary = buildSummary ?? null;
    this.summariesConfig = null; // set via configureSummaries()
  }

  /** Enable the daily/weekly digest schedules (config notifications.summaries). */
  configureSummaries(summariesConfig) {
    this.summariesConfig = summariesConfig ?? null;
  }

  // ── Definitions (user-owned config) ─────────────────────────────────────

  /** Load and validate schedule definitions. Invalid entries are reported, not run. */
  loadSchedules() {
    const raw = readJsonSafe(this.schedulesFile, { logger: this.logger });
    const entries = Array.isArray(raw) ? raw : (raw?.schedules ?? []);
    const schedules = [];
    const problems = [];
    const seen = new Set();
    for (const [i, entry] of entries.entries()) {
      const problem = validateSchedule(entry, `schedules[${i}]`, seen);
      if (problem) {
        problems.push(problem);
      } else {
        seen.add(entry.id);
        schedules.push({ enabled: true, recoverMissed: true, fresh: false, ...entry });
      }
    }
    if (problems.length) {
      this.logger.warn('Problems in schedules config (offending entries skipped)', { problems });
    }
    return { schedules, problems };
  }

  saveSchedules(schedules) {
    writeJsonAtomic(this.schedulesFile, { schedules });
  }

  /** Add one schedule (validated). Returns {ok, reason?}. */
  add(entry) {
    const { schedules } = this.loadSchedules();
    const problem = validateSchedule(entry, `schedule "${entry?.id}"`, new Set(schedules.map((s) => s.id)));
    if (problem) return { ok: false, reason: problem };
    schedules.push({ enabled: true, recoverMissed: true, fresh: false, ...entry });
    this.saveSchedules(schedules);
    return { ok: true };
  }

  /** Remove a schedule by id. */
  remove(id) {
    const { schedules } = this.loadSchedules();
    const remaining = schedules.filter((s) => s.id !== id);
    if (remaining.length === schedules.length) {
      return { ok: false, reason: `No schedule "${id}".` };
    }
    this.saveSchedules(remaining);
    return { ok: true };
  }

  /** Enable/disable a schedule by id. */
  setEnabled(id, enabled) {
    const { schedules } = this.loadSchedules();
    const schedule = schedules.find((s) => s.id === id);
    if (!schedule) return { ok: false, reason: `No schedule "${id}".` };
    schedule.enabled = enabled;
    this.saveSchedules(schedules);
    return { ok: true };
  }

  // ── Run state (machine-owned) ────────────────────────────────────────────

  loadState() {
    return readJsonSafe(this.stateFile, { logger: this.logger }) ?? {};
  }

  saveState(state) {
    try {
      writeJsonAtomic(this.stateFile, state);
    } catch (error) {
      this.logger.warn('Failed to persist scheduler state', { error: error.message });
    }
  }

  // ── Occurrence math ──────────────────────────────────────────────────────

  /**
   * The next occurrence of a schedule strictly after `after` (null when
   * none — e.g. a 'once' whose date has passed).
   */
  nextOccurrence(schedule, after = new Date()) {
    switch (schedule.type) {
      case 'daily': {
        const [h, m] = parseTime(schedule.time);
        const next = new Date(after);
        next.setHours(h, m, 0, 0);
        if (next <= after) next.setDate(next.getDate() + 1);
        return next;
      }
      case 'weekly': {
        const [h, m] = parseTime(schedule.time);
        const targetDay = WEEKDAYS.indexOf(String(schedule.day).toLowerCase());
        const next = new Date(after);
        next.setHours(h, m, 0, 0);
        while (next.getDay() !== targetDay || next <= after) {
          next.setDate(next.getDate() + 1);
          next.setHours(h, m, 0, 0);
        }
        return next;
      }
      case 'once': {
        const at = new Date(schedule.date);
        return at > after ? at : null;
      }
      case 'cron':
        return nextCronOccurrence(schedule.cron, after);
      default:
        return null;
    }
  }

  /**
   * Which schedules are due at `now`. Each due entry carries the occurrence
   * that made it due (`dueAt`), so missed occurrences surface exactly once.
   */
  dueRuns(now = new Date()) {
    const { schedules } = this.loadSchedules();
    const state = this.loadState();
    const due = [];
    let stateChanged = false;

    for (const schedule of schedules) {
      if (schedule.enabled === false) continue;
      const record = state[schedule.id] ?? {};

      // First sighting: anchor the schedule NOW — "recover missed" means
      // occurrences missed since the last run, not from before the
      // schedule existed.
      if (!record.lastRunAt && !record.firstSeenAt) {
        state[schedule.id] = { ...record, firstSeenAt: now.toISOString() };
        stateChanged = true;
        // A 'once' whose date already passed when first seen is still due
        // (the natural reading of "run this at <date>" configured late) —
        // handled below via anchor pick.
      }
      const anchor = new Date(
        state[schedule.id].lastRunAt
        ?? (schedule.type === 'once' ? 0 : state[schedule.id].firstSeenAt)
      );

      const occurrence = this.nextOccurrence(schedule, anchor);
      if (!occurrence || occurrence > now) continue;

      const lateMs = now.getTime() - occurrence.getTime();
      const grace = schedule.missedGraceMs ?? DEFAULT_MISSED_GRACE_MS;
      if (schedule.recoverMissed === false && lateMs > grace) {
        // Missed and not recoverable: skip forward so it doesn't stay due.
        state[schedule.id] = {
          ...state[schedule.id],
          lastRunAt: occurrence.toISOString(),
          lastOutcome: 'missed-not-recovered',
        };
        stateChanged = true;
        this.logger.warn('Missed schedule occurrence skipped (recoverMissed: false)', {
          id: schedule.id, occurrence: occurrence.toISOString(),
        });
        continue;
      }
      due.push({ schedule, dueAt: occurrence, lateMs });
    }

    if (stateChanged) this.saveState(state);
    return due;
  }

  /**
   * Launch everything due. An already-running orchestrator defers mission
   * launches (they stay due and fire when it's free); summaries send
   * regardless.
   *
   * @param {Date} [now]
   * @returns {Promise<{id: string, project?: string, action: string}[]>}
   */
  async runDue(now = new Date()) {
    const actions = [];
    const state = this.loadState();

    for (const { schedule, dueAt, lateMs } of this.dueRuns(now)) {
      if (this.orchestratorBusy()) {
        actions.push({ id: schedule.id, project: schedule.project, action: 'deferred-already-running' });
        this.logger.info('Schedule due but an orchestrator is already running; deferring', {
          id: schedule.id, project: schedule.project,
        });
        continue;
      }
      try {
        this.spawnFn({
          rootDir: this.rootDir,
          project: schedule.project,
          fresh: schedule.fresh === true,
        });
        state[schedule.id] = {
          ...(state[schedule.id] ?? {}),
          lastRunAt: now.toISOString(),
          lastDueAt: dueAt.toISOString(),
          lastOutcome: lateMs > (schedule.missedGraceMs ?? DEFAULT_MISSED_GRACE_MS)
            ? 'launched-recovered-missed'
            : 'launched',
        };
        actions.push({ id: schedule.id, project: schedule.project, action: 'launched' });
        this.logger.info('Scheduled mission launched', {
          id: schedule.id, project: schedule.project, dueAt: dueAt.toISOString(),
        });
      } catch (error) {
        state[schedule.id] = {
          ...(state[schedule.id] ?? {}),
          lastRunAt: now.toISOString(),
          lastOutcome: `launch-failed: ${error.message}`,
        };
        actions.push({ id: schedule.id, project: schedule.project, action: 'launch-failed' });
        this.logger.error('Scheduled mission failed to launch', {
          id: schedule.id, error: error.message,
        });
      }
    }
    this.saveState(state);

    actions.push(...await this.sendDueSummaries(now));
    return actions;
  }

  /** Daily/weekly digest notifications (config notifications.summaries). */
  async sendDueSummaries(now = new Date()) {
    if (!this.summariesConfig || !this.notifications || !this.buildSummary) return [];
    const actions = [];
    const state = this.loadState();

    const digests = [
      {
        key: '__summary-daily', event: 'summary:daily', sinceMs: 24 * 3_600_000,
        config: this.summariesConfig.daily,
        schedule: { type: 'daily', time: this.summariesConfig.daily?.time ?? '20:00' },
      },
      {
        key: '__summary-weekly', event: 'summary:weekly', sinceMs: 7 * 24 * 3_600_000,
        config: this.summariesConfig.weekly,
        schedule: {
          type: 'weekly',
          day: this.summariesConfig.weekly?.day ?? 'sunday',
          time: this.summariesConfig.weekly?.time ?? '18:00',
        },
      },
    ];

    for (const digest of digests) {
      if (!digest.config?.enabled) continue;
      const record = state[digest.key] ?? {};
      if (!record.lastRunAt && !record.firstSeenAt) {
        state[digest.key] = { firstSeenAt: now.toISOString() };
        continue;
      }
      const anchor = new Date(record.lastRunAt ?? record.firstSeenAt);
      const occurrence = this.nextOccurrence(digest.schedule, anchor);
      if (!occurrence || occurrence > now) continue;

      try {
        const text = this.buildSummary({ sinceMs: digest.sinceMs, now });
        // eslint-disable-next-line no-await-in-loop
        await this.notifications.notify(digest.event, { text });
        state[digest.key] = { ...record, lastRunAt: now.toISOString(), lastOutcome: 'sent' };
        actions.push({ id: digest.key, action: 'summary-sent' });
      } catch (error) {
        state[digest.key] = { ...record, lastRunAt: now.toISOString(), lastOutcome: `failed: ${error.message}` };
        this.logger.warn('Summary digest failed', { digest: digest.key, error: error.message });
      }
    }
    this.saveState(state);
    return actions;
  }

  /** Whether another orchestrator process is currently supervising. */
  orchestratorBusy() {
    if (!this.heartbeatFile) return false;
    const heartbeat = readJsonSafe(this.heartbeatFile, { logger: this.logger });
    return Boolean(heartbeat && heartbeat.state === 'running' && isPidAlive(heartbeat.pid));
  }

  /**
   * The watcher loop (`schedules watch`): check + launch on a cadence until
   * aborted. Returns only when the signal fires.
   */
  async watch({ intervalMs = 30_000, signal } = {}) {
    this.logger.info('Schedule watcher started', { intervalMs });
    for (;;) {
      if (signal?.aborted) return;
      // eslint-disable-next-line no-await-in-loop
      await this.runDue(new Date());
      // eslint-disable-next-line no-await-in-loop
      await sleep(intervalMs, signal);
      if (signal?.aborted) return;
    }
  }

  /** A combined definitions + state view for the CLI/API. */
  report(now = new Date()) {
    const { schedules, problems } = this.loadSchedules();
    const state = this.loadState();
    return {
      problems,
      schedules: schedules.map((s) => {
        const record = state[s.id] ?? {};
        const anchor = record.lastRunAt
          ? new Date(record.lastRunAt)
          : (s.type === 'once' ? new Date(0) : new Date(record.firstSeenAt ?? now));
        return {
          ...s,
          lastRunAt: record.lastRunAt ?? null,
          lastOutcome: record.lastOutcome ?? null,
          nextDueAt: this.nextOccurrence(s, anchor)?.toISOString() ?? null,
        };
      }),
    };
  }
}

/** Validate one schedule entry; returns a problem string or null. */
function validateSchedule(entry, label, seenIds) {
  if (!entry || typeof entry !== 'object') return `${label} must be an object.`;
  if (!entry.id || typeof entry.id !== 'string') return `${label}.id is required (a unique string).`;
  if (seenIds.has(entry.id)) return `${label}.id "${entry.id}" is not unique.`;
  if (!entry.project || typeof entry.project !== 'string') return `${label}.project is required.`;
  if (!SCHEDULE_TYPES.includes(entry.type)) {
    return `${label}.type "${entry.type}" is unknown. Use: ${SCHEDULE_TYPES.join(', ')}.`;
  }
  if ((entry.type === 'daily' || entry.type === 'weekly') && !/^\d{1,2}:\d{2}$/.test(entry.time ?? '')) {
    return `${label}.time must be "HH:MM" (24h) for ${entry.type} schedules.`;
  }
  if (entry.type === 'weekly' && !WEEKDAYS.includes(String(entry.day).toLowerCase())) {
    return `${label}.day must be a weekday name (${WEEKDAYS.join(', ')}).`;
  }
  if (entry.type === 'once' && Number.isNaN(new Date(entry.date).getTime())) {
    return `${label}.date must be a valid date/time for once schedules.`;
  }
  if (entry.type === 'cron') {
    try {
      parseCron(entry.cron);
    } catch (error) {
      return `${label}: ${error.message}`;
    }
  }
  return null;
}

/** "HH:MM" → [hours, minutes]. */
function parseTime(time) {
  const [h, m] = String(time).split(':').map(Number);
  return [h, m];
}

/** Default spawner: the real CLI, detached, exactly like the desktop app. */
function defaultSpawn({ rootDir, project, fresh }) {
  const args = [path.join(rootDir, 'bin', 'ai-orchestrator.js'), 'start', project];
  if (fresh) args.push('--fresh');
  const child = spawn(process.execPath, args, {
    cwd: rootDir,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

export default MissionScheduler;
