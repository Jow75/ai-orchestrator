import ConfigManager from './utils/configManager.js';
import Logger from './utils/logger.js';
import { Orchestrator } from './core/orchestrator.js';
import { SessionManager } from './managers/sessionManager.js';
import { StatusManager } from './managers/statusManager.js';
import APIServer from './api/server.js';
import {
  OrchestratorAgent,
  WorkerAgent,
  ResearcherAgent,
  CoderAgent,
  ReviewerAgent,
  TesterAgent,
  DeployerAgent
} from './agents/index.js';

class AIOrchestrator {
  constructor(options = {}) {
    this.config = new ConfigManager(options.config);
    this.logger = new Logger(this.config.get('logging') || {});
    this.orchestrator = null;
    this.sessionManager = null;
    this.statusManager = null;
    this.apiServer = null;
    this.running = false;
  }

  async initialize() {
    this.logger.info('Initializing AI Orchestrator...');

    this.config.load();
    this.logger.config = this.config.get('logging') || {};

    this.statusManager = new StatusManager({
      config: this.config.getAll(),
      logger: this.logger
    });

    this.sessionManager = new SessionManager({
      config: this.config.getAll(),
      logger: this.logger
    });

    this.orchestrator = new Orchestrator({
      config: this.config.getAll(),
      logger: this.logger
    });

    this.orchestrator.on('agent:created', (agent) => {
      this.registerAgentHandlers(agent);
    });

    this.sessionManager.loadAllSessions();

    this.apiServer = new APIServer({
      config: this.config,
      logger: this.logger,
      orchestrator: this.orchestrator,
      sessionManager: this.sessionManager,
      statusManager: this.statusManager
    });

    this.logger.info('AI Orchestrator initialized');
  }

  registerAgentHandlers(agent) {
    agent.on('task:started', (task) => {
      this.logger.info(`Agent ${agent.name} started task: ${task.name}`);
      this.statusManager?.incrementTaskSubmitted();
    });

    agent.on('task:complete', ({ task, result }) => {
      this.logger.info(`Agent ${agent.name} completed task: ${task.name}`);
      this.statusManager?.incrementTaskCompleted(task.getDuration?.() || 0);
    });

    agent.on('task:error', ({ task, error }) => {
      this.logger.error(`Agent ${agent.name} failed task: ${task.name}`, { error: error.message });
      this.statusManager?.incrementTaskFailed();
    });
  }

  async start() {
    if (this.running) {
      this.logger.warn('Already running');
      return;
    }

    this.logger.info('Starting AI Orchestrator...');

    await this.orchestrator.start();
    this.statusManager.startUpdates();
    this.statusManager.setOrchestratorStatus('running', { uptime: 0 });
    await this.apiServer.start();

    this.running = true;
    this.logger.info('AI Orchestrator started successfully');

    this.setupSignalHandlers();
  }

  async stop() {
    if (!this.running) return;

    this.logger.info('Stopping AI Orchestrator...');

    this.running = false;
    await this.orchestrator.stop();
    this.statusManager.stopUpdates();
    this.statusManager.setOrchestratorStatus('stopped');
    await this.apiServer.stop();
    await this.sessionManager.shutdown();
    await this.statusManager.shutdown();

    this.logger.info('AI Orchestrator stopped');
  }

  setupSignalHandlers() {
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];

    for (const signal of signals) {
      process.on(signal, async () => {
        this.logger.info(`Received ${signal}, shutting down...`);
        await this.stop();
        process.exit(0);
      });
    }

    process.on('uncaughtException', async (error) => {
      this.logger.error('Uncaught exception', { error: error.message, stack: error.stack });
      await this.stop();
      process.exit(1);
    });

    process.on('unhandledRejection', async (reason) => {
      this.logger.error('Unhandled rejection', { reason });
      await this.stop();
      process.exit(1);
    });
  }

  getOrchestrator() {
    return this.orchestrator;
  }

  getSessionManager() {
    return this.sessionManager;
  }

  getStatusManager() {
    return this.statusManager;
  }

  getAPIServer() {
    return this.apiServer;
  }
}

async function main() {
    const orchestrator = new AIOrchestrator();
    await orchestrator.initialize();
    await orchestrator.start();
}

main().catch(error => {
    console.error('Failed to start:', error);
    process.exit(1);
});

export default AIOrchestrator;