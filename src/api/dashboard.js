import express from 'express';
import { Server as SocketIOServer } from 'socket.io';
import http from 'http';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';

export class DashboardAPI {
  constructor(options = {}) {
    this.config = options.config || {};
    this.logger = options.logger || console;
    this.orchestrator = options.orchestrator || null;
    this.sessionManager = options.sessionManager || null;
    this.statusManager = options.statusManager || null;
    this.eventEmitter = options.eventEmitter || new (require('events').EventEmitter)();

    this.app = express();
    this.server = http.createServer(this.app);
    this.io = new SocketIOServer(this.server, {
      cors: {
        origin: this.config.corsOrigin || '*',
        methods: ['GET', 'POST']
      }
    });

    this.rateLimiter = rateLimit({
      windowMs: this.config.rateLimitWindow || 900000, // 15 minutes
      max: this.config.rateLimitMax || 100
    });

    this.setupMiddleware();
    this.setupRoutes();
    this.setupSocketIO();
  }

  setupMiddleware() {
    this.app.use(helmet());
    this.app.use(cors());
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));
    this.app.use(this.rateLimiter);

    // Static files
    const publicPath = path.join(process.cwd(), 'public');
    if (fs.existsSync(publicPath)) {
      this.app.use(express.static(publicPath));
    }

    this.app.use((req, res, next) => {
      this.logger.debug([\ \ \);
      next();
    });
  }

  setupRoutes() {
    // Health check
    this.app.get('/health', (req, res) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    // API routes
    this.app.get('/api/status', (req, res) => {
      if (this.statusManager) {
        res.json(this.statusManager.getStatus());
      } else {
        res.json({ status: 'unknown' });
      }
    });

    this.app.get('/api/orchestrator', (req, res) => {
      if (this.orchestrator) {
        res.json(this.orchestrator.getStats());
      } else {
        res.status(503).json({ error: 'Orchestrator not available' });
      }
    });

    this.app.get('/api/agents', (req, res) => {
      if (this.orchestrator) {
        res.json(this.orchestrator.getAgentStatuses());
      } else {
        res.status(503).json({ error: 'Orchestrator not available' });
      }
    });

    this.app.get('/api/agents/:id', (req, res) => {
      if (this.orchestrator) {
        const agents = this.orchestrator.getAgentStatuses();
        const agent = agents.find(a => a.id === req.params.id);
        if (agent) {
          res.json(agent);
        } else {
          res.status(404).json({ error: 'Agent not found' });
        }
      } else {
        res.status(503).json({ error: 'Orchestrator not available' });
      }
    });

    this.app.post('/api/tasks', (req, res) => {
      if (this.orchestrator) {
        const task = this.orchestrator.submitTask(req.body);
        res.status(201).json(task.toJSON());
      } else {
        res.status(503).json({ error: 'Orchestrator not available' });
      }
    });

    this.app.get('/api/tasks', (req, res) => {
      if (this.orchestrator) {
        const stats = this.orchestrator.taskQueue.getStats();
        res.json(stats);
      } else {
        res.status(503).json({ error: 'Orchestrator not available' });
      }
    });

    this.app.get('/api/tasks/:id', (req, res) => {
      if (this.orchestrator) {
        const task = this.orchestrator.getTaskStatus(req.params.id);
        if (task) {
          res.json(task.toJSON());
        } else {
          res.status(404).json({ error: 'Task not found' });
        }
      } else {
        res.status(503).json({ error: 'Orchestrator not available' });
      }
    });

    this.app.get('/api/sessions', (req, res) => {
      if (this.sessionManager) {
        res.json(this.sessionManager.getAllSessions());
      } else {
        res.status(503).json({ error: 'Session manager not available' });
      }
    });

    this.app.post('/api/sessions', (req, res) => {
      if (this.sessionManager) {
        const session = this.sessionManager.createSession(req.body);
        res.status(201).json(session);
      } else {
        res.status(503).json({ error: 'Session manager not available' });
      }
    });

    this.app.get('/api/sessions/:id', (req, res) => {
      if (this.sessionManager) {
        const session = this.sessionManager.getSession(req.params.id);
        if (session) {
          res.json(session);
        } else {
          res.status(404).json({ error: 'Session not found' });
        }
      } else {
        res.status(503).json({ error: 'Session manager not available' });
      }
    });

    this.app.put('/api/sessions/:id/start', (req, res) => {
      if (this.sessionManager) {
        const session = this.sessionManager.startSession(req.params.id);
        res.json(session);
      } else {
        res.status(503).json({ error: 'Session manager not available' });
      }
    });

    this.app.put('/api/sessions/:id/end', (req, res) => {
      if (this.sessionManager) {
        const session = this.sessionManager.endSession(req.params.id, req.body.status);
        res.json(session);
      } else {
        res.status(503).json({ error: 'Session manager not available' });
      }
    });

    this.app.post('/api/sessions/:id/checkpoint', (req, res) => {
      if (this.sessionManager) {
        const checkpoint = this.sessionManager.createCheckpoint(req.params.id, req.body.label);
        res.json(checkpoint);
      } else {
        res.status(503).json({ error: 'Session manager not available' });
      }
    });

    this.app.get('/api/config', (req, res) => {
      if (this.orchestrator && this.orchestrator.config) {
        res.json(this.orchestrator.config.getAll());
      } else {
        res.status(503).json({ error: 'Config not available' });
      }
    });

    this.app.get('/api/metrics', (req, res) => {
      if (this.statusManager) {
        res.json(this.statusManager.getStatus().metrics);
      } else {
        res.status(503).json({ error: 'Status manager not available' });
      }
    });

    this.app.get('/api/logs', (req, res) => {
      const logDir = this.config.logDir || './logs';
      const logFile = path.join(logDir, 'application.log');
      
      if (fs.existsSync(logFile)) {
        const lines = parseInt(req.query.lines) || 100;
        const content = fs.readFileSync(logFile, 'utf8');
        const allLines = content.trim().split('\n');
        const recent = allLines.slice(-lines).join('\n');
        res.type('text/plain').send(recent);
      } else {
        res.status(404).send('Log file not found');
      }
    });

    // Serve dashboard HTML
    this.app.get('/', (req, res) => {
      const dashboardPath = path.join(process.cwd(), 'public', 'index.html');
      if (fs.existsSync(dashboardPath)) {
        res.sendFile(dashboardPath);
      } else {
        res.send(this.getDefaultDashboard());
      }
    });

    // Error handling
    this.app.use((err, req, res, next) => {
      this.logger.error('Dashboard API Error', { error: err.message, stack: err.stack });
      res.status(500).json({ error: 'Internal server error' });
    });
  }

  setupSocketIO() {
    this.io.on('connection', (socket) => {
      this.logger.info(\Socket.IO client connected: \\);

      socket.on('disconnect', () => {
        this.logger.info(\Socket.IO client disconnected: \\);
      });

      socket.on('subscribe', (data) => {
        const { events } = data;
        if (Array.isArray(events)) {
          socket.data.subscriptions = events;
          socket.emit('subscribed', { events });
        }
      });

      socket.on('unsubscribe', (data) => {
        const { events } = data;
        if (Array.isArray(events)) {
          socket.data.subscriptions = (socket.data.subscriptions || []).filter(e => !events.includes(e));
          socket.emit('unsubscribed', { events });
        }
      });

      socket.on('get-status', async () => {
        if (this.statusManager) {
          socket.emit('status-update', this.statusManager.getStatus());
        }
      });

      socket.on('get-agents', async () => {
        if (this.orchestrator) {
          socket.emit('agents-update', this.orchestrator.getAgentStatuses());
        }
      });

      socket.on('get-tasks', async () => {
        if (this.orchestrator) {
          socket.emit('tasks-update', this.orchestrator.taskQueue.getStats());
        }
      });

      socket.on('get-sessions', async () => {
        if (this.sessionManager) {
          socket.emit('sessions-update', this.sessionManager.getAllSessions());
        }
      });

      socket.on('get-metrics', async () => {
        if (this.statusManager) {
          socket.emit('metrics-update', this.statusManager.getStatus().metrics);
        }
      });

      // Set up event listeners for real-time updates
      if (this.statusManager) {
        this.statusManager.on('health:check', (data) => {
          this.io.emit('health-update', data);
        });

        this.statusManager.on('orchestrator:status', (data) => {
          this.io.emit('orchestrator-status', data);
        });

        this.statusManager.on('agents:updated', (data) => {
          this.io.emit('agents-update', data);
        });

        this.statusManager.on('tasks:updated', (data) => {
          this.io.emit('tasks-update', data);
        });

        this.statusManager.on('sessions:updated', (data) => {
          this.io.emit('sessions-update', data);
        });

        this.statusManager.on('metrics:updated', (data) => {
          this.io.emit('metrics-update', data);
        });
      }

      if (this.orchestrator) {
        this.orchestrator.on('agent:created', (agent) => {
          this.io.emit('agent-created', agent.getStatus());
        });

        this.orchestrator.on('agent:destroyed', (agent) => {
          this.io.emit('agent-destroyed', agent.getStatus());
        });

        this.orchestrator.on('task:submitted', (task) => {
          this.io.emit('task-submitted', task.toJSON());
        });

        this.orchestrator.on('task:completed', (data) => {
          this.io.emit('task-completed', {
            task: data.task.toJSON(),
            result: data.result
          });
        });

        this.orchestrator.on('task:failed', (data) => {
          this.io.emit('task-failed', {
            task: data.task.toJSON(),
            error: data.error
          });
        });
      }
    });
  }

  async start() {
    const port = this.config.port || 3000;
    const host = this.config.host || '127.0.0.1';

    return new Promise((resolve) => {
      this.server.listen(port, host, () => {
        this.logger.info(\Dashboard API started on http://\System.Management.Automation.Internal.Host.InternalHost:\\);
        resolve();
      });
    });
  }

  async stop() {
    return new Promise((resolve) => {
      this.io.close();
      this.server.close(() => {
        this.logger.info('Dashboard API stopped');
        resolve();
      });
    });
  }

  getApp() {
    return this.app;
  }

  getServer() {
    return this.server;
  }

  getIO() {
    return this.io;
  }

  getDefaultDashboard() {
    return 
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AI Orchestrator Dashboard</title>
    <script src="/socket.io/socket.io.js"></script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; color: #333; }
        .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 10px; margin-bottom: 20px; text-align: center; }
        .header h1 { margin: 0; font-size: 2.5rem; }
        .header p { opacity: 0.9; margin-top: 5px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; margin-bottom: 20px; }
        .card { background: white; border-radius: 10px; padding: 20px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .card h3 { margin-top: 0; color: #333; display: flex; align-items: center; }
        .card h3 i { margin-right: 10px; color: #667eea; }
        .metric { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #eee; }
        .metric:last-child { border-bottom: none; }
        .metric-value { font-weight: bold; font-size: 1.2em; }
        .status-indicator { display: inline-block; width: 12px; height: 12px; border-radius: 50%; margin-right: 8px; }
        .status-running { background: #4caf50; }
        .status-stopped { background: #f44336; }
        .status-idle { background: #ff9800; }
        .status-error { background: #f44336; }
        .status-ready { background: #2196f3; }
        .status-degraded { background: #ff9800; }
        .status-healthy { background: #4caf50; }
        .table { width: 100%; border-collapse: collapse; margin-top: 10px; }
        .table th, .table td { padding: 12px; text-align: left; border-bottom: 1px solid #ddd; }
        .table th { background-color: #f2f2f2; font-weight: 600; }
        .table tr:hover { background-color: #f5f5f5; }
        .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 0.8em; font-weight: 600; }
        .badge-success { background: #d4edda; color: #155724; }
        .badge-warning { background: #fff3cd; color: #856404; }
        .badge-danger { background: #f8d7da; color: #721c24; }
        .badge-info { background: #d1ecf1; color: #0c5460; }
        .footer { text-align: center; margin-top: 30px; color: #666; font-size: 0.9em; }
        .loading { text-align: center; padding: 20px; color: #666; }
        .refresh-btn { background: #667eea; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; }
        .refresh-btn:hover { background: #5a67d8; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🤖 AI Orchestrator Dashboard</h1>
            <p>Real-time monitoring of your AI agent ecosystem</p>
        </div>
        
        <div class="grid">
            <div class="card">
                <h3><i class="fas fa-robot"></i> Orchestrator Status</h3>
                <div id="orchestrator-status" class="loading">Loading...</div>
            </div>
            
            <div class="card">
                <h3><i class="fas fa-users"></i> Agents</h3>
                <div id="agents-status" class="loading">Loading...</div>
            </div>
            
            <div class="card">
                <h3><i class="fas fa-tasks"></i> Tasks</h3>
                <div id="tasks-status" class="loading">Loading...</div>
            </div>
            
            <div class="card">
                <h3><i class="fas fa-chart-line"></i> System Metrics</h3>
                <div id="metrics-status" class="loading">Loading...</div>
            </div>
        </div>
        
        <div class="grid">
            <div class="card">
                <h3><i class="fas fa-clock"></i> Sessions</h3>
                <div id="sessions-status" class="loading">Loading...</div>
            </div>
            
            <div class="card">
                <h3><i class="fas fa-file-alt"></i> Recent Logs</h3>
                <div id="logs-status" class="loading">Loading...</div>
            </div>
        </div>
        
        <div class="text-center">
            <button class="refresh-btn" id="refresh-btn">Refresh Data</button>
        </div>
        
        <div class="footer">
            <p>AI Orchestrator v1.0.0 | Last updated: <span id="last-updated">--</span></p>
        </div>
    </div>

    <script>
        const socket = io();
        let subscriptions = ['status', 'agents', 'tasks', 'sessions', 'metrics', 'logs'];
        
        // Subscribe to default events
        socket.emit('subscribe', { events: subscriptions });
        
        // Update functions
        function updateOrchestratorStatus(data) {
            const container = document.getElementById('orchestrator-status');
            if (!data) {
                container.innerHTML = '<p>No data available</p>';
                return;
                container.innerHTML =
            }
            
            const statusClass = 'status-' + (data.orchestrator.status || 'unknown');
            container.innerHTML =
                '<div class="metric">' +
                '<span>Status:</span>' +
                '<span class="metric-value"><span class="status-indicator ' + statusClass + '"></span>' + (data.orchestrator.status || 'unknown') + '</span>' +
                '</div>' +
                '<div class="metric">' +
                '<span>Uptime:</span>' +
                '<span class="metric-value">' + (data.orchestrator.uptime ? (data.orchestrator.uptime / 1000).toFixed(1) + 's' : '0s') + '</span>' +
                '</div>' +
                '<div class="metric">' +
                '<span>PID:</span>' +
                '<span class="metric-value">' + (data.orchestrator.pid || 'N/A') + '</span>' +
                '</div>';
        }
        
        function updateAgentsStatus(data) {
            const container = document.getElementById('agents-status');
            if (!data || !data.agents) {
                container.innerHTML = '<p>No agent data available</p>';
                return;
            }
            
            const total = data.agents.total || 0;
            const idle = data.agents.idle || 0;
            const busy = data.agents.busy || 0;
            const error = data.agents.error || 0;
            
            let html = '';
            html += '<div class="metric"><span>Total Agents:</span><span class="metric-value">' + total + '</span></div>';
            html += '<div class="metric"><span>Idle:</span><span class="metric-value badge badge-success">' + idle + '</span></div>';
            html += '<div class="metric"><span>Busy:</span><span class="metric-value badge badge-warning">' + busy + '</span></div>';
            html += '<div class="metric"><span>Error:</span><span class="metric-value badge badge-danger">' + error + '</span></div>';
            
            if (data.agents.byType) {
                html += '<h4>By Type:</h4>';
                for (const [type, count] of Object.entries(data.agents.byType)) {
                    html += '<div class="metric"><span>' + type + ':</span><span class="metric-value">' + count + '</span></div>';
                }
            }
            
            container.innerHTML = html;
        }
        
        function updateTasksStatus(data) {
            const container = document.getElementById('tasks-status');
            if (!data) {
                container.innerHTML = '<p>No task data available</p>';
                return;
            }
            
            const queued = data.queued || 0;
            const processing = data.processing || 0;
            const completed = data.completed || 0;
            const failed = data.failed || 0;
            
            let html = '';
            html += '<div class="metric"><span>Queued:</span><span class="metric-value badge badge-info">' + queued + '</span></div>';
            html += '<div class="metric"><span>Processing:</span><span class="metric-value badge badge-warning">' + processing + '</span></div>';
            html += '<div class="metric"><span>Completed:</span><span class="metric-value badge badge-success">' + completed + '</span></div>';
            html += '<div class="metric"><span>Failed:</span><span class="metric-value badge badge-danger">' + failed + '</span></div>';
            html += '<div class="metric"><span>Success Rate:</span><span class="metric-value">' + (completed > 0 ? ((completed / (completed + failed)) * 100).toFixed(1) + '%' : '0%') + '</span></div>';
            
            container.innerHTML = html;
        }
        
        function updateSessionsStatus(data) {
            const container = document.getElementById('sessions-status');
            if (!data || !data.sessions) {
                container.innerHTML = '<p>No session data available</p>';
                return;
            }
            
            const active = data.sessions.active || 0;
            const total = data.sessions.total || 0;
            
            let html = '';
            html += '<div class="metric"><span>Active Sessions:</span><span class="metric-value badge badge-info">' + active + '</span></div>';
            html += '<div<|reserved_token_163327|>assistant
It looks like the message got cut off. Let me finish writing the file properly.


<tool_call>
<function=bash>
<parameter=command>
# Continue writing the file
 += @"        }
        
        function updateSessionsStatus(data) {
            const container = document.getElementById('sessions-status');
            if (!data || !data.sessions) {
                container.innerHTML = '<p>No session data available</p>';
                return;
            }
            
            const active = data.sessions.active || 0;
            const total = data.sessions.total || 0;
            
            let html = '';
            html += '<div class="metric"><span>Active Sessions:</span><span class="metric-value badge badge-info">' + active + '</span></div>';
            html += '<div class="metric"><span>Total Sessions:</span><span class="metric-value">' + total + '</span></div>';
            
            container.innerHTML = html;
        }
        
        function updateMetricsStatus(data) {
            const container = document.getElementById('metrics-status');
            if (!data || !data.metrics) {
                container.innerHTML = '<p>No metrics data available</p>';
                return;
            }
            
            const tasksPerMinute = data.metrics.tasksPerMinute || 0;
            const avgTaskDuration = data.metrics.avgTaskDuration || 0;
            const errorRate = data.metrics.errorRate || 0;
            
            let html = '';
            html += '<div class="metric"><span>Tasks/Min:</span><span class="metric-value">' + tasksPerMinute.toFixed(1) + '</span></div>';
            html += '<div class="metric"><span>Avg Task Duration:</span><span class="metric-value">' + (avgTaskDuration / 1000).toFixed(1) + 's</span></div>';
            html += '<div class="metric"><span>Error Rate:</span><span class="metric-value">' + (errorRate * 100).toFixed(1) + '%</span></div>';
            
            container.innerHTML = html;
        }
        
        function updateLogsStatus(data) {
            const container = document.getElementById('logs-status');
            if (!data) {
                container.innerHTML = '<p>No log data available</p>';
                return;
            }
            
            const logs = data.logs || [];
            if (logs.length === 0) {
                container.innerHTML = '<p>No logs available</p>';
                return;
            }
            
            let html = '<ul style="text-align: left; max-height: 200px; overflow-y: auto;">';
            logs.slice(-10).forEach(log => {
                html += '<li>' + log + '</li>';
            });
            html += '</ul>';
            
            container.innerHTML = html;
        }
        
        // Socket event handlers
        socket.on('status-update', updateOrchestratorStatus);
        socket.on('agents-update', updateAgentsStatus);
        socket.on('tasks-update', updateTasksStatus);
        socket.on('sessions-update', updateSessionsStatus);
        socket.on('metrics-update', updateMetricsStatus);
        socket.on('logs-update', updateLogsStatus);
        socket.on('health-update', (data) => {
            // Handle health updates if needed
        });
        
        // Manual refresh
        document.getElementById('refresh-btn').addEventListener('click', () => {
            socket.emit('get-status');
            socket.emit('get-agents');
            socket.emit('get-tasks');
            socket.emit('get-sessions');
            socket.emit('get-metrics');
        });
        
        // Initial load
        socket.emit('get-status');
        socket.emit('get-agents');
        socket.emit('get-tasks');
        socket.emit('get-sessions');
        socket.emit('get-metrics');
        
        // Update timestamp
        setInterval(() => {
            document.getElementById('last-updated').textContent = new Date().toLocaleTimeString();
        }, 1000);
    </script>
    <!-- Font Awesome for icons -->
    <script src=""https://kit.fontawesome.com/a076d05399.js""></script>
</body>
</html>
    ";
  }
}

export default DashboardAPI;
