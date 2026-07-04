import { EventEmitter } from 'events';

export class ProcessSupervisor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.config = options.config || {};
    this.logger = options.logger || console;
    this.monitoredProcesses = new Map();
    this.checkInterval = this.config.checkInterval || 5000;
    this.healthCheckInterval = this.config.healthCheckInterval || 30000;
    this.checkTimer = null;
    this.healthTimer = null;
  }

  addProcess(id, process, metadata = {}) {
    if (this.monitoredProcesses.has(id)) {
      throw new Error(`Process ${id} already monitored`);
    }

    const entry = {
      id,
      process,
      metadata,
      status: 'running',
      startTime: Date.now(),
      lastCheck: Date.now(),
      restarts: 0,
      maxRestarts: metadata.maxRestarts || 3,
      restartDelay: metadata.restartDelay || 5000,
      onExit: metadata.onExit || (() => {}),
      onError: metadata.onError || (() => {}),
      onCrash: metadata.onCrash || (() => {})
    };

    this.monitoredProcesses.set(id, entry);
    this.setupProcessHandlers(id, entry);

    this.logger.info(`Process added to supervisor: ${id}`, metadata);
    this.emit('process:added', entry);

    return entry;
  }

  removeProcess(id) {
    const entry = this.monitoredProcesses.get(id);
    if (!entry) return false;

    this.cleanupProcessHandlers(entry);
    this.monitoredProcesses.delete(id);
    this.emit('process:removed', entry);
    return true;
  }

  getProcess(id) {
    return this.monitoredProcesses.get(id) || null;
  }

  getAllProcesses() {
    return Array.from(this.monitoredProcesses.values());
  }

  setupProcessHandlers(id, entry) {
    const { process } = entry;

    process.on('exit', (code, signal) => {
      this.handleExit(id, code, signal);
    });

    process.on('error', (err) => {
      this.handleError(id, err);
    });

    if (process.stdout) {
      process.stdout.on('data', (data) => {
        entry.lastOutput = data.toString();
        entry.lastOutputTime = Date.now();
      });
    }

    if (process.stderr) {
      process.stderr.on('data', (data) => {
        entry.lastError = data.toString();
      });
    }
  }

  cleanupProcessHandlers(entry) {
    const { process } = entry;
    process.removeAllListeners('exit');
    process.removeAllListeners('error');
    if (process.stdout) process.stdout.removeAllListeners('data');
    if (process.stderr) process.stderr.removeAllListeners('data');
  }

  handleExit(id, code, signal) {
    const entry = this.monitoredProcesses.get(id);
    if (!entry) return;

    entry.status = 'exited';
    entry.exitCode = code;
    entry.exitSignal = signal;
    entry.exitTime = Date.now();

    this.logger.info(`Process exited: ${id}`, { code, signal });

    const isCrash = code !== 0 && code !== null;
    const isSignal = signal !== null;

    if (isCrash || isSignal) {
      this.emit('process:crashed', { id, code, signal, entry });
      entry.onCrash({ code, signal, entry });

      if (entry.restarts < entry.maxRestarts) {
        this.scheduleRestart(id);
      } else {
        this.logger.error(`Process ${id} exceeded max restarts`);
        this.emit('process:max-restarts', { id, entry });
      }
    } else {
      this.emit('process:exited', { id, code, signal, entry });
      entry.onExit({ code, signal, entry });
    }

    this.removeProcess(id);
  }

  handleError(id, err) {
    const entry = this.monitoredProcesses.get(id);
    if (!entry) return;

    this.logger.error(`Process error: ${id}`, { error: err.message });
    entry.onError(err);
    this.emit('process:error', { id, error: err, entry });
  }

  scheduleRestart(id) {
    const entry = this.monitoredProcesses.get(id);
    if (!entry) return;

    entry.restarts++;
    this.logger.info(`Scheduling restart for ${id} (attempt ${entry.restarts}/${entry.maxRestarts})`);

    setTimeout(() => {
      this.emit('process:restart', { id, attempt: entry.restarts, entry });
    }, entry.restartDelay);
  }

  startMonitoring() {
    if (this.checkTimer) return;

    this.checkTimer = setInterval(() => {
      this.performChecks();
    }, this.checkInterval);

    this.healthTimer = setInterval(() => {
      this.performHealthChecks();
    }, this.healthCheckInterval);

    this.logger.debug('Process supervisor monitoring started');
  }

  stopMonitoring() {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    this.logger.debug('Process supervisor monitoring stopped');
  }

  performChecks() {
    const now = Date.now();

    for (const [id, entry] of this.monitoredProcesses) {
      if (entry.process.killed) {
        this.logger.warn(`Process ${id} appears killed`);
        continue;
      }

      if (entry.lastOutputTime && now - entry.lastOutputTime > this.config.idleTimeout) {
        this.emit('process:idle', { id, entry, idleTime: now - entry.lastOutputTime });
      }

      entry.lastCheck = now;
    }
  }

  performHealthChecks() {
    const results = [];

    for (const [id, entry] of this.monitoredProcesses) {
      const healthy = this.checkProcessHealth(entry);
      results.push({ id, healthy, entry });

      if (!healthy) {
        this.emit('process:unhealthy', { id, entry });
      }
    }

    this.emit('health:check', results);
  }

  checkProcessHealth(entry) {
    if (!entry.process || entry.process.killed) return false;
    if (entry.process.exitCode !== null) return false;
    return true;
  }

  async shutdown() {
    this.stopMonitoring();

    for (const [id, entry] of this.monitoredProcesses) {
      this.logger.info(`Stopping process: ${id}`);
      if (entry.process && !entry.process.killed) {
        entry.process.kill('SIGTERM');
      }
    }

    await new Promise(resolve => setTimeout(resolve, 2000));

    for (const [id, entry] of this.monitoredProcesses) {
      if (entry.process && !entry.process.killed) {
        entry.process.kill('SIGKILL');
      }
    }

    this.monitoredProcesses.clear();
    this.emit('shutdown');
  }

  getStats() {
    return {
      total: this.monitoredProcesses.size,
      running: Array.from(this.monitoredProcesses.values()).filter(p => p.status === 'running').length,
      exited: Array.from(this.monitoredProcesses.values()).filter(p => p.status === 'exited').length
    };
  }
}

export default ProcessSupervisor;