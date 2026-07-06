/**
 * sessionManager.js — Session Manager.
 *
 * A "session" is one mission-in-progress for one project: it spans every
 * launch, crash, rate-limit wait, and resume until the mission completes.
 * Session records are the memory that makes resume-after-anything possible;
 * they must survive process death, power loss, and reboots.
 *
 * Storage:
 *   state/sessions/<project>.json          The active session for a project
 *   state/sessions/<project>.history.jsonl Finished sessions, one per line
 */

import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  writeJsonAtomic,
  readJsonSafe,
  appendJsonl,
  readJsonl,
} from './statePersistence.js';

/** Lifecycle states a session record can be in. */
export const SessionState = Object.freeze({
  RUNNING: 'running',
  WAITING_RATE_LIMIT: 'waiting-rate-limit',
  WAITING_RETRY: 'waiting-retry',
  COMPLETED: 'completed',
  STOPPED: 'stopped',
  GAVE_UP: 'gave-up',
  /**
   * The mission cannot make progress (a loop was detected, or the agent is
   * blocked, e.g. a permission it lacks). Unlike GAVE_UP, BLOCKED is NOT
   * auto-resumable: continuing would re-enter the same futile loop. The
   * session is archived with a diagnostic report; the operator fixes the
   * blocker, and the next start begins a clean session.
   */
  BLOCKED: 'blocked',
});

/**
 * Session states that mean "there is unfinished work to pick back up".
 * GAVE_UP is included deliberately: giving up stops the current process but
 * never abandons the mission — the next start resumes the same conversation.
 */
export const RESUMABLE_STATES = Object.freeze([
  SessionState.RUNNING,
  SessionState.WAITING_RATE_LIMIT,
  SessionState.WAITING_RETRY,
  SessionState.GAVE_UP,
]);

export class SessionManager {
  /**
   * @param {object} options
   * @param {string} options.sessionsDir - Directory for session records.
   * @param {object} options.logger - Module logger.
   */
  constructor({ sessionsDir, logger }) {
    this.sessionsDir = sessionsDir;
    this.logger = logger;
  }

  activeFile(project) {
    return path.join(this.sessionsDir, `${project}.json`);
  }

  historyFile(project) {
    return path.join(this.sessionsDir, `${project}.history.jsonl`);
  }

  /**
   * Create a brand-new session record for a project.
   *
   * @param {string} project - Project name.
   * @param {string} driver - Driver id (e.g. 'claude').
   * @returns {object} The new session record.
   */
  createSession(project, driver) {
    const now = new Date().toISOString();
    const session = {
      id: crypto.randomUUID(),
      project,
      driver,
      state: SessionState.RUNNING,
      /** The engine's own conversation id (Claude session_id) — set on first launch. */
      engineSessionId: null,
      createdAt: now,
      updatedAt: now,
      /** Counters for the status system and post-mortems. */
      runs: 0,
      resumes: 0,
      crashes: 0,
      rateLimits: 0,
      /** Set while waiting out a usage limit. */
      resumeAt: null,
      /** Short human-readable note about the latest activity. */
      lastActivity: 'created',
      /** Classification of the most recent exit (see exitClassifier). */
      lastExit: null,
      /** Progress tracking (see src/progress/, src/core/loopBreaker.js). */
      lastSignature: null,
      consecutiveNoProgress: 0,
    };
    this.save(session);
    this.logger.info('Session created', { project, sessionId: session.id });
    return session;
  }

  /**
   * Return the active session for a project, or null when there is none.
   *
   * @param {string} project - Project name.
   * @returns {object|null}
   */
  getActiveSession(project) {
    return readJsonSafe(this.activeFile(project), { logger: this.logger });
  }

  /**
   * Return the active session only if it has unfinished work to resume.
   * Used on startup for crash/reboot recovery.
   *
   * @param {string} project - Project name.
   * @returns {object|null}
   */
  getResumableSession(project) {
    const session = this.getActiveSession(project);
    if (session && RESUMABLE_STATES.includes(session.state)) return session;
    return null;
  }

  /**
   * Apply a patch to a session and persist it atomically.
   *
   * @param {object} session - Session record (mutated in place).
   * @param {object} patch - Fields to update.
   * @returns {object} The updated session.
   */
  update(session, patch) {
    Object.assign(session, patch, { updatedAt: new Date().toISOString() });
    this.save(session);
    return session;
  }

  /** Persist a session record atomically. */
  save(session) {
    writeJsonAtomic(this.activeFile(session.project), session);
  }

  /**
   * Close a session: archive it to history and clear the active slot.
   *
   * @param {object} session - Session record.
   * @param {string} finalState - One of SessionState.{COMPLETED,STOPPED,GAVE_UP}.
   */
  closeSession(session, finalState) {
    this.update(session, { state: finalState });
    appendJsonl(this.historyFile(session.project), session);
    fs.rmSync(this.activeFile(session.project), { force: true });
    this.logger.info('Session closed', {
      project: session.project,
      sessionId: session.id,
      finalState,
      runs: session.runs,
      resumes: session.resumes,
      crashes: session.crashes,
      rateLimits: session.rateLimits,
    });
  }

  /**
   * All projects that currently have an active session on disk.
   *
   * @returns {object[]} Active session records.
   */
  listActiveSessions() {
    if (!fs.existsSync(this.sessionsDir)) return [];
    return fs
      .readdirSync(this.sessionsDir)
      .filter((f) => f.endsWith('.json') && !f.includes('.corrupt-'))
      .map((f) => readJsonSafe(path.join(this.sessionsDir, f), { logger: this.logger }))
      .filter(Boolean);
  }

  /**
   * Read a project's session history (most recent last).
   *
   * @param {string} project - Project name.
   * @returns {object[]}
   */
  getHistory(project) {
    return readJsonl(this.historyFile(project));
  }
}

export default SessionManager;
