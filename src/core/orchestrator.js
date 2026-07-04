import { EventEmitter } from 'events';
import { BaseAgent, Task, TaskQueue } from './base.js';
import Logger from '../utils/logger.js';

export class Orchestrator extends EventEmitter {
  constructor(options = {}) {
    super();
    this.logger = options.logger || new Logger();
    this.config = options.config || {};
    this.agents = new Map();
    this.agentPool = new Map();
    this.taskQueue = new TaskQueue();
    this.running = false;
    this.stats = {
      tasksSubmitted: 0,
      tasksCompleted: 0,
      tasksFailed: 0,
      agentsCreated: 0,
      agentsDestroyed: 0
    };
    this.healthCheckInterval = null;
    this.taskProcessorInterval = null;
  }

  async start() {
    if (this.running) {
      this.logger.warn('Orchestrator already running');
      return;
    }

    this.running = true;
    this.logger.info('Starting orchestrator');

    await this.initializeAgentPools();
    this.startHealthChecks();
    this.startTaskProcessor();

    this.emit('started');
    this.logger.info('Orchestrator started');
  }

  async stop() {
    if (!this.running) return;

    this.running = false;
    this.logger.info('Stopping orchestrator');

    this.stopHealthChecks();
    this.stopTaskProcessor();

    await this.shutdownAllAgents();

    this.emit('stopped');
    this.logger.info('Orchestrator stopped');
  }

  async initializeAgentPools() {
    const agentTypes = this.config.agents?.types || ['worker'];
    const poolSize = this.config.orchestrator?.agentPoolSize || 5;

    for (const type of agentTypes) {
      this.agentPool.set(type, []);
      const maxConcurrent = this.config.agents?.[type]?.maxConcurrent || poolSize;

      for (let i = 0; i < maxConcurrent; i++) {
        await this.createAgent(type);
      }
    }
  }

  async createAgent(type, options = {}) {
    const agentConfig = this.config.agents?.[type] || {};
    const agent = new BaseAgent({
      type,
      name: `${type}-${this.agents.size + 1}`,
      capabilities: agentConfig.capabilities || [],
      maxRetries: agentConfig.maxRetries || 3,
      metadata: { ...agentConfig, ...options.metadata }
    });

    await agent.initialize();

    this.agents.set(agent.id, agent);
    this.stats.agentsCreated++;

    const pool = this.agentPool.get(type) || [];
    pool.push(agent.id);
    this.agentPool.set(type, pool);

    agent.on('task:complete', ({ task, result }) => {
      this.handleTaskComplete(agent, task, result);
    });

    agent.on('task:error', ({ task, error }) => {
      this.handleTaskError(agent, task, error);
    });

    agent.on('heartbeat', () => {
      // Heartbeat handled by health check
    });

    this.emit('agent:created', agent);
    this.logger.debug(`Agent created: ${agent.name} (${agent.id})`);
    return agent;
  }

  async destroyAgent(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return false;

    await agent.shutdown();

    const pool = this.agentPool.get(agent.type) || [];
    const index = pool.indexOf(agentId);
    if (index > -1) pool.splice(index, 1);

    this.agents.delete(agentId);
    this.stats.agentsDestroyed++;

    this.emit('agent:destroyed', agent);
    this.logger.debug(`Agent destroyed: ${agent.name} (${agent.id})`);
    return true;
  }

  getAvailableAgent(requiredCapabilities = []) {
    for (const [id, agent] of this.agents) {
      if (agent.status === 'idle' && agent.canHandle({ requiredCapabilities })) {
        return agent;
      }
    }
    return null;
  }

  async submitTask(taskOptions) {
    const task = new Task(taskOptions);
    this.taskQueue.enqueue(task);
    this.stats.tasksSubmitted++;
    this.emit('task:submitted', task);
    this.logger.debug(`Task submitted: ${task.name} (${task.id})`);
    return task;
  }

  async submitTasks(tasks) {
    const submitted = [];
    for (const taskOptions of tasks) {
      submitted.push(await this.submitTask(taskOptions));
    }
    return submitted;
  }

  startTaskProcessor() {
    this.taskProcessorInterval = setInterval(() => {
      this.processQueue();
    }, 1000);
  }

  stopTaskProcessor() {
    if (this.taskProcessorInterval) {
      clearInterval(this.taskProcessorInterval);
      this.taskProcessorInterval = null;
    }
  }

  processQueue() {
    if (!this.running) return;

    const availableAgent = this.getAvailableAgent();
    if (!availableAgent) return;

    const task = this.taskQueue.dequeue();
    if (!task) return;

    const agent = this.getAvailableAgent(task.requiredCapabilities);
    if (!agent) {
      this.taskQueue.enqueue(task);
      return;
    }

    this.taskQueue.markProcessing(task);
    agent.execute(task).catch(error => {
      this.logger.error(`Task execution failed: ${task.name}`, { error: error.message });
    });
  }

  handleTaskComplete(agent, task, result) {
    this.taskQueue.markComplete(task);
    task.complete(result);
    this.stats.tasksCompleted++;
    this.emit('task:completed', { agent, task, result });
    this.logger.info(`Task completed: ${task.name} (${task.id})`);
  }

  handleTaskError(agent, task, error) {
    this.logger.error(`Task failed: ${task.name}`, { error: error.message });

    if (task.canRetry()) {
      task.retry();
      this.taskQueue.enqueue(task);
      this.logger.info(`Task requeued for retry: ${task.name} (attempt ${task.retries}/${task.maxRetries})`);
    } else {
      this.taskQueue.markFailed(task);
      task.fail(error);
      this.stats.tasksFailed++;
      this.emit('task:failed', { agent, task, error });
    }
  }

  startHealthChecks() {
    const interval = this.config.orchestrator?.healthCheckInterval || 30000;
    this.healthCheckInterval = setInterval(() => {
      this.performHealthCheck();
    }, interval);
  }

  stopHealthChecks() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  performHealthCheck() {
    const unhealthyAgents = [];
    for (const [id, agent] of this.agents) {
      if (!agent.isHealthy()) {
        unhealthyAgents.push(agent);
      }
    }

    for (const agent of unhealthyAgents) {
      this.logger.warn(`Unhealthy agent detected: ${agent.name} (${agent.id})`);
      this.emit('agent:unhealthy', agent);
      this.restartAgent(agent.id);
    }

    this.emit('health:check', { healthy: this.agents.size - unhealthyAgents.length, total: this.agents.size });
  }

  async restartAgent(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    this.logger.info(`Restarting agent: ${agent.name} (${agent.id})`);
    await this.destroyAgent(agentId);
    await this.createAgent(agent.type, { metadata: agent.metadata });
  }

  async shutdownAllAgents() {
    const agentIds = Array.from(this.agents.keys());
    for (const id of agentIds) {
      await this.destroyAgent(id);
    }
  }

  getStats() {
    return {
      ...this.stats,
      agents: this.agents.size,
      agentTypes: Array.from(this.agentPool.entries()).map(([type, ids]) => ({
        type,
        count: ids.length
      })),
      queue: this.taskQueue.getStats(),
      running: this.running
    };
  }

  getAgentStatuses() {
    return Array.from(this.agents.values()).map(agent => agent.getStatus());
  }

  getTaskStatus(taskId) {
    return this.taskQueue.getCompleted(taskId) || this.taskQueue.getFailed(taskId);
  }
}

export default Orchestrator;