import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import Logger from '../utils/logger.js';

export class StatusManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.logger = options.logger || new Logger();
    this.config = options.config || {};
    this.statusFile = this.config.statusFile || './status.json';
    this.updateInterval = this.config.updateInterval || 5000;
    this.status = this.getDefaultStatus();
    this.updateTimer = null;
    this.subscribers = new Set();

    this.ensureStatusFile();
    this.loadStatus();
  }

  getDefaultStatus() {
    return {
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      orchestrator: {
        status: 'stopped',
        uptime: 0,
        startedAt: null,
        pid: process.pid
      },
      agents: {
        total: 0,
        idle: 0,
        busy: 0,
        error: 0,
        byType: {}
      },
      tasks: {
        queued: 0,
        processing: 0,
        completed: 0,
        failed: 0,
        totalSubmitted: 0
      },
      sessions: {
        active: 0,
        total: 0
      },
      system: {
        memory: process.memoryUsage(),
        cpu: process.cpuUsage(),
        platform: process.platform,
        nodeVersion: process.version
      },
      health: {
        status: 'unknown',
        checks: {}
      },
      metrics: {
        tasksPerMinute: 0,
        avgTaskDuration: 0,
        errorRate: 0
      }
    };
  }

  ensureStatusFile() {
    const dir = path.dirname(this.statusFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  loadStatus() {
    if (fs.existsSync(this.statusFile)) {
      try {
        const data = fs.readFileSync(this.statusFile, 'utf8');
        const saved = JSON.parse(data);
        this.status = { ...this.getDefaultStatus(), ...saved };
        this.logger.debug('Status loaded from file');
      } catch (error) {
        this.logger.warn('Failed to load status file', { error: error.message });
      }
    }
  }

  saveStatus() {
    this.status.timestamp = new Date().toISOString();
    this.status.system.memory = process.memoryUsage();
    this.status.system.cpu = process.cpuUsage();

    try {
      const data = JSON.stringify(this.status, null, 2);
      fs.writeFileSync(this.statusFile, data, 'utf8');
    } catch (error) {
      this.logger.error('Failed to save status', { error: error.message });
    }
  }

  startUpdates() {
    if (this.updateTimer) return;

    this.updateTimer = setInterval(() => {
      this.saveStatus();
      this.notifySubscribers();
    }, this.updateInterval);

    this.logger.debug('Status updates started');
  }

  stopUpdates() {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
    this.logger.debug('Status updates stopped');
  }

  notifySubscribers() {
    for (const callback of this.subscribers) {
      try {
        callback(this.getStatus());
      } catch (error) {
        this.logger.error('Subscriber notification failed', { error: error.message });
      }
    }
  }

  subscribe(callback) {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  getStatus() {
    return { ...this.status };
  }

  setOrchestratorStatus(status, data = {}) {
    this.status.orchestrator.status = status;
    this.status.orchestrator.uptime = data.uptime || 0;
    this.status.orchestrator.startedAt = data.startedAt || this.status.orchestrator.startedAt;

    if (status === 'running' && !this.status.orchestrator.startedAt) {
      this.status.orchestrator.startedAt = new Date().toISOString();
    }

    this.emit('orchestrator:status', this.status.orchestrator);
  }

  updateAgentStats(agents) {
    const stats = {
      total: agents.length,
      idle: 0,
      busy: 0,
      error: 0,
      byType: {}
    };

    for (const agent of agents) {
      if (agent.status === 'idle') stats.idle++;
      else if (agent.status === 'busy') stats.busy++;
      else if (agent.status === 'error') stats.error++;

      const type = agent.type || 'unknown';
      stats.byType[type] = (stats.byType[type] || 0) + 1;
    }

    this.status.agents = stats;
    this.emit('agents:updated', stats);
  }

  updateTaskStats(stats) {
    this.status.tasks = { ...this.status.tasks, ...stats };
    this.emit('tasks:updated', this.status.tasks);
  }

  updateSessionStats(sessions) {
    this.status.sessions = {
      active: sessions.filter(s => s.status === 'running').length,
      total: sessions.length
    };
    this.emit('sessions:updated', this.status.sessions);
  }

  updateHealthCheck(name, status, details = {}) {
    this.status.health.checks[name] = {
      status,
      details,
      timestamp: new Date().toISOString()
    };

    const checkStatuses = Object.values(this.status.health.checks).map(c => c.status);
    if (checkStatuses.every(s => s === 'healthy')) {
      this.status.health.status = 'healthy';
    } else if (checkStatuses.some(s => s === 'unhealthy')) {
      this.status.health.status = 'unhealthy';
    } else {
      this.status.health.status = 'degraded';
    }

    this.emit('health:updated', this.status.health);
  }

  updateMetrics(metrics) {
    this.status.metrics = { ...this.status.metrics, ...metrics };
    this.emit('metrics:updated', this.status.metrics);
  }

  incrementTaskSubmitted() {
    this.status.tasks.totalSubmitted++;
  }

  incrementTaskCompleted(duration = 0) {
    this.status.tasks.completed++;
    this.status.tasks.processing = Math.max(0, this.status.tasks.processing - 1);

    const total = this.status.tasks.completed;
    const prevAvg = this.status.metrics.avgTaskDuration;
    this.status.metrics.avgTaskDuration = prevAvg + (duration - prevAvg) / total;
  }

  incrementTaskFailed() {
    this.status.tasks.failed++;
    this.status.tasks.processing = Math.max(0, this.status.tasks.processing - 1);

    const total = this.status.tasks.totalSubmitted;
    if (total > 0) {
      this.status.metrics.errorRate = this.status.tasks.failed / total;
    }
  }

  setTaskProcessing(count) {
    this.status.tasks.processing = count;
    this.status.tasks.queued = Math.max(0, this.status.tasks.queued - count);
  }

  setTaskQueued(count) {
    this.status.tasks.queued = count;
  }

  getStatusFile() {
    return this.statusFile;
  }

  async shutdown() {
    this.stopUpdates();
    this.saveStatus();
    this.emit('shutdown');
  }
}

export default StatusManager;