import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { AIDriver } from './base.js';

export class ClaudeDriver extends AIDriver {
  constructor(options = {}) {
    super({
      id: 'claude',
      name: 'Claude Code',
      version: '1.0.0',
      capabilities: [
        'code-generation',
        'code-editing',
        'file-operations',
        'command-execution',
        'git-operations',
        'testing',
        'debugging',
        'refactoring',
        'documentation',
        'task-planning'
      ],
      maxRestarts: options.maxRestarts || 3,
      logger: options.logger || console,
      ...options
    });

    this.claudePath = options.claudePath || 'claude';
    this.workingDir = options.workingDir || process.cwd();
    this.env = { ...process.env, ...options.env };
    this.args = options.args || [];
    this.sessionFile = options.sessionFile || null;
    this.outputBuffer = '';
    this.errorBuffer = '';
    this.messageHandlers = new Map();
    this.lastOutput = null;
    this.lastOutputTime = null;
    this.heartbeatInterval = null;
    this.config.heartbeatInterval || 30000;
    this.idleTimeout = this.config.idleTimeout || 300000;
    this.checkIdleTimer = null;
  }

  async initialize(config = {}) {
    await super.initialize(config);

    this.claudePath = config.claudePath || this.claudePath;
    this.workingDir = config.workingDir || this.workingDir;
    this.env = { ...this.env, ...config.env };
    this.args = config.args || this.args;
    this.sessionFile = config.sessionFile || this.sessionFile;

    try {
      await this.verifyInstallation();
      this.status = 'ready';
      this.logger.info('Claude Code driver initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize Claude driver', { error: error.message });
      throw error;
    }

    return this;
  }

  async verifyInstallation() {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.claudePath, ['--version'], { env: this.env });
      let output = '';

      proc.stdout.on('data', data => output += data.toString());
      proc.stderr.on('data', data => output += data.toString());

      proc.on('close', code => {
        if (code === 0) {
          this.logger.info(`Claude CLI found: ${output.trim()}`);
          resolve();
        } else {
          reject(new Error(`Claude CLI not found or failed: ${output}`));
        }
      });

      proc.on('error', err => {
        reject(new Error(`Failed to execute Claude CLI: ${err.message}`));
      });
    });
  }

  async start(sessionId, options = {}) {
    if (this.isRunning()) {
      this.logger.warn('Claude driver already running');
      return this.getStatus();
    }

    this.sessionId = sessionId;
    this.startTime = Date.now();
    this.outputBuffer = '';
    this.errorBuffer = '';

    const args = this.buildArgs(options);
    this.logger.info(`Starting Claude session: ${sessionId}`, { args });

    this.process = spawn(this.claudePath, args, {
      cwd: this.workingDir,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.setupProcessHandlers();
    this.startIdleMonitor();

    this.status = 'starting';

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Claude startup timeout'));
      }, 30000);

      this.once('ready', () => {
        clearTimeout(timeout);
        this.status = 'running';
        this.logger.info(`Claude session started: ${sessionId}`);
        resolve(this.getStatus());
      });

      this.once('error', (err) => {
        clearTimeout(timeout);
        this.status = 'error';
        reject(err);
      });
    });
  }

  buildArgs(options) {
    const args = [...this.args];

    if (options.resume && this.sessionFile) {
      args.push('--resume', this.sessionFile);
    }

    if (options.prompt) {
      args.push('-p', options.prompt);
    }

    if (options.model) {
      args.push('--model', options.model);
    }

    if (options.maxTurns) {
      args.push('--max-turns', options.maxTurns.toString());
    }

    if (options.allowedTools) {
      args.push('--allowed-tools', options.allowedTools.join(','));
    }

    if (options.disallowedTools) {
      args.push('--disallowed-tools', options.disallowedTools.join(','));
    }

    if (options.permissionMode) {
      args.push('--permission-mode', options.permissionMode);
    }

    return args;
  }

  setupProcessHandlers() {
    this.process.stdout.on('data', data => {
      const text = data.toString();
      this.outputBuffer += text;
      this.lastOutput = text;
      this.lastOutputTime = Date.now();
      this.emit('output', text);
      this.processOutput(text);
    });

    this.process.stderr.on('data', data => {
      const text = data.toString();
      this.errorBuffer += text;
      this.logger.debug('Claude stderr', { text });
      this.emit('error-output', text);
    });

    this.process.on('close', (code, signal) => {
      this.logger.info(`Claude process exited`, { code, signal, sessionId: this.sessionId });
      this.handleExit(code, signal);
    });

    this.process.on('error', err => {
      this.logger.error('Claude process error', { error: err.message });
      this.emit('error', err);
      this.handleError(err);
    });
  }

  processOutput(text) {
    if (text.includes('Ready') || text.includes('ready') || text.includes('>')) {
      this.emit('ready');
    }

    if (text.includes('Usage limit') || text.includes('rate limit') || text.includes('quota exceeded')) {
      this.emit('rate-limit', { text });
    }

    if (text.includes('Error:') || text.includes('error:')) {
      this.emit('error-detected', { text });
    }

    for (const [pattern, handler] of this.messageHandlers) {
      if (text.match(pattern)) {
        handler(text);
      }
    }
  }

  handleExit(code, signal) {
    this.stopIdleMonitor();
    this.status = 'stopped';

    const exitInfo = {
      code,
      signal,
      sessionId: this.sessionId,
      uptime: this.startTime ? Date.now() - this.startTime : 0,
      output: this.outputBuffer.slice(-10000),
      error: this.errorBuffer.slice(-5000)
    };

    if (code === 0) {
      this.emit('completed', exitInfo);
    } else if (code === 130 || signal === 'SIGINT') {
      this.emit('interrupted', exitInfo);
    } else if (this.isRateLimitExit(code, this.outputBuffer)) {
      this.emit('rate-limit-exit', exitInfo);
    } else {
      this.emit('crashed', exitInfo);
    }
  }

  isRateLimitExit(code, output) {
    const rateLimitPatterns = [
      'usage limit',
      'rate limit',
      'quota exceeded',
      'too many requests',
      'limit reached'
    ];
    return rateLimitPatterns.some(p => output.toLowerCase().includes(p));
  }

  handleError(err) {
    this.stopIdleMonitor();
    this.status = 'error';
    this.emit('error', err);
  }

  async stop(graceful = true) {
    if (!this.process) {
      this.logger.warn('No process to stop');
      return;
    }

    this.logger.info('Stopping Claude process...', { graceful });

    if (graceful) {
      this.process.stdin.write('/exit\n');
      await new Promise(resolve => setTimeout(resolve, 2000));

      if (!this.process.killed) {
        this.process.kill('SIGTERM');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    if (!this.process.killed) {
      this.process.kill('SIGKILL');
    }

    this.stopIdleMonitor();
    this.process = null;
    this.status = 'stopped';
  }

  async sendMessage(message) {
    if (!this.process || this.status !== 'running') {
      throw new Error('Claude process not running');
    }

    this.process.stdin.write(message + '\n');
    this.lastOutputTime = Date.now();
  }

  async resume(sessionId, context = {}) {
    this.logger.info(`Resuming Claude session: ${sessionId}`);
    return this.start(sessionId, { resume: true, context });
  }

  onOutput(pattern, handler) {
    this.messageHandlers.set(pattern, handler);
  }

  offOutput(pattern) {
    this.messageHandlers.delete(pattern);
  }

  startIdleMonitor() {
    this.checkIdleTimer = setInterval(() => {
      if (this.lastOutputTime && Date.now() - this.lastOutputTime > this.idleTimeout) {
        this.logger.warn('Claude appears idle', {
          sessionId: this.sessionId,
          idleTime: Date.now() - this.lastOutputTime
        });
        this.emit('idle', { sessionId: this.sessionId });
      }
    }, this.heartbeatInterval);
  }

  stopIdleMonitor() {
    if (this.checkIdleTimer) {
      clearInterval(this.checkIdleTimer);
      this.checkIdleTimer = null;
    }
  }

  getFullOutput() {
    return this.outputBuffer;
  }

  getErrorOutput() {
    return this.errorBuffer;
  }

  getLastOutput() {
    return this.lastOutput;
  }
}

export default ClaudeDriver;