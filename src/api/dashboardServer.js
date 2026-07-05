/**
 * dashboardServer.js — Dashboard API.
 *
 * A small read-only HTTP API exposing live status, sessions, and history.
 * This is the integration surface for the future web dashboard (and for
 * anything else: curl, scripts, monitoring). It changes nothing and can be
 * disabled entirely via config `api.enabled`.
 *
 * Binds to 127.0.0.1 by default — widening the host is a deliberate,
 * documented decision for the user, not a default.
 */

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';

export class DashboardServer {
  /**
   * @param {object} deps
   * @param {object} deps.config - The `api` config block ({enabled, host, port}).
   * @param {object} deps.logger - Module logger.
   * @param {import('../state/statusManager.js').StatusManager} deps.statusManager
   * @param {import('../state/sessionManager.js').SessionManager} deps.sessionManager
   * @param {import('../config/configManager.js').ConfigManager} deps.configManager
   * @param {import('../state/missionTimeline.js').MissionTimeline} [deps.timeline]
   */
  constructor({ config, logger, statusManager, sessionManager, configManager, timeline }) {
    this.config = config;
    this.logger = logger;
    this.statusManager = statusManager;
    this.sessionManager = sessionManager;
    this.configManager = configManager;
    this.timeline = timeline;
    this.server = null;
    this.app = this.buildApp();
  }

  buildApp() {
    const app = express();
    app.use(helmet());
    app.use(cors());
    app.disable('x-powered-by');

    // Liveness probe.
    app.get('/api/health', (req, res) => {
      res.json({ ok: true, pid: process.pid, uptimeMs: Math.round(process.uptime() * 1000) });
    });

    // The same data as status.json, straight from memory.
    app.get('/api/status', (req, res) => {
      res.json(this.statusManager.get());
    });

    // All projects with active sessions.
    app.get('/api/sessions', (req, res) => {
      res.json(this.sessionManager.listActiveSessions());
    });

    // Finished-session history for one project.
    app.get('/api/sessions/:project/history', (req, res) => {
      res.json(this.sessionManager.getHistory(req.params.project));
    });

    // Mission timeline for one project (key events over time).
    app.get('/api/timeline/:project', (req, res) => {
      res.json(this.timeline ? this.timeline.read(req.params.project) : []);
    });

    // Defined projects and whether each currently has an active session.
    app.get('/api/projects', (req, res) => {
      const active = new Set(
        this.sessionManager.listActiveSessions().map((s) => s.project)
      );
      res.json(
        this.configManager.listProjects().map((name) => ({
          name,
          hasActiveSession: active.has(name),
        }))
      );
    });

    app.use((req, res) => {
      res.status(404).json({ error: 'Not found' });
    });

    return app;
  }

  /** Start listening. Failure to bind is logged but never fatal. */
  async start() {
    if (!this.config.enabled) {
      this.logger.info('Dashboard API disabled by configuration');
      return;
    }

    await new Promise((resolve) => {
      this.server = this.app.listen(this.config.port, this.config.host, () => {
        this.logger.info('Dashboard API listening', {
          url: `http://${this.config.host}:${this.config.port}/api/status`,
        });
        resolve();
      });
      this.server.on('error', (error) => {
        // The API is observability, not supervision — degrade gracefully.
        this.logger.warn('Dashboard API failed to start (continuing without it)', {
          error: error.message,
        });
        this.server = null;
        resolve();
      });
    });
  }

  /** Stop listening (clean shutdown). */
  async stop() {
    if (!this.server) return;
    await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
  }
}

export default DashboardServer;
