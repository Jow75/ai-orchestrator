import { EventEmitter } from 'events';
import os from 'os';

export class HealthMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.config = options.config || {};
    this.logger = options.logger || console;
    this.checks = new Map();
    this.results = new Map();
    this.interval = this.config.interval || 30000;
    this.timer = null;
    this.thresholds = {
      cpu: this.config.cpuThreshold || 90,
      memory: this.config.memoryThreshold || 90,
      disk: this.config.diskThreshold || 90,
      processMemory: this.config.processMemoryThreshold || 1024 * 1024 * 1024
    };
  }

  registerCheck(name, checkFn, options = {}) {
    this.checks.set(name, {
      fn: checkFn,
      interval: options.interval || this.interval,
      critical: options.critical || false,
      timeout: options.timeout || 5000
    });
  }

  unregisterCheck(name) {
    return this.checks.delete(name);
  }

  async runCheck(name) {
    const check = this.checks.get(name);
    if (!check) throw new Error(`Check ${name} not found`);

    try {
      const result = await Promise.race([
        check.fn(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Check timeout')), check.timeout))
      ]);

      this.results.set(name, {
        name,
        status: 'healthy',
        result,
        timestamp: new Date().toISOString()
      });

      return this.results.get(name);
    } catch (error) {
      this.results.set(name, {
        name,
        status: 'unhealthy',
        error: error.message,
        timestamp: new Date().toISOString()
      });

      if (check.critical) {
        this.emit('critical-failure', { name, error: error.message });
      }

      return this.results.get(name);
    }
  }

  async runAllChecks() {
    const results = [];

    for (const [name] of this.checks) {
      try {
        const result = await this.runCheck(name);
        results.push(result);
      } catch (error) {
        results.push({
          name,
          status: 'error',
          error: error.message,
          timestamp: new Date().toISOString()
        });
      }
    }

    const overall = this.calculateOverallHealth(results);
    this.emit('health:check', { overall, checks: results });

    return { overall, checks: results };
  }

  calculateOverallHealth(results) {
    if (results.some(r => r.status === 'unhealthy' && this.checks.get(r.name)?.critical)) {
      return 'critical';
    }
    if (results.some(r => r.status === 'unhealthy')) {
      return 'degraded';
    }
    if (results.some(r => r.status === 'error')) {
      return 'error';
    }
    return 'healthy';
  }

  start() {
    if (this.timer) return;

    this.timer = setInterval(() => {
      this.runAllChecks().catch(err => this.logger.error('Health check error', { error: err.message }));
    }, this.interval);

    this.logger.debug('Health monitor started');
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.logger.debug('Health monitor stopped');
  }

  getStatus() {
    const checks = {};
    for (const [name, result] of this.results) {
      checks[name] = result;
    }

    return {
      overall: this.calculateOverallHealth(Array.from(this.results.values())),
      checks,
      system: this.getSystemMetrics(),
      timestamp: new Date().toISOString()
    };
  }

  getSystemMetrics() {
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memPercent = (usedMem / totalMem) * 100;

    let cpuPercent = 0;
    if (this.lastCpuInfo) {
      const prevIdle = this.lastCpuInfo.idle;
      const prevTotal = this.lastCpuInfo.total;

      let idle = 0, total = 0;
      for (const cpu of cpus) {
        for (const type in cpu.times) {
          total += cpu.times[type];
        }
        idle += cpu.times.idle;
      }

      const idleDiff = idle - prevIdle;
      const totalDiff = total - prevTotal;
      cpuPercent = totalDiff > 0 ? ((totalDiff - idleDiff) / totalDiff) * 100 : 0;
    }

    let idle = 0, total = 0;
    for (const cpu of cpus) {
      for (const type in cpu.times) {
        total += cpu.times[type];
      }
      idle += cpu.times.idle;
    }
    this.lastCpuInfo = { idle, total };

    return {
      cpu: {
        percent: Math.round(cpuPercent * 100) / 100,
        cores: cpus.length,
        model: cpus[0]?.model
      },
      memory: {
        total: totalMem,
        free: freeMem,
        used: usedMem,
        percent: Math.round(memPercent * 100) / 100
      },
      platform: os.platform(),
      arch: os.arch(),
      uptime: os.uptime(),
      loadAvg: os.loadavg()
    };
  }

  checkThresholds() {
    const metrics = this.getSystemMetrics();
    const alerts = [];

    if (metrics.cpu.percent > this.thresholds.cpu) {
      alerts.push({ type: 'cpu', value: metrics.cpu.percent, threshold: this.thresholds.cpu });
    }

    if (metrics.memory.percent > this.thresholds.memory) {
      alerts.push({ type: 'memory', value: metrics.memory.percent, threshold: this.thresholds.memory });
    }

    if (alerts.length > 0) {
      this.emit('threshold:exceeded', { alerts, metrics });
    }

    return alerts;
  }

  async shutdown() {
    this.stop();
    this.emit('shutdown');
  }
}

export default HealthMonitor;