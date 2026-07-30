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
   * src/progress/progressEngine.js). This is the safeguard that makes
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

  /**
   * Phase P4: the Claude Continuation Builder (see
   * src/briefing/continuationBuilder.js). Replaces the bare
   * `mission.continuePrompt`/task `continuePrompt` string with a
   * structured briefing generated from live orchestrator state on every
   * resume/retry — completed vs. remaining tasks, and, on a
   * verification-failed retry, exactly which check failed and why.
   */
  briefing: {
    /** Master switch. `false` reverts to the static continuePrompt string. */
    enabled: true,
    /** How many recent progress-ledger entries to summarize in the briefing. */
    recentRunCount: 3,
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
      // Phase 10 events (see notificationEngine.js EVENT_MESSAGES).
      'approval:required',
      'human-action:required',
      'task:verification-failed',
      'release:created',
      'summary:daily',
      'summary:weekly',
    ],
    /**
     * Phase 10F: minimum severity a notification must have to be sent at
     * all ('info' | 'warning' | 'critical'). Each channel may set its own
     * `minSeverity` to receive only higher-severity events (e.g. keep the
     * desktop chatty but only page Telegram on 'critical').
     */
    minSeverity: 'info',
    /**
     * Phase 11 M2: idempotency for notifications that carry a stable
     * identity (approval/human-action requests). Once sent, the SAME
     * notification is never repeated just because a poll loop noticed the
     * request still exists — only a failed prior delivery, this interval
     * elapsing, or an explicit `notify resend` sends it again. 0 = never
     * remind automatically (send once, rely on resend/failure-retry).
     */
    reminderMs: 0,
    desktop: { enabled: true },
    webhook: { enabled: false, url: '' },
    discord: { enabled: false, webhookUrl: '' },
    telegram: { enabled: false, botToken: '', chatId: '' },
    /**
     * Phase 10C: real SMTP delivery (dependency-free client, see
     * src/notifications/smtpClient.js). `smtp` needs at least {host};
     * `port` defaults to 587 with STARTTLS, or set `secure: true` for
     * implicit TLS on 465. `user`/`pass` enable AUTH.
     */
    email: {
      enabled: false,
      smtp: { host: '', port: 587, secure: false, starttls: true, user: '', pass: '' },
      from: '',
      to: '',
    },
    /**
     * Phase 10G: periodic digest notifications, sent by `schedules watch`.
     * Times are local 24h "HH:MM"; weekly day is an English weekday name.
     */
    summaries: {
      daily: { enabled: false, time: '20:00' },
      weekly: { enabled: false, day: 'sunday', time: '18:00' },
    },
  },

  /**
   * Phase 10A/10B: the Approval Manager — classifies work into approval
   * classes and decides, per operating mode, what proceeds automatically
   * and what pauses for the owner (see src/approvals/).
   */
  approvals: {
    /** Master switch. When false, missions behave exactly as pre-Phase-10. */
    enabled: true,
    /**
     * Operating mode (10B): 'conservative' (everything requires approval),
     * 'balanced' (routine work proceeds; reviews and owner gates pause —
     * the default), or 'autonomous' (only owner gates and human-action
     * situations pause). A project may override with `approvals.mode`.
     */
    mode: 'balanced',
    /**
     * When an agent's final output contains this marker, the run is treated
     * as presenting an implementation plan: an implementation summary is
     * generated and published for review instead of continuing blindly.
     */
    planMarker: 'IMPLEMENTATION PLAN READY',
    /** How often to poll for an owner decision while paused. */
    decisionPollMs: 15_000,
    /**
     * Give up waiting for a decision after this long (0 = wait forever —
     * a paused mission is recoverable at any time, matching rate-limit waits).
     */
    decisionTimeoutMs: 0,
    /**
     * Category lists per approval class. Categories are free-form strings
     * used on tasks (`approval: "<category>"`), by the plan marker
     * ('implementation-plan') and by human-action detection. A category in
     * none of these lists fails CLOSED (treated as an owner gate).
     */
    automaticCategories: [
      'documentation', 'tests', 'lint', 'formatting', 'retry', 'refactoring',
      'implementation-continuation', 'report', 'commit', 'changelog',
    ],
    ownerGateCategories: [
      'production-deployment', 'data-deletion', 'repository-deletion',
      'credentials', 'financial', 'production-configuration', 'security',
      'secrets', 'dangerous',
    ],
    humanActionCategories: [
      'browser-permission', 'desktop-confirmation', 'authentication',
      'captcha', 'physical-interaction', 'external-login',
    ],
    /**
     * Phase 10C: remote approval providers. Telegram is two-way (APPROVE /
     * REJECT / MODIFY / DONE replies are polled); email is publish-only
     * (respond via CLI, API, desktop, or Telegram). Provider config falls
     * back to the matching `notifications` channel block when left empty,
     * so one bot/mailbox serves both systems.
     */
    providers: {
      telegram: { enabled: false, botToken: '', chatId: '' },
      email: { enabled: false, smtp: {}, from: '', to: '' },
    },
  },

  /**
   * Phase 10H: multi-agent/multi-mission coordination — resource locks and
   * parallel mission supervision (`start` with several projects).
   */
  coordination: {
    /** Max missions one `start` may supervise in parallel. */
    maxParallelMissions: 3,
    /** How often a mission re-checks a resource lock another mission holds. */
    lockPollMs: 10_000,
    /** A lock whose holding process died is reclaimable after this long. */
    staleLockMs: 3_600_000,
  },

  /**
   * Phase 10J: release automation (see src/release/releaseManager.js).
   * `apply` is approval-aware: `approvalCategory` decides its class
   * ('commit' is automatic in balanced mode; set an owner-gate category to
   * always require sign-off). Pushing to a remote is never automated.
   */
  release: {
    tagPrefix: 'v',
    approvalCategory: 'commit',
  },

  /** Plugin system (see src/plugins/pluginManager.js). */
  plugins: {
    enabled: true,
  },

  /**
   * Optional NVIDIA NIM driver (see src/drivers/nvidiaDriver.js) — a
   * fallback text-completion engine for when `claude` is unavailable.
   * Machine-wide credential, same shape as `notifications.telegram`: the
   * real `apiKey` belongs in `config/local.json` (git-ignored), never in
   * this tracked file. Empty `apiKey` ⇒ the driver reports itself
   * unconfigured via checkInstallation() rather than failing obscurely.
   */
  nvidia: {
    apiKey: '',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    model: 'nvidia/nemotron-3-ultra-550b-a55b',
    timeoutMs: 120_000,
  },

  /**
   * Phase 12 M2.1: the port registry (see src/runtime/portRegistry.js).
   *
   * The window automatic allocations are drawn from. It sits above the ports
   * frameworks scaffold into (3000, 4200, 5173, 8080) and below the ephemeral
   * range Windows assigns outbound sockets from (49152+) — allocating inside
   * that range produces a port that probes free and is stolen minutes later.
   *
   * Permanent reservations are NOT configured here: they are a human decision
   * about one project and live in config/ports.json.
   */
  ports: {
    range: { start: 5200, end: 5899 },
  },

  /**
   * Phase 12 M1: the Core Service (see src/daemon/). The daemon is the
   * always-running process that owns the API, the EXCLUSIVE Telegram inbound
   * poll, the scheduler tick, and mission worker lifecycle.
   *
   * Nothing here changes standalone behaviour: `ai-orchestrator start` never
   * consults this block. It only governs `ai-orchestrator serve` and the
   * workers that daemon spawns.
   */
  daemon: {
    /** Master switch for `serve`. False ⇒ the daemon refuses to start. */
    enabled: true,
    /**
     * How often the daemon polls two-way approval providers (Telegram) for
     * owner decisions. This poll runs whether or not a mission is waiting —
     * that is the entire point of the service — so it is deliberately slower
     * than the in-mission `approvals.decisionPollMs` used while a mission is
     * actively parked on a decision.
     */
    pollIntervalMs: 10_000,
    /** How often due scheduled missions are checked (Phase 10G). */
    schedulerTickMs: 60_000,
    /** Max mission workers the daemon supervises at once. */
    maxWorkers: 3,
    /** How often the supervisor re-probes worker liveness / reaps records. */
    workerScanMs: 10_000,
    /**
     * Restart a scheduled/started worker that exits without completing?
     * Off by default: the orchestrator already owns crash recovery INSIDE a
     * mission (src/core/crashRecoveryEngine.js), so daemon-level restarts
     * would stack two recovery policies on one failure.
     */
    restartFailedWorkers: false,
  },

  /**
   * Phase 12 M2: the Operator Interface (see src/operator/). Turns the remote
   * channel from "reply APPROVE A7" into a console you can run projects from.
   *
   * Like `daemon`, nothing here changes standalone behaviour: `ai-orchestrator
   * start` never consults this block. Only the Core Service reads it, and only
   * for the channel it exclusively owns.
   */
  operator: {
    /**
     * Master switch for the widened inbound command grammar. FALSE ⇒ the
     * service accepts exactly the `v2.8.0` message set (APPROVE/REJECT/
     * MODIFY/DONE and nothing else), which is the escape hatch if a wider
     * surface is ever unwanted. The approval grammar itself is never disabled
     * by this — it predates the operator interface and is orthogonal to it.
     */
    enabled: true,
    /**
     * Whether a free-text message may raise a MISSION REQUEST at all. Free
     * text NEVER starts work under any setting (see missionRequests.js): it
     * can only ever produce a proposal the owner must explicitly approve.
     * False ⇒ free text is answered with the help text instead.
     */
    acceptFreeText: true,
    /** Shortest free-text message treated as a mission objective. */
    minObjectiveChars: 12,
    /**
     * How long a destructive-action confirmation token stays valid. A
     * confirmation the owner forgot about must expire rather than sit there
     * waiting to be triggered by an unrelated "yes" days later.
     */
    confirmationTtlMs: 300_000, // 5 minutes
    /**
     * How long a mission request stays approvable before it expires. A
     * request approved a week after it was typed would run against a
     * workspace that has moved on.
     */
    requestTtlMs: 86_400_000, // 24 hours
    /** How often the daemon re-derives mission progress from state files. */
    progressIntervalMs: 15_000,
    /**
     * Push real phase changes (Planning → Coding → Testing …) to the remote
     * channel as they happen. Phase changes the mission itself already
     * notifies about (approval required, complete, blocked) are never
     * re-announced here — see missionMonitor.js WORKER_ANNOUNCED_STATES.
     */
    progressUpdates: true,
    /**
     * Never send more than one progress update per project per this window,
     * however fast the underlying state churns. A retry loop must not turn
     * into a notification storm on a phone.
     */
    progressMinIntervalMs: 60_000,
    /**
     * Roots the operator scans for real, unregistered projects (Phase 13 M2's
     * `/scan`/`/import`), AND the same roots a remotely-created project must
     * live under once Phase 12 M4 resumes (empty ⇒ that refuses outright).
     * One list serves both purposes deliberately — see docs/PHASE_13_PLAN.md
     * decision D1: the folders an owner trusts this system to discover
     * existing work in and the folders they'd trust it to create new work in
     * are the same trust boundary on a single-operator, single-machine
     * system. Defaults to the one folder every current project already lives
     * in; add more with `/roots add <path>` (Phase 13 M4).
     */
    projectRoots: ['C:\\Users\\Admin\\Music'],
    /**
     * Phase 13 M5: the machine-wide default provider/model, consulted only
     * when a project's own config is silent on it (an explicit per-project
     * `driver`/`claude.model` always wins — see drivers/claudeDriver.js).
     * An empty `defaultModel` ⇒ every driver's own built-in default
     * applies, unchanged from before this milestone existed. `defaultProvider`
     * starts at `'claude'` (matching `PROJECT_DEFAULTS.driver`) purely so
     * `/model <name>` has a provider to validate against out of the box —
     * this milestone ships no `/provider <name>` setter (`/provider` is
     * read-only display; see docs/PHASE_13_PLAN.md M5).
     */
    defaultProvider: 'claude',
    defaultModel: '',
    /**
     * Reconciliation pass, 2026-07-30: `/safemode on|off`. A global override,
     * independent of any project's own `claude.permissionMode` — while true,
     * `ClaudeDriver` never forwards `permissionMode`/`dangerouslySkipPermissions`
     * to the engine, so every project runs the same headless-default
     * behaviour (auto-deny writes) a project with no `permissionMode` set
     * already gets today. Off by default: existing per-project permission
     * choices keep working exactly as before this existed.
     */
    safeMode: false,
    /**
     * Phase 13 M2: how `/scan` looks for real projects under `projectRoots`.
     * Deliberately shallow (one configured root → its immediate
     * subdirectories, marker-probed a few levels deep) and never cached —
     * the same "always re-read, never stale" philosophy `ConfigManager`
     * already applies to project files.
     */
    discovery: {
      enabled: true,
      /** Folder names never treated as project candidates OR descended into while marker-probing. */
      ignore: ['node_modules', '.git', 'dist', 'build', '.next', '.venv', '__pycache__'],
      /** A candidate qualifies if it (or a subfolder within maxDepth) contains any of these. */
      markers: ['.git', 'package.json', 'requirements.txt', 'pyproject.toml', 'Cargo.toml', 'README.md'],
      /** How many folder levels deep a marker may be found before giving up on a candidate. */
      maxDepth: 2,
    },
    /**
     * Phase 13 M3: `/archive`, `/restore`, `/hide`, `/unhide`, `/forget`,
     * `/projects classify`. A new kill switch, per this codebase's
     * convention of one per new MUTATING capability class — discovery (M2)
     * only ever reads; this is the first surface that writes to the
     * registry remotely.
     */
    lifecycle: {
      enabled: true,
    },
    /**
     * Phase 13 M4: `/roots`, `/roots add`, `/roots remove` — the first use
     * of `src/config/liveConfig.js`'s allowlisted, no-restart config
     * mutation. Its own switch, separate from `lifecycle`'s: this changes
     * GLOBAL configuration, not one project's registry entry.
     */
    liveConfig: {
      enabled: true,
    },
    /**
     * Phase 13 M6: `/files`, `/file`, `/download-project` — the first
     * filesystem surface exposed remotely. Its own kill switch, separate
     * from `lifecycle`/`liveConfig`: this is a READ surface over real
     * project source, the highest-blast-radius new capability this phase
     * adds (see src/operator/fileAccess.js for the path-traversal guard
     * every one of these commands is built on).
     */
    files: {
      enabled: true,
    },
    /**
     * Phase 14 M9: `/mission`, `/mission all` — auto-detects a project's
     * language/framework/build-test commands from files already on disk and
     * writes a generated `promptFile` plus a `stack` metadata block. A
     * read-then-write surface (reads the project's real files, writes its
     * own config + a prompt file) — its own switch, separate from
     * `lifecycle`/`files`: this is the first capability that both inspects a
     * project's source AND mutates its registry entry in one step.
     */
    mission: {
      enabled: true,
    },
    /**
     * Phase 14 M0: `/workspace` — a read-only rollup across every registered
     * project (mission-readiness, status counts, git clean/dirty, recently
     * active, needs attention). Same risk class as `/status`/`/projects`
     * (no new data source, nothing here isn't already shown one row at a
     * time) — its own switch anyway, following this codebase's one-switch-
     * per-new-capability convention every other Phase 13/14 milestone uses.
     */
    workspace: {
      enabled: true,
    },
    /** Phase 13 M6: `/download-project` sizing and exclusions. */
    download: {
      /**
       * Checked against the size of what would ACTUALLY be zipped (after
       * `exclude`), before attempting to zip — so a large `node_modules`
       * never refuses a project whose real source is small. 200MB comfortably
       * covers a real source tree while still catching a genuinely oversized
       * project fast, before spending time streaming it.
       */
      maxProjectBytes: 200 * 1024 * 1024,
      /**
       * Never included in a download unless the owner overrides this list by
       * hand. Matches `operator.discovery.ignore` plus the folders this
       * milestone's own directive named explicitly (temporary folders,
       * cache, logs) that discovery had no reason to also exclude.
       */
      exclude: [
        'node_modules', '.git', 'dist', 'build', '.next', '.venv', '__pycache__',
        'logs', 'tmp', 'temp', '.cache', 'coverage',
      ],
      /** How long a generated .zip sits in state/operator/downloads/ before being pruned. */
      retentionMs: 86_400_000, // 24 hours
    },
  },

  /** Project launched when `ai-orchestrator start` is run with no name. */
  defaultProject: '',

  /** Optional path overrides (see src/infra/paths.js). */
  paths: {},
};

export const PROJECT_DEFAULTS = {
  enabled: true,
  driver: 'claude',

  /**
   * Phase 12 M2: one line describing what this project IS, shown by
   * `/projects` on the phone and by `projects status` in the CLI. Purely
   * descriptive — nothing reads it to make a decision. Empty is fine and
   * simply renders nothing; the registry never invents a description.
   */
  description: '',

  /**
   * Phase 13 M3: what this project IS (production/development/validation/
   * demo/archived/hidden), owner-set — distinct from the registry's
   * COMPUTED status (running/idle/blocked/…). See
   * src/config/projectClassification.js.
   */
  classification: 'development',

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

  /**
   * Phase P2: an ordered list of tasks turns a project from a single-prompt
   * mission into a multi-step plan (see src/mission/missionPlan.js). Empty
   * by default — a project with no tasks runs in legacy single-prompt mode
   * exactly as in v1/P0/P1 (uses promptFile + mission.completionMarker).
   *
   * Each task: { id, objective?, prompt, continuePrompt?, verify?, maxRuns? }
   * — see CONFIGURATION.md for the full per-task field reference. Tasks are
   * an array, so this default cannot be deep-merged per-field like other
   * settings; normalizeAndValidateTasks() applies per-task defaults instead.
   */
  tasks: [],

  /**
   * Per-project override of the global `progress` block (see
   * ORCHESTRATOR_DEFAULTS.progress and src/core/loopBreaker.js). Empty by
   * default — every key you omit falls back to the global setting. Useful
   * for a project whose agent legitimately goes several runs between
   * observable file changes (e.g. long research/reading phases): raise
   * `maxConsecutiveNoProgress` for that project alone rather than globally.
   */
  progress: {},

  /**
   * Phase 10B: per-project approval overrides — any key from the global
   * `approvals` block (most usefully `mode`). Empty by default: every key
   * you omit falls back to the global setting.
   */
  approvals: {},

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

  /**
   * NVIDIA NIM driver settings (see src/drivers/nvidiaDriver.js). A field
   * left empty falls back to the machine-wide `nvidia` block above — set
   * `model` here only to use a different model for this one project.
   */
  nvidia: {
    model: '',
  },
};

export default { ORCHESTRATOR_DEFAULTS, PROJECT_DEFAULTS };
