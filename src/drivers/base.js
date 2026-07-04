export class AIDriver {
  constructor(options = {}) {
    this.id = options.id || 'base-driver';
    this.name = options.name || 'Base AI Driver';
    this.version = options.version || '1.0.0';
    this.capabilities = options.capabilities || [];
    this.config = options.config || {};
    this.process = null;
    this.status = 'stopped';
    this.sessionId = null;
    this.startTime = null;
    this.restartCount = 0;
    this.maxRestarts = options.maxRestarts || 3;
    this.logger = options.logger || console;
  }

  async initialize(config = {}) {
    this.config = { ...this.config, ...config };
    this.status = 'ready';
    this.logger.info(`Driver ${this.name} initialized`);
    return this;
  }

  async start(sessionId, options = {}) {
    throw new Error('start() must be implemented by subclass');
  }

  async stop(graceful = true) {
    throw new Error('stop() must be implemented by subclass');
  }

  async restart(sessionId, options = {}) {
    this.logger.info(`Restarting driver ${this.name}...`);
    await this.stop(true);
    await new Promise(resolve => setTimeout(resolve, 1000));
    return this.start(sessionId, options);
  }

  async sendMessage(message) {
    throw new Error('sendMessage() must be implemented by subclass');
  }

  async resume(sessionId, context = {}) {
    this.logger.info(`Resuming session ${sessionId}...`);
    return this.start(sessionId, { resume: true, context });
  }

  getStatus() {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      status: this.status,
      sessionId: this.sessionId,
      startTime: this.startTime,
      uptime: this.startTime ? Date.now() - this.startTime : 0,
      restartCount: this.restartCount,
      capabilities: this.capabilities
    };
  }

  isRunning() {
    return this.status === 'running';
  }

  isHealthy() {
    return this.status === 'running' || this.status === 'ready';
  }

  async shutdown() {
    this.logger.info(`Shutting down driver ${this.name}...`);
    await this.stop(false);
    this.status = 'stopped';
  }
}

export class DriverRegistry {
  constructor() {
    this.drivers = new Map();
    this.activeDriver = null;
  }

  register(driver) {
    if (this.drivers.has(driver.id)) {
      throw new Error(`Driver ${driver.id} already registered`);
    }
    this.drivers.set(driver.id, driver);
    return driver;
  }

  unregister(driverId) {
    return this.drivers.delete(driverId);
  }

  get(driverId) {
    return this.drivers.get(driverId) || null;
  }

  getAll() {
    return Array.from(this.drivers.values());
  }

  setActive(driverId) {
    const driver = this.get(driverId);
    if (!driver) throw new Error(`Driver ${driverId} not found`);
    this.activeDriver = driver;
    return driver;
  }

  getActive() {
    return this.activeDriver;
  }

  async initializeAll(config = {}) {
    for (const driver of this.drivers.values()) {
      await driver.initialize(config[driver.id] || {});
    }
  }

  async shutdownAll() {
    for (const driver of this.drivers.values()) {
      await driver.shutdown();
    }
  }
}

export const driverRegistry = new DriverRegistry();