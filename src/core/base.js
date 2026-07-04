import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';

export class BaseAgent extends EventEmitter {
  constructor(options = {}) {
    super();
    this.id = options.id || uuidv4();
    this.name = options.name || 'BaseAgent';
    this.type = options.type || 'generic';
    this.capabilities = options.capabilities || [];
    this.status = 'idle';
    this.currentTask = null;
    this.tasksCompleted = 0;
    this.tasksFailed = 0;
    this.createdAt = new Date();
    this.lastHeartbeat = new Date();
    this.metadata = options.metadata || {};
    this.maxRetries = options.maxRetries || 3;
    this.retryCount = 0;
  }

  async initialize() {
    this.status = 'ready';
    this.emit('ready', this);
    return this;
  }

  async execute(task) {
    this.currentTask = task;
    this.status = 'working';
    this.emit('task:start', { agent: this, task });

    try {
      const result = await this.process(task);
      this.status = 'idle';
      this.currentTask = null;
      this.tasksCompleted++;
      this.lastHeartbeat = new Date();
      this.emit('task:complete', { agent: this, task, result });
      return result;
    } catch (error) {
      this.status = 'error';
      this.currentTask = null;
      this.tasksFailed++;
      this.emit('task:error', { agent: this, task, error });
      throw error;
    }
  }

  async process(task) {
    throw new Error('process() must be implemented by subclass');
  }

  async shutdown() {
    this.status = 'shutdown';
    this.emit('shutdown', this);
  }

  heartbeat() {
    this.lastHeartbeat = new Date();
    this.emit('heartbeat', this);
  }

  isHealthy() {
    const timeSinceHeartbeat = Date.now() - this.lastHeartbeat.getTime();
    return this.status !== 'error' && timeSinceHeartbeat < 300000;
  }

  getStatus() {
    return {
      id: this.id,
      name: this.name,
      type: this.type,
      status: this.status,
      currentTask: this.currentTask ? this.currentTask.id : null,
      tasksCompleted: this.tasksCompleted,
      tasksFailed: this.tasksFailed,
      createdAt: this.createdAt,
      lastHeartbeat: this.lastHeartbeat,
      capabilities: this.capabilities,
      metadata: this.metadata
    };
  }

  canHandle(task) {
    if (!task.requiredCapabilities || task.requiredCapabilities.length === 0) {
      return true;
    }
    return task.requiredCapabilities.every(cap => this.capabilities.includes(cap));
  }
}

export class Task {
  constructor(options = {}) {
    this.id = options.id || uuidv4();
    this.type = options.type || 'generic';
    this.name = options.name || 'Unnamed Task';
    this.description = options.description || '';
    this.payload = options.payload || {};
    this.priority = options.priority || 5;
    this.status = 'pending';
    this.requiredCapabilities = options.requiredCapabilities || [];
    this.dependencies = options.dependencies || [];
    this.timeout = options.timeout || 300000;
    this.retries = options.retries || 0;
    this.maxRetries = options.maxRetries || 3;
    this.createdAt = new Date();
    this.startedAt = null;
    this.completedAt = null;
    this.assignedAgent = null;
    this.result = null;
    this.error = null;
    this.metadata = options.metadata || {};
  }

  assign(agent) {
    this.assignedAgent = agent;
    this.status = 'assigned';
    this.startedAt = new Date();
  }

  complete(result) {
    this.status = 'completed';
    this.result = result;
    this.completedAt = new Date();
  }

  fail(error) {
    this.status = 'failed';
    this.error = error;
    this.completedAt = new Date();
  }

  retry() {
    this.status = 'pending';
    this.retries++;
    this.assignedAgent = null;
    this.startedAt = null;
  }

  canRetry() {
    return this.retries < this.maxRetries;
  }

  getDuration() {
    if (!this.startedAt) return 0;
    const end = this.completedAt || new Date();
    return end - this.startedAt;
  }

  toJSON() {
    return {
      id: this.id,
      type: this.type,
      name: this.name,
      description: this.description,
      payload: this.payload,
      priority: this.priority,
      status: this.status,
      requiredCapabilities: this.requiredCapabilities,
      dependencies: this.dependencies,
      timeout: this.timeout,
      retries: this.retries,
      maxRetries: this.maxRetries,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      assignedAgent: this.assignedAgent?.id || null,
      result: this.result,
      error: this.error?.message || null,
      metadata: this.metadata,
      duration: this.getDuration()
    };
  }
}

export class TaskQueue extends EventEmitter {
  constructor() {
    super();
    this.queue = [];
    this.processing = new Set();
    this.completed = new Map();
    this.failed = new Map();
    this.maxSize = 10000;
  }

  enqueue(task) {
    if (this.queue.length >= this.maxSize) {
      throw new Error('Task queue is full');
    }
    this.queue.push(task);
    this.queue.sort((a, b) => b.priority - a.priority);
    this.emit('enqueued', task);
    return task;
  }

  dequeue() {
    return this.queue.shift() || null;
  }

  peek() {
    return this.queue[0] || null;
  }

  getQueueLength() {
    return this.queue.length;
  }

  getProcessingCount() {
    return this.processing.size;
  }

  markProcessing(task) {
    this.processing.add(task.id);
    this.emit('processing', task);
  }

  markComplete(task) {
    this.processing.delete(task.id);
    this.completed.set(task.id, task);
    this.emit('completed', task);
  }

  markFailed(task) {
    this.processing.delete(task.id);
    this.failed.set(task.id, task);
    this.emit('failed', task);
  }

  getCompleted(taskId) {
    return this.completed.get(taskId);
  }

  getFailed(taskId) {
    return this.failed.get(taskId);
  }

  clearCompleted() {
    this.completed.clear();
  }

  clearFailed() {
    this.failed.clear();
  }

  getStats() {
    return {
      queued: this.queue.length,
      processing: this.processing.size,
      completed: this.completed.size,
      failed: this.failed.size
    };
  }
}