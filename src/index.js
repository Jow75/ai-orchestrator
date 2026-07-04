/**
 * index.js — Programmatic entry point (library surface).
 *
 * `require`/`import` AI-Orchestrator as a library:
 *
 *   import { App } from 'ai-orchestrator';
 *   const result = await new App().start({ projectName: 'my-project' });
 *
 * The CLI (bin/ai-orchestrator.js) is a thin wrapper over the same exports.
 */

export { App } from './app.js';
export { Orchestrator, EVENTS } from './core/orchestrator.js';
export { ExitCause, classifyExit } from './core/exitClassifier.js';
export { RateLimitEngine } from './core/rateLimitEngine.js';
export { CrashRecoveryEngine } from './core/crashRecoveryEngine.js';
export { ProcessSupervisor } from './core/processSupervisor.js';
export { AIDriver, AgentRun } from './drivers/aiDriver.js';
export { ClaudeDriver } from './drivers/claudeDriver.js';
export { MockDriver } from './drivers/mockDriver.js';
export { DriverRegistry } from './drivers/driverRegistry.js';
export { ConfigManager, ConfigError } from './config/configManager.js';
export { SessionManager, SessionState } from './state/sessionManager.js';
export { StatusManager } from './state/statusManager.js';
export { Heartbeat } from './state/heartbeat.js';
export { NotificationEngine } from './notifications/notificationEngine.js';
export { PluginManager } from './plugins/pluginManager.js';
export { DashboardServer } from './api/dashboardServer.js';
