# Architecture

AI-Orchestrator is organised as small, single-purpose modules composed by one
launcher. Policy (what to do) is separated from knowledge (engine-specific
details) and from mechanism (process handling, persistence) throughout.

## Layer map

```text
┌──────────────────────────────────────────────────────────────────────┐
│  Entry points                                                        │
│  bin/ai-orchestrator.js → src/cli/index.js       START_AI.bat        │
│  src/index.js (library exports)                  scripts/*.ps1       │
├──────────────────────────────────────────────────────────────────────┤
│  Composition root                                                    │
│  src/app.js — builds and wires everything; the only place where      │
│  concrete classes are constructed. Signal handling, stop-file watch, │
│  double-launch guard, reboot recovery entry.                         │
├──────────────────────────────────────────────────────────────────────┤
│  Supervision core (policy)                 src/core/                 │
│  orchestrator.js          the launch→observe→classify→recover loop   │
│  exitClassifier.js        WHY did the process exit? (pure logic)     │
│  rateLimitEngine.js       usage-limit wait policy + interruptible    │
│                           waiting                                    │
│  crashRecoveryEngine.js   backoff + give-up policy                   │
│  processSupervisor.js     passive observation only (child PID scans, │
│                           last-output tracking) — never intervenes   │
│  loopBreaker.js           progress circuit breaker (loop prevention) │
│  blockedPatterns.js       detect permission-denied / blocked output  │
│  exitReason.js            standardized per-run outcome vocabulary    │
├──────────────────────────────────────────────────────────────────────┤
│  Progress awareness (P0)                   src/progress/, src/report/│
│  workspaceSignature.js    git/filescan signature — did work happen?  │
│  progressConfidence.js    how much to trust the progress verdict     │
│  progressLedger.js        per-run audit trail (state/ledger/*.jsonl) │
│  diagnosticReport.js      "why did we stop?" report on a block       │
│  missionTimeline.js       human-facing event stream (state/timeline) │
├──────────────────────────────────────────────────────────────────────┤
│  Drivers (engine knowledge)                src/drivers/              │
│  aiDriver.js              the interface every engine implements      │
│  claudeDriver.js          Claude Code: headless stream-json launch,  │
│                           --resume, limit-message patterns, reset-   │
│                           time parsing                               │
│  mockDriver.js            scriptable engine for tests & dry runs     │
│  driverRegistry.js        id → driver lookup; plugin-extensible      │
├──────────────────────────────────────────────────────────────────────┤
│  State (persistence)                       src/state/                │
│  statePersistence.js      atomic writes, corruption quarantine, jsonl│
│  sessionManager.js        session records: the resume memory         │
│  statusManager.js         status.json live snapshot (write-only)     │
│  heartbeat.js             liveness stamps; unclean-shutdown & double-│
│                           launch detection                           │
├──────────────────────────────────────────────────────────────────────┤
│  Integrations (subscribers)                                          │
│  src/notifications/       engine + channels (desktop/webhook/discord/│
│                           telegram/email-stub)                       │
│  src/plugins/             plugin loader (event & driver extension)   │
│  src/api/                 read-only dashboard HTTP API               │
├──────────────────────────────────────────────────────────────────────┤
│  Foundation                                                          │
│  src/config/              JSON config: defaults.js (every tunable) + │
│                           configManager.js (merge, validate)         │
│  src/infra/               logger (rotating), paths, time helpers     │
└──────────────────────────────────────────────────────────────────────┘
```

## The supervision loop

One `Orchestrator` instance supervises one project's **mission** — a
`session` that spans every launch, wait, and resume until completion:

1. **Launch** — the driver starts the engine and returns an `AgentRun`
   handle (events: `output`, `engine-session-id`, `activity`, `result`).
2. **Observe** — the ProcessSupervisor records last-output time and child
   PIDs into status.json. Nothing else happens while the process lives.
   There are no timeouts on healthy processes, by design.
3. **Classify** — when the process exits, `classifyExit()` decides between
   `completed`, `usage-limit`, `network`, `interrupted`, `spawn-failure`,
   and `crash`, using generic rules plus the driver's engine-specific
   output patterns. Usage-limit evidence beats a clean exit code.
4. **Assess progress** *(P0)* — for every exit, `assessProgress()` computes a
   workspace signature, decides whether the run advanced anything, records
   the run (with the agent's final response) to the progress ledger, and
   runs blocked-state detection on the output.
5. **Recover** — each cause maps to a strategy:

   | Cause | Strategy |
   | --- | --- |
   | completed + marker | archive session, emit `mission:complete`, stop |
   | completed, no marker | **loop breaker checks progress** → block, or inter-run delay → relaunch (same conversation) |
   | usage-limit | parse reset time (driver) → clamp (policy) → wait → resume |
   | network | short fixed delay → resume |
   | crash / external kill | exponential backoff; give up after N consecutive |
   | spawn-failure | give up immediately (engine missing) |

   *Giving up never deletes anything* — the session stays on disk in a
   resumable state and the next start continues the same conversation. The
   exception is **blocked** (a detected loop or blocked agent): that state is
   terminal and NOT auto-resumable — the session is archived with a
   diagnostic report so a restart cannot re-enter the futile loop.

6. **Repeat** until the completion marker appears, the loop breaker trips, or
   the operator stops it.

### Progress awareness (why the loop can't run away)

The v1.0 loop would relaunch after every clean-but-unfinished run forever.
v1.1 inserts a gate before each relaunch:

- `computeWorkspaceSignature()` reduces the working directory to a hash
  (git HEAD + status + dirty-file contents, else a file path/size/mtime
  scan). Same hash across runs ⇒ no progress. It **fails closed**: an
  unmeasurable workspace counts as no progress.
- `detectBlockedState()` scans the agent's final output for distress signals
  (permission denied, no access, cannot proceed, awaiting input).
- `LoopBreaker.decide()` trips when the workspace has not changed for
  `progress.maxConsecutiveNoProgress` runs, or immediately when a blocked
  state coincides with no progress. Tripping routes to `block()`, which
  writes a diagnostic report and archives the session as `blocked`.

## Crash-anywhere durability

Every state transition is written before the action it describes takes
effect, using atomic temp-file+rename writes:

- `state/sessions/<project>.json` — the active session (resume memory:
  engine conversation id, counters, wait deadlines).
- `state/heartbeat.json` — stamped every 15 s with pid + state. On startup:
  a "running" heartbeat with a live PID blocks double-launch; with a dead
  PID it proves an unclean shutdown and triggers automatic recovery.
- `status.json` — human/dashboard snapshot. Write-only: the orchestrator
  never reads it back for decisions.

Corrupt state files are quarantined (`*.corrupt-<ts>`), never trusted, and
never fatal.

## Events, not calls

The orchestrator emits domain events (`session:launched`,
`session:rate-limited`, `session:crashed`, `session:resumed`,
`session:gave-up`, `session:recovered`, `mission:complete`, …). The
notification engine, plugins, and any future dashboard subscribe to these.
Integrations can fail freely without touching supervision.

## Adding an engine (driver contract)

Implement `AIDriver` (see `src/drivers/aiDriver.js`):

- `checkInstallation()` → `{ok, version|error}`
- `launch({project, prompt, engineSessionId})` → `AgentRun`
- `exitPatterns` — regexes for usage-limit / network messages
- `extractLimitResetTime(outputTail)` → `Date|null`

Register it in `driverRegistry.js` (or from a plugin via
`driverRegistry.registerDriver(id, Class)`), reference it as `"driver": "<id>"`
in a project config — done. No supervision code changes.

## Design rules

1. **Dependency injection everywhere** — only `app.js` constructs concrete
   objects; every module receives collaborators, which keeps them
   unit-testable with fakes (see `test/orchestrator.test.js`).
2. **No magic numbers** — every tunable lives in `src/config/defaults.js`
   and is overridable from JSON config.
3. **Knowledge/policy split** — drivers know what engine messages look
   like; core engines decide what to do about them.
4. **Observability is never load-bearing** — status writes, notifications,
   the API, and child scans are all best-effort; their failures are logged
   and swallowed.
5. **The process is the truth** — supervision decisions key off actual
   process exit, never off output silence or heuristics about "stuck".
