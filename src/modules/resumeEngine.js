import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

export class ResumeEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.config = options.config || {};
    this.logger = options.logger || console;
    this.resumeDir = this.config.resumeDir || './resume';
    this.maxResumeAttempts = this.config.maxResumeAttempts || 5;
    this.resumeHistory = new Map();

    this.ensureResumeDir();
  }

  ensureResumeDir() {
    if (!fs.existsSync(this.resumeDir)) {
      fs.mkdirSync(this.resumeDir, { recursive: true });
    }
  }

  async saveResumePoint(sessionId, context) {
    const resumePoint = {
      sessionId,
      timestamp: new Date().toISOString(),
      context: {
        currentTask: context.currentTask,
        completedTasks: context.completedTasks || [],
        pendingTasks: context.pendingTasks || [],
        agentStates: context.agentStates || {},
        variables: context.variables || {},
        workingDirectory: context.workingDirectory || process.cwd()
      },
      metadata: {
        version: '1.0',
        orchestratorVersion: this.config.version || '1.0.0'
      }
    };

    const file = path.join(this.resumeDir, `${sessionId}-resume.json`);
    fs.writeFileSync(file, JSON.stringify(resumePoint, null, 2));

    this.resumeHistory.set(sessionId, resumePoint);
    this.emit('resume:saved', resumePoint);

    this.logger.debug('Resume point saved', { sessionId, file });
    return resumePoint;
  }

  async loadResumePoint(sessionId) {
    const file = path.join(this.resumeDir, `${sessionId}-resume.json`);

    if (!fs.existsSync(file)) {
      this.logger.warn('No resume point found', { sessionId });
      return null;
    }

    try {
      const content = fs.readFileSync(file, 'utf8');
      const resumePoint = JSON.parse(content);

      this.resumeHistory.set(sessionId, resumePoint);
      this.emit('resume:loaded', resumePoint);

      this.logger.info('Resume point loaded', { sessionId, timestamp: resumePoint.timestamp });
      return resumePoint;
    } catch (error) {
      this.logger.error('Failed to load resume point', { sessionId, error: error.message });
      throw error;
    }
  }

  async resume(driver, sessionId, options = {}) {
    this.logger.info('Starting resume process', { sessionId });

    const resumePoint = await this.loadResumePoint(sessionId);
    if (!resumePoint) {
      throw new Error(`No resume point found for session ${sessionId}`);
    }

    const attempt = this.getAttemptCount(sessionId);
    if (attempt >= this.maxResumeAttempts) {
      throw new Error(`Max resume attempts (${this.maxResumeAttempts}) reached for session ${sessionId}`);
    }

    this.recordAttempt(sessionId);

    try {
      this.emit('resume:starting', { sessionId, resumePoint, attempt });

      await driver.resume(sessionId, {
        ...resumePoint.context,
        resumeAttempt: attempt,
        ...options
      });

      this.emit('resume:success', { sessionId, attempt });
      this.logger.info('Resume successful', { sessionId, attempt });

      return { success: true, resumePoint, attempt };
    } catch (error) {
      this.emit('resume:failed', { sessionId, attempt, error });
      this.logger.error('Resume failed', { sessionId, attempt, error: error.message });
      throw error;
    }
  }

  async resumeWithBackoff(driver, sessionId, options = {}) {
    const baseDelay = options.baseDelay || 5000;
    const maxDelay = options.maxDelay || 300000;
    const maxAttempts = options.maxAttempts || this.maxResumeAttempts;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await this.resume(driver, sessionId, { ...options, attempt });
      } catch (error) {
        if (attempt < maxAttempts - 1) {
          const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
          this.logger.warn(`Resume attempt ${attempt + 1} failed, retrying in ${delay}ms`, {
            sessionId,
            error: error.message
          });
          await this.sleep(delay);
        } else {
          throw error;
        }
      }
    }
  }

  getAttemptCount(sessionId) {
    const history = this.resumeHistory.get(sessionId);
    return history ? (history.resumeAttempts || 0) + 1 : 0;
  }

  recordAttempt(sessionId) {
    const history = this.resumeHistory.get(sessionId) || { resumeAttempts: 0 };
    history.resumeAttempts = (history.resumeAttempts || 0) + 1;
    history.lastAttempt = new Date().toISOString();
    this.resumeHistory.set(sessionId, history);
  }

  canResume(sessionId) {
    const attempt = this.getAttemptCount(sessionId);
    return attempt <= this.maxResumeAttempts;
  }

  deleteResumePoint(sessionId) {
    const file = path.join(this.resumeDir, `${sessionId}-resume.json`);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
    this.resumeHistory.delete(sessionId);
    this.emit('resume:deleted', { sessionId });
  }

  listResumePoints() {
    if (!fs.existsSync(this.resumeDir)) return [];

    const files = fs.readdirSync(this.resumeDir)
      .filter(f => f.endsWith('-resume.json'))
      .map(f => f.replace('-resume.json', ''));

    return files.map(sessionId => {
      const point = this.resumeHistory.get(sessionId);
      return {
        sessionId,
        timestamp: point?.timestamp,
        hasContext: !!point?.context
      };
    });
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default ResumeEngine;