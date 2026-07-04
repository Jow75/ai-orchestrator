import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

export class CrashRecoveryEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.config = options.config || {};
    this.logger = options.logger || console;
    this.recoveryDir = this.config.recoveryDir || './recovery';
    this.maxRecoveryAttempts = this.config.maxRecoveryAttempts || 3;
    this.recoveryStrategies = new Map();
    this.crashHistory = [];

    this.registerDefaultStrategies();
    this.ensureRecoveryDir();
  }

  ensureRecoveryDir() {
    if (!fs.existsSync(this.recoveryDir)) {
      fs.mkdirSync(this.recoveryDir, { recursive: true });
    }
  }

  registerDefaultStrategies() {
    this.registerStrategy('rate-limit', this.handleRateLimit.bind(this));
    this.registerStrategy('crash', this.handleCrash.bind(this));
    this.registerStrategy('oom', this.handleOOM.bind(this));
    this.registerStrategy('timeout', this.handleTimeout.bind(this));
    this.registerStrategy('signal', this.handleSignal.bind(this));
    this.registerStrategy('unknown', this.handleUnknown.bind(this));
  }

  registerStrategy(type, handler) {
    this.recoveryStrategies.set(type, handler);
  }

  async recover(crashInfo) {
    const { type, driver, sessionId, context = {} } = crashInfo;

    this.logger.info(`Attempting recovery for ${type}`, { sessionId, driver });

    const strategy = this.recoveryStrategies.get(type) || this.recoveryStrategies.get('unknown');
    if (!strategy) {
      this.logger.error(`No recovery strategy for type: ${type}`);
      return { success: false, reason: 'no-strategy' };
    }

    const attempt = this.getAttemptCount(sessionId, type);
    if (attempt >= this.maxRecoveryAttempts) {
      this.logger.error(`Max recovery attempts reached for ${sessionId}`);
      return { success: false, reason: 'max-attempts' };
    }

    this.recordCrash(crashInfo);

    try {
      const result = await strategy(crashInfo);
      this.emit('recovery:complete', { crashInfo, result });
      return result;
    } catch (error) {
      this.logger.error(`Recovery failed for ${type}`, { error: error.message });
      this.emit('recovery:failed', { crashInfo, error });
      return { success: false, reason: error.message };
    }
  }

  async handleRateLimit(crashInfo) {
    const { driver, sessionId, context = {} } = crashInfo;

    this.logger.info('Handling rate limit recovery', { sessionId });

    const waitTime = this.calculateWaitTime(context);
    this.logger.info(`Waiting ${waitTime}ms before resume`);

    await this.sleep(waitTime);

    this.logger.info('Resuming after rate limit wait');
    await driver.resume(sessionId, context);

    return { success: true, action: 'resumed-after-wait', waitTime };
  }

  calculateWaitTime(context) {
    const baseWait = context.baseWait || 60000;
    const multiplier = context.multiplier || 2;
    const attempt = context.attempt || 0;
    const maxWait = context.maxWait || 3600000;

    let wait = baseWait * Math.pow(multiplier, attempt);
    wait = Math.min(wait, maxWait);
    wait += Math.random() * 10000;

    return Math.floor(wait);
  }

  async handleCrash(crashInfo) {
    const { driver, sessionId, context = {}, exitCode, signal } = crashInfo;

    this.logger.info('Handling crash recovery', { sessionId, exitCode, signal });

    if (signal === 'SIGKILL' || signal === 'SIGTERM') {
      this.logger.info('Process was killed, attempting clean restart');
      await driver.start(sessionId, { resume: false });
      return { success: true, action: 'clean-restart' };
    }

    if (exitCode === 137) {
      this.logger.warn('Process killed by OOM killer');
      return this.handleOOM(crashInfo);
    }

    await driver.resume(sessionId, context);
    return { success: true, action: 'resumed' };
  }

  async handleOOM(crashInfo) {
    const { driver, sessionId, context = {} } = crashInfo;

    this.logger.warn('Handling OOM recovery', { sessionId });

    await new Promise(resolve => setTimeout(resolve, 5000));

    if (context.reduceMemory) {
      this.logger.info('Attempting restart with reduced memory');
      await driver.start(sessionId, { ...context, reduceMemory: true });
    } else {
      await driver.resume(sessionId, context);
    }

    return { success: true, action: 'oom-recovery' };
  }

  async handleTimeout(crashInfo) {
    const { driver, sessionId, context = {} } = crashInfo;

    this.logger.info('Handling timeout recovery', { sessionId });

    await driver.resume(sessionId, { ...context, timeout: true });
    return { success: true, action: 'resumed-after-timeout' };
  }

  async handleSignal(crashInfo) {
    const { driver, sessionId, context = {}, signal } = crashInfo;

    this.logger.info('Handling signal recovery', { sessionId, signal });

    if (signal === 'SIGINT' || signal === 'SIGTERM') {
      await driver.resume(sessionId, context);
      return { success: true, action: 'resumed-after-signal' };
    }

    return { success: false, reason: 'unhandled-signal' };
  }

  async handleUnknown(crashInfo) {
    const { driver, sessionId, context = {} } = crashInfo;

    this.logger.warn('Handling unknown crash type', { sessionId });

    await driver.resume(sessionId, context);
    return { success: true, action: 'resumed-unknown' };
  }

  recordCrash(crashInfo) {
    const record = {
      ...crashInfo,
      timestamp: new Date().toISOString(),
      id: `${crashInfo.sessionId}-${Date.now()}`
    };

    this.crashHistory.push(record);

    if (this.crashHistory.length > 1000) {
      this.crashHistory = this.crashHistory.slice(-500);
    }

    this.saveCrashRecord(record);
  }

  saveCrashRecord(record) {
    const file = path.join(this.recoveryDir, `crash-${record.id}.json`);
    fs.writeFileSync(file, JSON.stringify(record, null, 2));
  }

  getAttemptCount(sessionId, type) {
    return this.crashHistory.filter(c =>
      c.sessionId === sessionId && c.type === type
    ).length;
  }

  getCrashHistory(sessionId = null) {
    if (sessionId) {
      return this.crashHistory.filter(c => c.sessionId === sessionId);
    }
    return [...this.crashHistory];
  }

  getRecoveryStats() {
    const total = this.crashHistory.length;
    const byType = {};

    for (const crash of this.crashHistory) {
      byType[crash.type] = (byType[crash.type] || 0) + 1;
    }

    return { total, byType };
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default CrashRecoveryEngine;