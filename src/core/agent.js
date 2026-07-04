import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';

export class Task {
  constructor(options = {}) {
    this.id = options.id || uuidv4();
    this.name = options.name || 'Unnamed Task';
    this.type = options.type || 'generic';
    this.payload = options.payload || {};
    this.priority = options.priority || 0;
    this.requiredCapabilities = options.requiredCapabilities || [];
    this.maxRetries = options.maxRetries ?? 3;
    this.timeout = options.timeout ?? 300000;
    this.metadata = options.metadata || {};

    this.status = 'pending';
    this.retries = 0;
    this.createdAt = new Date();
    this.startedAt = null;
    this.completedAt = null;
    this.result = null;
    this.error = null;
  }

  canRetry() {
    return this.retries < this.maxRetries;
  }

  retry() {
    this.retries++;
    this.status = 'pending';
    this.error = null;
  }

  start() {
    this.status = 'running';
    this.startedAt = new Date();
  }

  complete(result) {
    this.status = 'completed';
    this.completedAt = new Date();
    this.result = result;
  }

  fail(error) {
    this.status = 'failed';
    this.completedAt = new Date();
    this.error = error instanceof Error ? error.message : String(error);
  }

  getDuration() {
    if (!this.startedAt) return 0;
    const end = this.completedAt || new Date();
    return end - this.startedAt;
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      type: this.type,
      priority: this.priority,
      status: this.status,
      retries: this.retries,
      maxRetries: this.maxRetries,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      duration: this.getDuration(),
      error: this.error,
      metadata: this.metadata
    };
  }
}

export class TaskQueue {
  constructor() {
    this.pending = [];
    this.processing = new Map();
    this.completed = new Map();
    this.failed = new Map();
  }

  enqueue(task) {
    this.pending.push(task);
    this.pending.sort((a, b) => b.priority - a.priority);
  }

  dequeue() {
    return this.pending.shift() || null;
  }

  markProcessing(task) {
    this.processing.set(task.id, task);
    task.start();
  }

  markComplete(task) {
    this.processing.delete(task.id);
    this.completed.set(task.id, task);
  }

  markFailed(task) {
    this.processing.delete(task.id);
    this.failed.set(task.id, task);
  }

  getPending() {
    return [...this.pending];
  }

  getProcessing() {
    return Array.from(this.processing.values());
  }

  getCompleted(taskId = null) {
    if (taskId) return this.completed.get(taskId) || null;
    return Array.from(this.completed.values());
  }

  getFailed(taskId = null) {
    if (taskId) return this.failed.get(taskId) || null;
    return Array.from(this.failed.values());
  }

  getStats() {
    return {
      pending: this.pending.length,
      processing: this.processing.size,
      completed: this.completed.size,
      failed: this.failed.size
    };
  }

  clear() {
    this.pending = [];
    this.processing.clear();
    this.completed.clear();
    this.failed.clear();
  }
}

export class BaseAgent extends EventEmitter {
  constructor(options = {}) {
    super();
    this.id = options.id || uuidv4();
    this.name = options.name || 'BaseAgent';
    this.type = options.type || 'worker';
    this.capabilities = options.capabilities || [];
    this.metadata = options.metadata || {};

    this.status = 'initializing';
    this.currentTask = null;
    this.lastHeartbeat = Date.now();
    this.taskCount = 0;
    this.errorCount = 0;
  }

  async initialize() {
    this.status = 'idle';
    this.emit('initialized', this);
  }

  async shutdown() {
    this.status = 'shutting_down';
    if (this.currentTask) {
      this.emit('task:interrupted', this.currentTask);
    }
    this.status = 'stopped';
    this.emit('shutdown', this);
  }

  canHandle(task) {
    if (this.status !== 'idle') return false;
    if (!task.requiredCapabilities || task.requiredCapabilities.length === 0) return true;
    return task.requiredCapabilities.every(cap => this.capabilities.includes(cap));
  }

  async execute(task) {
    if (!this.canHandle(task)) {
      throw new Error(`Agent ${this.name} cannot handle task ${task.name}`);
    }

    this.status = 'busy';
    this.currentTask = task;
    this.taskCount++;
    this.lastHeartbeat = Date.now();

    this.emit('task:started', task);

    try {
      const result = await this.processTask(task);
      this.currentTask = null;
      this.status = 'idle';
      this.lastHeartbeat = Date.now();
      this.emit('task:complete', { task, result });
      return result;
    } catch (error) {
      this.currentTask = null;
      this.status = 'idle';
      this.errorCount++;
      this.lastHeartbeat = Date.now();
      this.emit('task:error', { task, error });
      throw error;
    }
  }

  async processTask(task) {
    throw new Error('processTask() must be implemented by subclass');
  }

  heartbeat() {
    this.lastHeartbeat = Date.now();
    this.emit('heartbeat', this);
  }

  isHealthy(maxAge = 60000) {
    return Date.now() - this.lastHeartbeat < maxAge;
  }

  getStatus() {
    return {
      id: this.id,
      name: this.name,
      type: this.type,
      status: this.status,
      capabilities: this.capabilities,
      currentTask: this.currentTask?.id || null,
      taskCount: this.taskCount,
      errorCount: this.errorCount,
      lastHeartbeat: this.lastHeartbeat,
      uptime: Date.now() - this.createdAt
    };
  }

  async restart() {
    await this.shutdown();
    await this.initialize();
  }
}