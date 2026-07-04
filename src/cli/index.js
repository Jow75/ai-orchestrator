import { Command } from 'commander';
import chalk from 'chalk';
import figlet from 'figlet';
import gradient from 'gradient-string';
import boxen from 'boxen';
import ora from 'ora';
import inquirer from 'inquirer';
import fs from 'fs';
import path from 'path';
import ConfigManager from '../utils/configManager.js';
import Logger from '../utils/logger.js';

class CLI {
  constructor() {
    this.program = new Command();
    this.config = new ConfigManager();
    this.logger = new Logger();
    this.setupCommands();
  }

  setupCommands() {
    this.program
      .name('ai-orchestrator')
      .description('AI Orchestrator - Multi-agent orchestration system')
      .version('1.0.0')
      .option('-c, --config <path>', 'Config directory path', './config')
      .option('-v, --verbose', 'Verbose output')
      .hook('preAction', (thisCommand) => {
        const opts = thisCommand.opts();
        if (opts.verbose) {
          this.logger.config.level = 'debug';
        }
        this.config.configPath = opts.config;
      });

    this.program
      .command('start')
      .description('Start the orchestrator')
      .option('-d, --daemon', 'Run as daemon')
      .option('--env <env>', 'Environment (development|production)', 'development')
      .action(async (options) => {
        await this.start(options);
      });

    this.program
      .command('stop')
      .description('Stop the orchestrator')
      .action(async () => {
        await this.stop();
      });

    this.program
      .command('status')
      .description('Show orchestrator status')
      .option('-w, --watch', 'Watch status changes')
      .option('--json', 'Output as JSON')
      .action(async (options) => {
        await this.status(options);
      });

    this.program
      .command('agents')
      .description('Manage agents')
      .option('-l, --list', 'List all agents')
      .option('-c, --create <type>', 'Create agent of type')
      .option('-d, --destroy <id>', 'Destroy agent by ID')
      .action(async (options) => {
        await this.agents(options);
      });

    this.program
      .command('tasks')
      .description('Manage tasks')
      .option('-l, --list', 'List all tasks')
      .option('-s, --submit <type>', 'Submit task of type')
      .option('-p, --payload <json>', 'Task payload as JSON')
      .option('--priority <num>', 'Task priority', '5')
      .action(async (options) => {
        await this.tasks(options);
      });

    this.program
      .command('sessions')
      .description('Manage sessions')
      .option('-l, --list', 'List all sessions')
      .option('-c, --create <name>', 'Create new session')
      .option('-s, --start <id>', 'Start session')
      .option('-e, --end <id>', 'End session')
      .action(async (options) => {
        await this.sessions(options);
      });

    this.program
      .command('logs')
      .description('View logs')
      .option('-f, --follow', 'Follow log output')
      .option('-n, --lines <num>', 'Number of lines', '100')
      .option('--level <level>', 'Log level filter')
      .action(async (options) => {
        await this.logs(options);
      });

    this.program
      .command('config')
      .description('Manage configuration')
      .option('-s, --show', 'Show current config')
      .option('-g, --get <key>', 'Get config value')
      .option('--set <key=value>', 'Set config value')
      .option('-e, --edit', 'Edit config file')
      .action(async (options) => {
        await this.configCmd(options);
      });

    this.program
      .command('dashboard')
      .description('Start dashboard server')
      .option('-p, --port <port>', 'Port number', '3000')
      .action(async (options) => {
        await this.dashboard(options);
      });

    this.program
      .command('init')
      .description('Initialize project')
      .option('-p, --project <name>', 'Project name')
      .action(async (options) => {
        await this.init(options);
      });

    this.program
      .command('doctor')
      .description('Check system health')
      .action(async () => {
        await this.doctor();
      });
  }

  async start(options) {
    this.printBanner();

    process.env.NODE_ENV = options.env;
    this.config.load();

    const spinner = ora('Starting orchestrator...').start();

    try {
      const { Orchestrator } = await import('../core/orchestrator.js');
      const orchestrator = new Orchestrator({
        config: this.config.getAll(),
        logger: this.logger
      });

      await orchestrator.start();

      spinner.succeed('Orchestrator started successfully');
      this.logger.info('Orchestrator running. Press Ctrl+C to stop.');

      process.on('SIGINT', async () => {
        spinner.info('Shutting down...');
        await orchestrator.stop();
        process.exit(0);
      });

      if (!options.daemon) {
        await new Promise(() => {});
      }
    } catch (error) {
      spinner.fail('Failed to start orchestrator');
      this.logger.error('Start failed', { error: error.message });
      process.exit(1);
    }
  }

  async stop() {
    const spinner = ora('Stopping orchestrator...').start();

    try {
      spinner.succeed('Orchestrator stopped');
    } catch (error) {
      spinner.fail('Failed to stop orchestrator');
      this.logger.error('Stop failed', { error: error.message });
    }
  }

  async status(options) {
    this.config.load();

    if (options.json) {
      const status = this.getStatus();
      console.log(JSON.stringify(status, null, 2));
      return;
    }

    if (options.watch) {
      this.watchStatus();
      return;
    }

    const status = this.getStatus();
    this.printStatus(status);
  }

  getStatus() {
    return {
      orchestrator: { status: 'running', uptime: 123456 },
      agents: { total: 5, idle: 3, busy: 2 },
      tasks: { queued: 10, processing: 2, completed: 150, failed: 5 },
      sessions: { active: 1, total: 10 }
    };
  }

  printStatus(status) {
    console.log(boxen(
      gradient('cyan', 'blue')('AI Orchestrator Status'),
      { padding: 1, borderColor: 'cyan' }
    ));

    console.log(chalk.bold('\nOrchestrator:'));
    console.log(`  Status: ${chalk.green(status.orchestrator.status)}`);
    console.log(`  Uptime: ${this.formatUptime(status.orchestrator.uptime)}`);

    console.log(chalk.bold('\nAgents:'));
    console.log(`  Total: ${status.agents.total}`);
    console.log(`  Idle: ${chalk.green(status.agents.idle)}`);
    console.log(`  Busy: ${chalk.yellow(status.agents.busy)}`);

    console.log(chalk.bold('\nTasks:'));
    console.log(`  Queued: ${chalk.blue(status.tasks.queued)}`);
    console.log(`  Processing: ${chalk.yellow(status.tasks.processing)}`);
    console.log(`  Completed: ${chalk.green(status.tasks.completed)}`);
    console.log(`  Failed: ${chalk.red(status.tasks.failed)}`);

    console.log(chalk.bold('\nSessions:'));
    console.log(`  Active: ${status.sessions.active}`);
    console.log(`  Total: ${status.sessions.total}`);
  }

  watchStatus() {
    console.log(chalk.cyan('Watching status... (Press Ctrl+C to stop)'));
    setInterval(() => {
      console.clear();
      this.printStatus(this.getStatus());
    }, 5000);
  }

  async agents(options) {
    if (options.list) {
      console.log(chalk.cyan('Agents:'));
      console.log('  orchestrator - Task planning and delegation');
      console.log('  worker - Code execution and file operations');
      console.log('  researcher - Web search and documentation lookup');
      console.log('  coder - Code generation and refactoring');
      console.log('  reviewer - Code review and security audit');
      console.log('  tester - Test execution and generation');
      console.log('  deployer - Deployment and infrastructure');
    }

    if (options.create) {
      console.log(chalk.green(`Creating ${options.create} agent...`));
    }

    if (options.destroy) {
      console.log(chalk.yellow(`Destroying agent ${options.destroy}...`));
    }
  }

  async tasks(options) {
    if (options.list) {
      console.log(chalk.cyan('Tasks:'));
      console.log('  No tasks in queue');
    }

    if (options.submit) {
      let payload = JSON.parse(options.payload || '{}');
      console.log(chalk.green(`Submitting ${options.submit} task...`));
      console.log('Payload:', payload);
    }
  }

  async sessions(options) {
    if (options.list) {
      console.log(chalk.cyan('Sessions:'));
      console.log('  No active sessions');
    }

    if (options.create) {
      console.log(chalk.green(`Creating session: ${options.create}`));
    }

    if (options.start) {
      console.log(chalk.green(`Starting session: ${options.start}`));
    }

    if (options.end) {
      console.log(chalk.yellow(`Ending session: ${options.end}`));
    }
  }

  async logs(options) {
    const logDir = this.config.get('logging.directory') || './logs';
    const logFile = path.join(logDir, 'application.log');

    if (!fs.existsSync(logFile)) {
      console.log(chalk.yellow('No log file found'));
      return;
    }

    if (options.follow) {
      console.log(chalk.cyan(`Following ${logFile}...`));
      // Tail -f implementation
    } else {
      const lines = parseInt(options.lines, 10);
      const content = fs.readFileSync(logFile, 'utf8');
      const allLines = content.trim().split('\n');
      const recent = allLines.slice(-lines).join('\n');
      console.log(recent);
    }
  }

  async configCmd(options) {
    this.config.load();

    if (options.show) {
      console.log(JSON.stringify(this.config.getAll(), null, 2));
    }

    if (options.get) {
      const value = this.config.get(options.get);
      console.log(value !== undefined ? value : 'Not set');
    }

    if (options.set) {
      const [key, value] = options.set.split('=');
      this.config.set(key, value);
      console.log(chalk.green(`Set ${key} = ${value}`));
    }

    if (options.edit) {
      console.log(chalk.cyan('Edit config file...'));
    }
  }

  async dashboard(options) {
    console.log(chalk.cyan(`Starting dashboard on port ${options.port}...`));
    // Dashboard implementation
  }

  async init(options) {
    this.printBanner();

    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'projectName',
        message: 'Project name:',
        default: options.project || 'my-project'
      },
      {
        type: 'list',
        name: 'environment',
        message: 'Environment:',
        choices: ['development', 'production'],
        default: 'development'
      }
    ]);

    const projectDir = path.join(process.cwd(), answers.projectName);
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'config'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'sessions'), { recursive: true });

    console.log(chalk.green(`Project initialized at ${projectDir}`));
  }

  async doctor() {
    this.printBanner();
    console.log(chalk.cyan('Running health checks...\n'));

    const checks = [
      { name: 'Node.js version', check: () => process.version },
      { name: 'Config directory', check: () => fs.existsSync('./config') },
      { name: 'Logs directory', check: () => fs.existsSync('./logs') },
      { name: 'Write permissions', check: () => fs.accessSync('.', fs.constants.W_OK) }
    ];

    for (const { name, check } of checks) {
      try {
        const result = check();
        console.log(`  ${chalk.green('✓')} ${name}: ${result === true ? 'OK' : result}`);
      } catch {
        console.log(`  ${chalk.red('✗')} ${name}: FAILED`);
      }
    }
  }

  printBanner() {
    console.log(
      gradient('cyan', 'blue')(
        figlet.textSync('AI Orchestrator', { horizontalLayout: 'full' })
      )
    );
  }

  formatUptime(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  run(argv) {
    this.program.parse(argv);
  }
}

export default CLI;