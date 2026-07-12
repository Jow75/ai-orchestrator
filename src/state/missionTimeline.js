/**
 * missionTimeline.js — Human-facing Mission Timeline.
 *
 * The progress ledger is a dense, machine-oriented record of every run. The
 * timeline is its complement: a sparse, human-readable stream of the events
 * that matter when you glance at "what has this mission been doing?" —
 * started, progress, rate-limit, resumed, blocked, completed. It is the data
 * source for the future desktop UI's execution-timeline view.
 *
 *   22:01  Mission started
 *   22:08  Progress (confidence: high)
 *   22:09  Task "T1" done
 *   22:20  Rate limit — waiting until 03:01
 *   03:01  Resumed after usage limit
 *   03:18  Mission complete
 *
 * Decoupled by design: it subscribes to orchestrator domain events (exactly
 * like the notification engine), so it knows nothing about supervision
 * internals and is entirely engine-agnostic. Stored per project as
 * `state/timeline/<project>.jsonl`.
 */

import path from 'node:path';
import { appendJsonl, readJsonl } from './statePersistence.js';

export class MissionTimeline {
  /**
   * @param {object} options
   * @param {string} options.timelineDir - Directory for per-project timelines.
   * @param {object} options.logger - Module logger.
   */
  constructor({ timelineDir, logger }) {
    this.timelineDir = timelineDir;
    this.logger = logger;
  }

  timelineFile(project) {
    return path.join(this.timelineDir, `${project}.jsonl`);
  }

  /**
   * Subscribe to an orchestrator's events and record timeline entries.
   * @param {import('node:events').EventEmitter} orchestrator
   */
  attach(orchestrator) {
    orchestrator.on('session:recovered', ({ project, after }) =>
      this.record(project, 'recovered', `Recovered interrupted session (${after})`));

    orchestrator.on('session:launched', ({ project, resumed }) => {
      if (!resumed) this.record(project, 'mission-started', 'Mission started');
    });

    orchestrator.on('session:progress', ({ project, progressed, confidence }) => {
      // Only the positive, high-signal event is worth a timeline entry;
      // no-progress runs would just add noise (the ledger has them all).
      if (progressed) {
        this.record(project, 'progress', `Progress made (confidence: ${confidence ?? 'n/a'})`);
      }
    });

    orchestrator.on('session:rate-limited', ({ project, resumeAt }) =>
      this.record(project, 'rate-limit', `Rate limit — waiting until ${fmt(resumeAt)}`));

    orchestrator.on('session:network-error', ({ project }) =>
      this.record(project, 'network', 'Network problem — will retry'));

    orchestrator.on('session:crashed', ({ project, consecutiveCrashes }) =>
      this.record(project, 'crash', `Crashed (#${consecutiveCrashes}) — restarting`));

    orchestrator.on('session:resumed', ({ project, note }) => {
      // Record only resumes that followed a wait (limit/crash/network), not
      // every routine continue — keep the timeline high-signal.
      if (note && /usage limit|network|crash/i.test(note)) {
        this.record(project, 'resumed', capitalize(note));
      }
    });

    orchestrator.on('task:done', ({ project, taskId }) =>
      this.record(project, 'task-done', `Task "${taskId}" done`));

    orchestrator.on('mission:blocked', ({ project, reason }) =>
      this.record(project, 'blocked', `Blocked: ${reason}`));

    orchestrator.on('session:gave-up', ({ project, reason }) =>
      this.record(project, 'gave-up', `Gave up: ${reason}`));

    orchestrator.on('mission:complete', ({ project }) =>
      this.record(project, 'complete', 'Mission complete'));

    orchestrator.on('task:verification-failed', ({ project, taskId, attempt, maxRuns }) =>
      this.record(project, 'verify-failed', `Task "${taskId}" failed verification (attempt ${attempt}/${maxRuns})`));
  }

  /**
   * Phase 10A: subscribe to an Approval Manager so approval pauses and
   * decisions appear on the mission timeline alongside everything else.
   * @param {import('node:events').EventEmitter} approvalManager
   */
  attachApprovals(approvalManager) {
    approvalManager.on('approval:required', ({ project, request }) =>
      this.record(project, 'approval-required',
        `Approval required: ${request.id} (${request.category})`));

    approvalManager.on('human-action:required', ({ project, request }) =>
      this.record(project, 'human-action',
        `Human action required: ${request.id} (${request.category})`));

    approvalManager.on('approval:resolved', ({ project, request }) =>
      this.record(project, 'approval-resolved',
        `Approval ${request.id} ${request.status}` +
        (request.decisionNote ? ` — ${request.decisionNote}` : '')));
  }

  /**
   * Append a timeline entry.
   * @param {string} project
   * @param {string} event - Short machine tag (e.g. 'progress').
   * @param {string} label - Human-readable one-liner.
   * @param {object} [detail] - Optional structured extras.
   */
  record(project, event, label, detail) {
    try {
      appendJsonl(this.timelineFile(project), {
        at: new Date().toISOString(),
        event,
        label,
        ...(detail ? { detail } : {}),
      });
    } catch (error) {
      this.logger.warn('Failed to append timeline entry', {
        project, event, error: error.message,
      });
    }
  }

  /**
   * Read a project's timeline (oldest → newest).
   * @param {string} project
   * @returns {object[]}
   */
  read(project) {
    return readJsonl(this.timelineFile(project));
  }
}

function fmt(value) {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export default MissionTimeline;
