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
│  Progress engine (P0/P1)                   src/progress/, src/report/│
│  progressEngine.js        structured change facts: created/modified/ │
│                           deleted files, git-commit detection —      │
│                           did work happen, and what happened?        │
│  progressConfidence.js    how much to trust the progress verdict     │
│  progressLedger.js        per-run audit trail (state/ledger/*.jsonl) │
│  diagnosticReport.js      "why did we stop?" report on a block       │
│  missionTimeline.js       human-facing event stream (state/timeline) │
├──────────────────────────────────────────────────────────────────────┤
│  Mission engine (P2)                        src/mission/             │
│  missionPlan.js           validates/normalizes a project's `tasks`;  │
│                           legacy (no tasks) vs mission-mode lookup   │
│  taskQueue.js             persistent progress through the task plan │
│                           (state/tasks/*.json) — attempts, state,    │
│                           checkpoints; survives crash/limit/reboot   │
│  taskState.js             per-task lifecycle states                 │
│  checkpoint.js            structured "what happened on this task"   │
│                           data (seeds the P4 Continuation Builder)  │
├──────────────────────────────────────────────────────────────────────┤
│  Verification engine (P2 core / P6 target) src/verify/               │
│  verifierRegistry.js      known verifier types; runs them, isolated  │
│  verifiers/*.js           file-exists, command, output-contains,     │
│                           files-changed (reuses progress engine facts)│
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
   | completed + marker (legacy) | archive session, emit `mission:complete`, stop |
   | completed, no marker (legacy) | **loop breaker checks progress** → block, or inter-run delay → relaunch (same conversation) |
   | completed (mission mode) | **current task's verifiers decide** — see "Mission mode" below |
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
v1.1 inserted a gate before each relaunch; P1 (`ProgressEngine`, in
`src/progress/progressEngine.js`) replaced the original gate with a
structured one that also fixed a real correctness gap:

- **How it measures**: a bounded scan of the working directory (skipping
  `node_modules`, `.git`, build/state/log dirs) mapping each file to
  `size:mtime`, plus the git HEAD when the directory is a repo. The scan is
  persisted per project (`state/progress/<project>.snapshot.json`) and
  diffed against the previous run to produce **structured change facts** —
  which files were created, modified, or deleted, and whether a git commit
  was made — not just a yes/no hash comparison.
- **The P0→P1 fix**: P0's first signature implementation used `git status`,
  which is blind to anything matched by `.gitignore`. Work the agent did
  inside a git-ignored directory (a common case: build output, scratch
  files) registered as "no progress" and could still trip the breaker
  incorrectly. P1's full-tree scan sees those files; only genuine noise
  directories are skipped, never `.gitignore` rules.
- **Known trade-off, documented deliberately**: change detection uses
  `size:mtime`, not file content hashing. Content hashing every file on
  every run does defend against "same content, touched mtime" false
  positives, but at real cost when workspaces are large; P0 used it only
  for git-tracked dirty files, a bounded set. Since P1 scans the *whole*
  tree (to catch git-ignored work), content-hashing all of it would not
  scale. The chosen bias is deliberate: an occasional false "progress" from
  a touched-but-unchanged file is harmless (worst case, one extra relaunch
  before the breaker would otherwise trip); a false "no progress" is what
  causes the failure this system exists to prevent. If this trade-off ever
  matters for a specific project, a future `progress.hashContent: true`
  project-level option would be the natural extension point.
- It **fails closed** either way: an unmeasurable workspace (permissions
  error, deleted directory) counts as no progress, so an environment
  problem pauses for review instead of looping silently.
- `detectBlockedState()` scans the agent's final output for distress
  signals (permission denied, no access, cannot proceed, awaiting input,
  missing file); driver-supplied patterns are checked first, keeping
  detection engine-agnostic.
- `LoopBreaker.decide()` trips when the workspace has not changed for
  `progress.maxConsecutiveNoProgress` runs, or immediately when a blocked
  state coincides with no progress. Tripping routes to `block()`, which
  writes a diagnostic report and archives the session as `blocked`.
- `progressConfidence.assessConfidence()` scores every verdict
  (`git-commit` > `git` > `filescan` > `unmeasurable`, raised further by
  created/modified file counts); P6's verification signals will raise it
  through the same function rather than a parallel one.

## Mission mode: tasks instead of one prompt (Phase P2)

A project with a non-empty `tasks` array (`missionPlan.isLegacyMission()`
returns false) replaces "one prompt, marker-based completion" with an
ordered plan. This is additive, not a fork of the loop: the same
launch→observe→classify→assess-progress cycle runs unchanged; only what
happens on a `COMPLETED` exit differs.

**Per-task state machine** (`src/mission/taskState.js`):

```text
PENDING ──► ACTIVE ──► DONE
              │  ▲
              ▼  │ (verification failed, attempts < maxRuns)
           (retry)
              │
              ▼ (attempts exhausted, or the P0/P1 breaker trips)
       FAILED / BLOCKED
```

**Verification-first, always**: `handleTaskCompletion()` never trusts the
agent's word. A task with `verify` entries runs them through
`verifierRegistry.runVerifiers()`; a task with none falls back to the
mission completion marker as a lightweight per-task signal (documented,
not accidental — see `markerFallbackVerify()`). Passing:

- **not the last task** → advance to the next task, same engine
  conversation, but that task's *own* prompt (not a bare "continue") —
  `TaskQueue.recordAttempt()` marks whether this is the task's first
  launch (`attempts === 0`), which is what selects prompt vs. continuePrompt.
- **the last task** → mission complete, identical ending to a legacy
  marker hit (archive session, emit `mission:complete`).

Failing retries the same task (`continuePrompt`) until its own `maxRuns`
is spent, then routes to `block()` — the same diagnostic-report machinery
P0 built for loop prevention, now also guarding "an unverified task never
gets silently skipped." The P0/P1 stagnation breaker still runs in
parallel as an extra net: repeatedly failing verification with zero
workspace change is exactly the "spinning, not working" pattern it exists
to catch, regardless of which subsystem is doing the spinning.

**Persistence** (`TaskQueue`, `state/tasks/<project>.json`): current task
index, each task's state/attempts/checkpoint. Scoped to the session id —
resuming after a crash, rate limit, or reboot reuses the persisted queue
(same task, same attempt count); a genuinely new session (not a resume)
starts the plan over. A project edited mid-mission (different task ids)
reinitializes the queue rather than trying to reconcile an arbitrary diff
— documented as a known limitation, not silently guessed at.

**Checkpoints** (`src/mission/checkpoint.js`) capture *data only* — files
touched, verification results, a truncated summary — deliberately stopping
short of generating a Claude-facing prompt from that data. Turning
checkpoints into a structured briefing is Phase P4, the Continuation
Builder; P2's job is making sure the history exists to build from.

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
`session:gave-up`, `session:recovered`, `mission:complete`, `task:done`, …).
The notification engine, plugins, and any future dashboard subscribe to
these. Integrations can fail freely without touching supervision.

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
6. **Verification over trust** — a task (or, in legacy mode, the mission)
   is complete when an independent check says so, never merely because
   the agent claims it. This is why `handleTaskCompletion()` always runs
   `verifierRegistry.runVerifiers()` (or the marker fallback) before
   advancing, and why "attempts exhausted" blocks rather than moves on.
