import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import Logger from '../utils/logger.js';

export class SessionManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.logger = options.logger || new Logger();
    this.config = options.config || {};
    this.sessions = new Map();
    this.currentSession = null;
    this.sessionDir = this.config.sessionDir || './sessions';
    this.autoSave = this.config.autoSave !== false;
    this.saveInterval = this.config.saveInterval || 30000;
    this.saveTimer = null;

    this.ensureSessionDir();
  }

  ensureSessionDir() {
    if (!fs.existsSync(this.sessionDir)) {
      fs.mkdirSync(this.sessionDir, { recursive: true });
    }
  }

  createSession(options = {}) {
    const session = {
      id: options.id || uuidv4(),
      name: options.name || `session-${Date.now()}`,
      project: options.project || 'default',
      status: 'created',
      createdAt: new Date(),
      updatedAt: new Date(),
      startedAt: null,
      endedAt: null,
      tasks: [],
      agents: [],
      metadata: options.metadata || {},
      context: options.context || {},
      checkpoints: []
    };

    this.sessions.set(session.id, session);
    this.emit('session:created', session);
    this.logger.info(`Session created: ${session.name} (${session.id})`);

    if (this.autoSave) {
      this.saveSession(session.id);
    }

    return session;
  }

  startSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    session.status = 'running';
    session.startedAt = new Date();
    session.updatedAt = new Date();
    this.currentSession = sessionId;

    this.emit('session:started', session);
    this.logger.info(`Session started: ${session.name}`);

    if (this.autoSave) {
      this.startAutoSave();
    }

    return session;
  }

  endSession(sessionId, status = 'completed') {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    session.status = status;
    session.endedAt = new Date();
    session.updatedAt = new Date();

    this.emit('session:ended', session);
    this.logger.info(`Session ended: ${session.name} (${status})`);

    if (this.currentSession === sessionId) {
      this.currentSession = null;
      this.stopAutoSave();
    }

    if (this.autoSave) {
      this.saveSession(sessionId);
    }

    return session;
  }

  pauseSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    session.status = 'paused';
    session.updatedAt = new Date();

    this.emit('session:paused', session);
    this.logger.info(`Session paused: ${session.name}`);

    return session;
  }

  resumeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    session.status = 'running';
    session.updatedAt = new Date();

    this.emit('session:resumed', session);
    this.logger.info(`Session resumed: ${session.name}`);

    return session;
  }

  addTask(sessionId, task) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    session.tasks.push({
      ...task,
      addedAt: new Date()
    });
    session.updatedAt = new Date();

    this.emit('session:task:added', { session, task });
    return session;
  }

  addAgent(sessionId, agentId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    if (!session.agents.includes(agentId)) {
      session.agents.push(agentId);
      session.updatedAt = new Date();
    }

    return session;
  }

  removeAgent(sessionId, agentId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    session.agents = session.agents.filter(id => id !== agentId);
    session.updatedAt = new Date();

    return session;
  }

  createCheckpoint(sessionId, label = 'checkpoint') {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const checkpoint = {
      id: uuidv4(),
      label,
      timestamp: new Date(),
      tasksCompleted: session.tasks.filter(t => t.status === 'completed').length,
      tasksTotal: session.tasks.length,
      context: { ...session.context }
    };

    session.checkpoints.push(checkpoint);
    session.updatedAt = new Date();

    this.emit('session:checkpoint', { session, checkpoint });
    this.logger.info(`Checkpoint created: ${label} for session ${session.name}`);

    if (this.autoSave) {
      this.saveSession(sessionId);
    }

    return checkpoint;
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  getCurrentSession() {
    if (this.currentSession) {
      return this.sessions.get(this.currentSession);
    }
    return null;
  }

  getAllSessions() {
    return Array.from(this.sessions.values());
  }

  getSessionsByProject(project) {
    return Array.from(this.sessions.values()).filter(s => s.project === project);
  }

  getSessionsByStatus(status) {
    return Array.from(this.sessions.values()).filter(s => s.status === status);
  }

  deleteSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    this.sessions.delete(sessionId);
    this.emit('session:deleted', session);
    this.logger.info(`Session deleted: ${session.name}`);

    const filePath = path.join(this.sessionDir, `${sessionId}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    return true;
  }

  saveSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const filePath = path.join(this.sessionDir, `${sessionId}.json`);
    const data = JSON.stringify(session, null, 2);
    fs.writeFileSync(filePath, data, 'utf8');

    this.emit('session:saved', session);
    return filePath;
  }

  loadSession(sessionId) {
    const filePath = path.join(this.sessionDir, `${sessionId}.json`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Session file not found: ${sessionId}`);
    }

    const data = fs.readFileSync(filePath, 'utf8');
    const session = JSON.parse(data);

    session.createdAt = new Date(session.createdAt);
    session.updatedAt = new Date(session.updatedAt);
    if (session.startedAt) session.startedAt = new Date(session.startedAt);
    if (session.endedAt) session.endedAt = new Date(session.endedAt);
    session.checkpoints = session.checkpoints.map(cp => ({
      ...cp,
      timestamp: new Date(cp.timestamp)
    }));

    this.sessions.set(sessionId, session);
    this.emit('session:loaded', session);
    this.logger.info(`Session loaded: ${session.name}`);

    return session;
  }

  loadAllSessions() {
    if (!fs.existsSync(this.sessionDir)) return [];

    const files = fs.readdirSync(this.sessionDir).filter(f => f.endsWith('.json'));
    const loaded = [];

    for (const file of files) {
      const sessionId = file.replace('.json', '');
      try {
        this.loadSession(sessionId);
        loaded.push(sessionId);
      } catch (error) {
        this.logger.error(`Failed to load session ${sessionId}`, { error: error.message });
      }
    }

    return loaded;
  }

  startAutoSave() {
    if (this.saveTimer) return;

    this.saveTimer = setInterval(() => {
      if (this.currentSession) {
        this.saveSession(this.currentSession);
      }
    }, this.saveInterval);
  }

  stopAutoSave() {
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
      this.saveTimer = null;
    }
  }

  getStats() {
    const sessions = Array.from(this.sessions.values());
    return {
      total: sessions.length,
      running: sessions.filter(s => s.status === 'running').length,
      completed: sessions.filter(s => s.status === 'completed').length,
      failed: sessions.filter(s => s.status === 'failed').length,
      paused: sessions.filter(s => s.status === 'paused').length,
      current: this.currentSession
    };
  }

  async shutdown() {
    this.stopAutoSave();

    if (this.currentSession) {
      this.endSession(this.currentSession, 'interrupted');
    }

    for (const sessionId of this.sessions.keys()) {
      this.saveSession(sessionId);
    }

    this.emit('shutdown');
  }
}

export default SessionManager;