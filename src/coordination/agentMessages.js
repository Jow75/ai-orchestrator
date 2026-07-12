/**
 * agentMessages.js — Phase 10H: the cross-agent message bus.
 *
 * Phase 9's inter-agent "communication" was implicit: a downstream agent's
 * briefing carried the upstream checkpoint summary. This bus makes it
 * explicit and durable: addressed messages persisted per project at
 * `state/coordination/<project>.messages.json`, folded into the next
 * briefing of whichever agent they address, and postable by the
 * orchestrator (automatic task-handoff notes), the CLI (`agents message`),
 * and the API.
 *
 * Addressing: an agent id ('coder'), a role ('role:testing'), or 'all'.
 * Delivery is at-least-once into briefings: a message stays unread for an
 * agent until that agent's next launch consumes it (`markRead`). The log
 * is capped — this is working memory for a mission, not an archive (the
 * P5 MemoryStore is the archive).
 */

import path from 'node:path';
import { writeJsonAtomic, readJsonSafe } from '../state/statePersistence.js';

/** Keep at most this many messages per project. */
const MAX_MESSAGES = 200;

export class AgentMessageBus {
  /**
   * @param {object} options
   * @param {string} [options.coordinationDir] - Absent ⇒ safe no-op mode.
   * @param {object} options.logger
   */
  constructor({ coordinationDir, logger }) {
    this.coordinationDir = coordinationDir;
    this.logger = logger;
  }

  file(project) {
    return path.join(this.coordinationDir, `${project}.messages.json`);
  }

  load(project) {
    if (!this.coordinationDir) return null;
    return readJsonSafe(this.file(project), { logger: this.logger });
  }

  ensure(project) {
    const existing = this.load(project);
    if (existing) return existing;
    return { project, nextId: 1, messages: [] };
  }

  save(record) {
    if (!this.coordinationDir) return;
    try {
      writeJsonAtomic(this.file(record.project), record);
    } catch (error) {
      this.logger.warn('Failed to persist agent messages', {
        project: record.project, error: error.message,
      });
    }
  }

  /**
   * Post one message.
   *
   * @param {string} project
   * @param {{from: string, to: string, topic?: string, text: string}} message
   *   `to`: an agent id, 'role:<role>', or 'all'.
   * @returns {object|null} The stored message.
   */
  post(project, { from, to, topic, text }) {
    if (!this.coordinationDir) return null;
    const record = this.ensure(project);
    const message = {
      id: record.nextId,
      from,
      to,
      topic: topic ?? null,
      text,
      at: new Date().toISOString(),
      readBy: [],
    };
    record.nextId += 1;
    record.messages.push(message);
    if (record.messages.length > MAX_MESSAGES) {
      record.messages = record.messages.slice(-MAX_MESSAGES);
    }
    this.save(record);
    this.logger.info('Agent message posted', { project, from, to, topic });
    return message;
  }

  /**
   * Messages an agent has not yet consumed: addressed to it, its role, or
   * everyone — excluding what it sent itself.
   *
   * @param {string} project
   * @param {{agentId: string, role?: string}} recipient
   * @returns {object[]}
   */
  unreadFor(project, { agentId, role }) {
    const record = this.load(project);
    if (!record) return [];
    return record.messages.filter((m) =>
      m.from !== agentId
      && !m.readBy.includes(agentId)
      && (m.to === agentId || m.to === 'all' || (role && m.to === `role:${role}`)));
  }

  /** Mark messages consumed by an agent (they leave its future briefings). */
  markRead(project, messageIds, agentId) {
    const record = this.load(project);
    if (!record) return;
    let changed = false;
    for (const message of record.messages) {
      if (messageIds.includes(message.id) && !message.readBy.includes(agentId)) {
        message.readBy.push(agentId);
        changed = true;
      }
    }
    if (changed) this.save(record);
  }

  /** Every message for a project (API/CLI view). */
  list(project) {
    return this.load(project)?.messages ?? [];
  }
}

export default AgentMessageBus;
