import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { WebSocketServer } from 'ws';
import http from 'http';
import ConfigManager from '../utils/configManager.js';
import Logger from '../utils/logger.js';

class APIServer {
  constructor(options = {}) {
    this.config = options.config || new ConfigManager();
    this.logger = options.logger || new Logger();
    this.orchestrator = options.orchestrator || null;
    this.sessionManager = options.sessionManager || null;
    this.statusManager = options.statusManager || null;

    this.app = express();
    this.server = http.createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server });

    this.setupMiddleware();
    this.setupRoutes();
    this.setupWebSocket();
  }

  setupMiddleware() {
    this.app.use(helmet());
    this.app.use(cors(this.config.get('server.cors') || { origin: '*' }));
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true }));

    this.app.use((req, res, next) => {
      this.logger.debug(`${req.method} ${req.path}`);
      next();
    });
  }

  setupRoutes() {
    this.app.get('/health', (req, res) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

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
      res.json(this.config.getAll());
    });

    this.app.get('/api/metrics', (req, res) => {
      if (this.statusManager) {
        res.json(this.statusManager.getStatus().metrics);
      } else {
        res.status(503).json({ error: 'Status manager not available' });
      }
    });

    this.app.use((err, req, res, next) => {
      this.logger.error('API Error', { error: err.message, stack: err.stack });
      res.status(500).json({ error: 'Internal server error' });
    });
  }

  setupWebSocket() {
    this.wss.on('connection', (ws, req) => {
      this.logger.debug('WebSocket client connected');

      ws.on('message', (message) => {
        try {
          const data = JSON.parse(message);
          this.handleWebSocketMessage(ws, data);
        } catch (error) {
          this.logger.error('WebSocket message parse error', { error: error.message });
        }
      });

      ws.on('close', () => {
        this.logger.debug('WebSocket client disconnected');
      });

      ws.on('error', (error) => {
        this.logger.error('WebSocket error', { error: error.message });
      });

      this.sendWebSocket(ws, { type: 'welcome', payload: { message: 'Connected to AI Orchestrator' } });
    });

    if (this.statusManager) {
      this.statusManager.subscribe((status) => {
        this.broadcast({ type: 'status', payload: status });
      });
    }
  }

  handleWebSocketMessage(ws, message) {
    switch (message.type) {
      case 'ping':
        this.sendWebSocket(ws, { type: 'pong', payload: { timestamp: Date.now() } });
        break;
      case 'subscribe':
        if (message.payload?.events) {
          ws.subscriptions = message.payload.events;
        }
        break;
      default:
        this.logger.debug('Unknown WebSocket message type', { type: message.type });
    }
  }

  sendWebSocket(ws, message) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(message));
    }
  }

  broadcast(message) {
    this.wss.clients.forEach(client => {
      if (client.readyState === 1) {
        if (!client.subscriptions || client.subscriptions.includes(message.type)) {
          client.send(JSON.stringify(message));
        }
      }
    });
  }

  async start() {
    const port = this.config.get('server.port') || 3000;
    const host = this.config.get('server.host') || '127.0.0.1';

    return new Promise((resolve) => {
      this.server.listen(port, host, () => {
        this.logger.info(`API server started on http://${host}:${port}`);
        resolve();
      });
    });
  }

  async stop() {
    return new Promise((resolve) => {
      this.wss.close();
      this.server.close(() => {
        this.logger.info('API server stopped');
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
}

export default APIServer;