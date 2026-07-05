/**
 * defaults.js — Every tunable value in AI-Orchestrator lives here.
 *
 * Rule of the codebase: no magic numbers inline. If a module needs a
 * threshold, interval, or retry count, it comes from configuration, and the
 * documented default is defined in this file.
 *
 * Users override these in `config/orchestrator.json`; nothing here requires
 * a code edit for normal operation.
 */

export const ORCHESTRATOR_DEFAULTS = {
  /** Logging engine settings (see src/infra/logger.js). */
  logging: {
    level: 'info',
    console: true,
    file: true,
    maxFiles: '14d',
    maxSize: '10m',
  },

  /** Dashboard/status HTTP API (see src/api/dashboardServer.js). */
  api: {
    enabled: true,
    host: '127.0.0.1', // local-only by default; widen deliberately
    port: 4711,
  },

  /** Passive supervision cadence (see src/core/processSupervisor.js). */
  supervision: {
    /** How often status.json is refreshed while a session runs. */
    statusUpdateIntervalMs: 5_000,
    /** How often the heartbeat file is stamped (reboot detection). */
    heartbeatIntervalMs: 15_000,
    /** How often child processes of the agent are enumerated (observability only). */
    childProcessScanIntervalMs: 60_000,
  },

  /** Crash recovery policy (see src/core/crashRecoveryEngine.js). */
  recovery: {
    /** Consecutive crashes before the orchestrator gives up and notifies. */
    maxConsecutiveCrashes: 5,
    /** First restart delay after a crash; doubles each consecutive crash. */
    crashBackoffBaseMs: 15_000,
    /** Upper bound for the crash restart delay. */
    crashBackoffMaxMs: 900_000, // 15 minutes
    /** Delay before retrying after a network-related failure. */
    networkRetryDelayMs: 60_000,
  },

  /**
   * Progress awareness & loop prevention (see src/core/loopBreaker.js,
   * src/progress/workspaceSignature.js). This is the safeguard that makes
   * an unbounded no-progress relaunch loop impossible.
   */
  progress: {
    /** Master switch. When false, the orchestrator reverts to marker-only
     *  completion (the v1 behaviour) — not recommended for unattended runs. */
    enabled: true,
    /**
     * Consecutive completed-but-unfinished runs that change nothing in the
     * workspace before the circuit breaker trips and stops (with a
     * diagnostic report). This is the primary guard against quota burn.
     */
    maxConsecutiveNoProgress: 3,
    /**
     * Pause between continue-relaunches. Gives long child work time to
     * settle and caps how fast a growing conversation can spend quota.
     * Abortable by an operator stop. 0 disables the delay.
     */
    interRunDelayMs: 15_000,
    /**
     * Treat a specific "agent is blocked" message (e.g. permission denied)
     * combined with no progress as an immediate stop, rather than waiting
     * for the consecutive-no-progress threshold.
     */
    blockedDetection: true,
  },

  /** Usage-limit handling (see src/core/rateLimitEngine.js). */
  rateLimit: {
    /** Shortest allowed wait (guards against hot-looping on bad parses). */
    minWaitMs: 5_000,
    /** Wait applied when the reset time cannot be parsed from output. */
    defaultWaitMs: 3_600_000, // 1 hour
    /** Never sleep longer than this in one stretch, even if told to. */
    maxWaitMs: 21_600_000, // 6 hours
    /** Extra margin added past the announced reset time. */
    resumeGraceMs: 60_000,
  },

  /** Notification channels (see src/notifications/). All opt-in except desktop. */
  notifications: {
    /** Which orchestrator events produce notifications. */
    events: [
      'session:rate-limited',
      'session:crashed',
      'session:gave-up',
      'mission:blocked',
      'mission:complete',
      'orchestrator:recovered-after-reboot',
    ],
    desktop: { enabled: true },
    webhook: { enabled: false, url: '' },
    discord: { enabled: false, webhookUrl: '' },
    telegram: { enabled: false, botToken: '', chatId: '' },
    email: { enabled: false, smtp: {}, from: '', to: '' },
  },

  /** Plugin system (see src/plugins/pluginManager.js). */
  plugins: {
    enabled: true,
  },

  /** Project launched when `ai-orchestrator start` is run with no name. */
  defaultProject: '',

  /** Optional path overrides (see src/infra/paths.js). */
  paths: {},
};

export const PROJECT_DEFAULTS = {
  enabled: true,
  driver: 'claude',

  /** Mission control: how the orchestrator decides a project is finished. */
  mission: {
    /**
     * When the agent's final output contains this marker, the mission is
     * complete and supervision ends. The prompt should instruct the agent
     * to print it only when everything is done.
     */
    completionMarker: 'MISSION COMPLETE',
    /** Prompt used when resuming an interrupted or unfinished session. */
    continuePrompt:
      'Continue from where you left off. Review your progress so far, ' +
      'then carry on with the next unfinished task. Do not repeat completed work.',
    /** Safety valve: max launches per mission. 0 = unlimited. */
    maxRuns: 0,
  },

  /** Claude Code driver settings (see src/drivers/claudeDriver.js). */
  claude: {
    executable: 'claude',
    model: '',
    permissionMode: '',
    dangerouslySkipPermissions: false,
    allowedTools: [],
    disallowedTools: [],
    maxTurns: 0, // 0 = engine default
    extraArgs: [],
    /**
     * Startup watchdog: log a warning if the engine produces no output at
     * all within this window after launch. Observability only — the
     * orchestrator never kills a silent process. 0 disables the warning.
     */
    launchTimeoutMs: 120_000,
  },
};

export default { ORCHESTRATOR_DEFAULTS, PROJECT_DEFAULTS };
