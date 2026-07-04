import { EventEmitter } from 'events';

export class RateLimitEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.config = options.config || {};
    this.logger = options.logger || console;

    this.limits = new Map();
    this.usage = new Map();
    this.waitingQueue = new Map();
    this.checkInterval = this.config.checkInterval || 10000;
    this.timer = null;
  }

  setLimit(key, limit) {
    this.limits.set(key, {
      maxRequests: limit.maxRequests || 100,
      windowMs: limit.windowMs || 60000,
      strategy: limit.strategy || 'wait'
    });
    this.usage.set(key, { count: 0, windowStart: Date.now() });
  }

  async checkLimit(key) {
    const limit = this.limits.get(key);
    if (!limit) return { allowed: true, remaining: Infinity };

    const usage = this.usage.get(key) || { count: 0, windowStart: Date.now() };
    const now = Date.now();

    if (now - usage.windowStart >= limit.windowMs) {
      usage.count = 0;
      usage.windowStart = now;
    }

    usage.count++;
    this.usage.set(key, usage);

    const remaining = Math.max(0, limit.maxRequests - usage.count);
    const resetTime = usage.windowStart + limit.windowMs;

    if (usage.count > limit.maxRequests) {
      const waitTime = resetTime - now;

      this.emit('limit-exceeded', { key, limit, usage, waitTime, resetTime });

      if (limit.strategy === 'wait') {
        await this.waitForReset(key, waitTime);
        return this.checkLimit(key);
      } else if (limit.strategy === 'reject') {
        return { allowed: false, remaining: 0, waitTime, resetTime, reason: 'rate-limited' };
      }
    }

    return { allowed: true, remaining, resetTime, usage: usage.count };
  }

  waitForReset(key, waitTime) {
    return new Promise(resolve => {
      if (!this.waitingQueue.has(key)) {
        this.waitingQueue.set(key, []);
      }
      this.waitingQueue.get(key).push(resolve);

      setTimeout(() => {
        const queue = this.waitingQueue.get(key) || [];
        const index = queue.indexOf(resolve);
        if (index > -1) queue.splice(index, 1);
        resolve();
      }, waitTime);
    });
  }

  getUsage(key) {
    return this.usage.get(key) || { count: 0, windowStart: Date.now() };
  }

  getLimit(key) {
    return this.limits.get(key);
  }

  reset(key) {
    this.usage.delete(key);
    const queue = this.waitingQueue.get(key);
    if (queue) {
      queue.forEach(resolve => resolve());
      this.waitingQueue.delete(key);
    }
  }

  resetAll() {
    for (const key of this.limits.keys()) {
      this.reset(key);
    }
  }

  getStats() {
    const stats = {};
    for (const [key, limit] of this.limits) {
      const usage = this.getUsage(key);
      stats[key] = {
        limit: limit.maxRequests,
        windowMs: limit.windowMs,
        used: usage.count,
        remaining: Math.max(0, limit.maxRequests - usage.count),
        resetTime: usage.windowStart + limit.windowMs
      };
    }
    return stats;
  }

  start() {
    if (this.timer) return;

    this.timer = setInterval(() => {
      const now = Date.now();
      for (const [key, usage] of this.usage) {
        const limit = this.limits.get(key);
        if (limit && now - usage.windowStart >= limit.windowMs) {
          usage.count = 0;
          usage.windowStart = now;
        }
      }
    }, this.checkInterval);

    this.logger.debug('Rate limit engine started');
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.logger.debug('Rate limit engine stopped');
  }

  async shutdown() {
    this.stop();
    this.emit('shutdown');
  }
}

export class UsageTracker extends EventEmitter {
  constructor(options = {}) {
    super();
    this.logger = options.logger || console;
    this.records = new Map();
    this.dailyLimits = new Map();
    this.monthlyLimits = new Map();
  }

  record(key, amount = 1, metadata = {}) {
    const now = new Date();
    const dayKey = `${key}:${now.toISOString().split('T')[0]}`;
    const monthKey = `${key}:${now.toISOString().slice(0, 7)}`;

    this.incrementRecord(key, amount, metadata);
    this.incrementRecord(dayKey, amount, metadata);
    this.incrementRecord(monthKey, amount, metadata);

    this.checkLimits(key, dayKey, monthKey);
  }

  incrementRecord(key, amount, metadata) {
    if (!this.records.has(key)) {
      this.records.set(key, { total: 0, daily: {}, monthly: {}, history: [] });
    }
    const record = this.records.get(key);
    record.total += amount;
    record.history.push({ timestamp: new Date(), amount, metadata });
    if (record.history.length > 1000) record.history.shift();
  }

  setDailyLimit(key, limit) {
    this.dailyLimits.set(key, limit);
  }

  setMonthlyLimit(key, limit) {
    this.monthlyLimits.set(key, limit);
  }

  checkLimits(key, dayKey, monthKey) {
    const dailyLimit = this.dailyLimits.get(key);
    const monthlyLimit = this.monthlyLimits.get(key);

    if (dailyLimit) {
      const dailyUsage = this.records.get(dayKey)?.total || 0;
      if (dailyUsage >= dailyLimit) {
        this.emit('daily-limit-exceeded', { key, usage: dailyUsage, limit: dailyLimit });
      }
    }

    if (monthlyLimit) {
      const monthlyUsage = this.records.get(monthKey)?.total || 0;
      if (monthlyUsage >= monthlyLimit) {
        this.emit('monthly-limit-exceeded', { key, usage: monthlyUsage, limit: monthlyLimit });
      }
    }
  }

  getUsage(key) {
    return this.records.get(key) || { total: 0, daily: {}, monthly: {}, history: [] };
  }

  getDailyUsage(key) {
    const dayKey = `${key}:${new Date().toISOString().split('T')[0]}`;
    return this.records.get(dayKey)?.total || 0;
  }

  getMonthlyUsage(key) {
    const monthKey = `${key}:${new Date().toISOString().slice(0, 7)}`;
    return this.records.get(monthKey)?.total || 0;
  }

  getStats() {
    const stats = {};
    for (const [key, record] of this.records) {
      if (!key.includes(':')) {
        stats[key] = {
          total: record.total,
          daily: this.getDailyUsage(key),
          monthly: this.getMonthlyUsage(key),
          historyLength: record.history.length
        };
      }
    }
    return stats;
  }
}

export default { RateLimitEngine, UsageTracker };