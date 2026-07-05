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
export { LoopBreaker, BreakerAction } from './core/loopBreaker.js';
export { detectBlockedState, BLOCKED_PATTERNS } from './core/blockedPatterns.js';
export { ExitReason, deriveExitReason, BLOCKED_REASONS } from './core/exitReason.js';
export { ProgressEngine, diffSnapshots, sampleChanges } from './progress/progressEngine.js';
export { assessConfidence, Confidence } from './progress/progressConfidence.js';
export { ProgressLedger } from './progress/progressLedger.js';
export { MissionTimeline } from './state/missionTimeline.js';
export { writeDiagnosticReport } from './report/diagnosticReport.js';
export {
  isLegacyMission, normalizeAndValidateTasks, getTaskAt, getTaskById,
  getTaskIndex, taskCount, DEFAULT_TASK_MAX_RUNS,
} from './mission/missionPlan.js';
export { TaskQueue } from './mission/taskQueue.js';
export { TaskState, TASK_RESUMABLE_STATES } from './mission/taskState.js';
export { buildCheckpoint } from './mission/checkpoint.js';
export {
  runVerifiers, isKnownVerifierType, listVerifierTypes,
} from './verify/verifierRegistry.js';
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
