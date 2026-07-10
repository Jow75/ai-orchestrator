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
│  Mission engine (P2/P3)                     src/mission/             │
│  missionPlan.js           validates/normalizes a project's `tasks`;  │
│                           legacy (no tasks) vs mission-mode lookup;  │
│                           validateSingleTask() shared with the CLI   │
│  taskQueue.js             persistent progress through the task plan │
│                           (state/tasks/*.json) — attempts, state,    │
│                           checkpoints; survives crash/limit/reboot;  │
│                           enqueue/removeTask/reorderTask (P3) mutate │
│                           the SAME queue at runtime, no JSON needed  │
│  taskState.js             per-task lifecycle states                 │
│  checkpoint.js            structured "what happened on this task"   │
│                           data (feeds the P4 Continuation Builder)   │
├──────────────────────────────────────────────────────────────────────┤
│  Briefing engine (P4)                       src/briefing/            │
│  continuationBuilder.js   turns live state (queue, checkpoints,      │
│                           ledger, memory) into a structured resume/   │
│                           retry prompt — names exactly which verifier│
│                           failed and why, instead of a bare "continue"│
├──────────────────────────────────────────────────────────────────────┤
│  Memory (P5)                                src/memory/              │
│  memoryStore.js           cross-session memory (state/memory/*.json):│
│                           operator notes, auto-recorded failure       │
│                           catalog, task history archived before a     │
│                           plan reinit would otherwise discard it      │
├──────────────────────────────────────────────────────────────────────┤
│  Verification engine (P2 core + P6 expansion) src/verify/            │
│  verifierRegistry.js      known verifier types; runs them, isolated  │
│  verifiers/*.js           file-exists, command, output-contains,     │
│                           files-changed (reuses progress engine facts│
│                           ), json-schema, lint, dependency (P6)      │
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
│  src/api/                 dashboard HTTP API: read-only status/      │
│                           tasks/memory/timeline + P7 mutating         │
│                           endpoints behind a local auth token         │
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
  launch (`attempts === 0`), which is what selects the fresh prompt file
  vs. `Orchestrator#buildContinuationPrompt()` (P4).
- **the last task** → mission complete, identical ending to a legacy
  marker hit (archive session, emit `mission:complete`).

Failing retries the same task, via `buildContinuationPrompt()`'s
task-scoped briefing (P4 — see below), until its own `maxRuns` is spent,
then routes to `block()` — the same diagnostic-report machinery P0 built
for loop prevention, now also guarding "an unverified task never gets
silently skipped." The P0/P1 stagnation breaker still runs in parallel as
an extra net: repeatedly failing verification with zero workspace change
is exactly the "spinning, not working" pattern it exists to catch,
regardless of which subsystem is doing the spinning.

**Persistence** (`TaskQueue`, `state/tasks/<project>.json`): current task
index, and each task's *complete definition plus runtime state*
(`toQueueEntry()` merges a normalized task with `{state, attempts,
checkpoint}`) — the queue entry, not a lookup against static config, is
what the orchestrator reads. `getOrInitialize()`'s adoption rule:

1. Same session, same plan shape → resume as-is.
2. Same session, static plan shape changed → the project config was edited
   mid-mission; reconciling an arbitrary diff is out of scope, so the queue
   reinitializes with a warning rather than guessing.
3. **Different (or no) session, but the current task is still PENDING or
   ACTIVE** (`currentIsResumable()`) → **adopt** it. This is deliberately a
   check of the current task's own *state*, not merely that an index is in
   bounds: a BLOCKED or FAILED current task is never adopted by a new
   session, however the check were phrased — silently re-attaching to a
   task that was blocked would defeat the entire reason blocking exists.
4. Otherwise → seed fresh from the static plan.

Rule 3 is what Phase P3 adds: it lets a queue built (or extended) via the
`tasks add` CLI — with no session attached yet, or attached to a session
that already completed — run on the next `start`, while rules 2 and 4
preserve every P2 safety property unchanged.

**Runtime queue mutation (Phase P3)**: `enqueue()`, `removeTask()`, and
`reorderTask()` let the `tasks add/remove/reorder` CLI commands adjust a
project's plan without touching its JSON file. `removeTask`/`reorderTask`
only ever act on a `PENDING` task — one that has never been launched —
refusing outright on anything active, done, failed, or blocked, so a
mutation can never corrupt in-flight supervision or discard real history.
Static `tasks` (JSON) and the runtime queue are the same underlying
structure: the JSON array only seeds the queue the first time a session
runs it; `tasks add` is how the plan grows after that.

**Checkpoints** (`src/mission/checkpoint.js`) capture *data only* — files
touched, verification results, a truncated summary — deliberately stopping
short of generating a Claude-facing prompt from that data. Phase P2 also
added `TaskQueue.recordVerifyResult()`, storing the current task's latest
verify outcome on *every* attempt (not just terminal ones); P4 is what
reads it.

## The Continuation Builder — structured resumes, not "Continue." (Phase P4)

Every resume, retry, or crash recovery from v1 through P3 sent the exact
same static string, regardless of cause. The agent had no way to know
*why* it was relaunched or, on a verification-failed retry, *which* check
it failed — it had to rediscover that from scratch, burning tokens on
orientation instead of progress. `src/briefing/continuationBuilder.js`
replaces the string with a briefing built from state the orchestrator
already has on hand:

- **`buildLegacyContinuation({ project, reason, recentRuns })`** — for
  single-prompt missions: project name, why this run was resumed, and a
  short "recent activity" digest from the progress ledger.
- **`buildTaskContinuation({ project, queue, task, reason, recentRuns })`**
  — for mission mode, scoped to the *current* task: its objective,
  completed tasks (explicitly "do NOT redo"), remaining tasks, the
  verifiers that must pass, and — the headline feature — when
  `task.lastVerifyResult.passed` is false, exactly which check failed and
  its detail message (e.g. `file-exists failed: Not found: out.txt`),
  filtered so a *passing* check in the same result is never listed as a
  failure reason.

`Orchestrator#buildContinuationPrompt({ project, task, reason })` is the
single call site both supervision modes route through. It is a pure
routing function, not policy: it reads `this.briefingConfig` (from
`config.briefing`) and either builds a briefing or falls back to the old
`task.continuePrompt ?? project.mission.continuePrompt` string when
`briefing.enabled` is false — a deliberate, complete opt-out, not a
partial one, so a hand-built config (or an operator who prefers the old
behavior) reverts byte-for-byte with one flag.

Both builder functions are pure: given already-loaded state, they return
a string and perform no I/O. The orchestrator supplies everything they
need — `this.taskQueueState` for the queue, `this.progressLedger.recent()`
for recent activity — keeping the module trivially unit-testable and
engine-agnostic (it has no idea which driver is running).

## Cross-session memory (Phase P5)

The ledger (P0/P1) and task queue (P2/P3) both remember *what happened,
run by run* — but neither survives past the data structure that produced
it. A `TaskQueue` reinitialization (static `tasks` edited mid-mission)
used to discard the outgoing queue's checkpoints entirely; and neither
has a place for a durable fact a human wants remembered ("the build
system is X") independent of any one mission's lifetime.
`src/memory/memoryStore.js` (`state/memory/<project>.json`) closes that
gap with three categories:

- **`notes`** — operator-authored, via the `memory add` CLI. Categorized
  `project` (general) or `architecture` (build/structure/conventions).
  Never auto-added or auto-removed — purely a human's own record.
- **`failures`** — auto-recorded every time `Orchestrator#block()` fires
  (a BLOCKED or FAILED terminal outcome), tagged with the failing task id
  when there is one. Outlives the session and the task queue that hit it;
  `memory resolve <project> <id>` marks one fixed once its cause is
  addressed, so only genuinely-open problems are ever surfaced.
- **`taskHistory`** — archived by `TaskQueue#getOrInitialize()` immediately
  before a plan-shape-changed reinitialization would otherwise discard the
  outgoing queue's DONE/FAILED/BLOCKED tasks (`MemoryStore#archiveTaskHistory()`,
  called with a `memoryStore` injected into `TaskQueue`'s constructor). A
  task with no static config it was actually attempted under, never
  archived; a still-ACTIVE task (never reached a terminal state) is
  likewise skipped — only real, finished history is worth keeping.

All three are read by the Continuation Builder and folded into every
resume/retry briefing (`Orchestrator#buildContinuationPrompt()` fetches
them from `this.memoryStore` and passes them straight through) — "Project
memory", "Known problems from past attempts", and, task-scoped, "attempted
before, under an earlier version of this plan". Like every other store in
this codebase, `MemoryStore` degrades to safe no-ops when `paths.memoryDir`
is unset (hand-built test configs that predate this phase), matching
`TaskQueue`'s `tasksDir` guard. `GET /api/memory/:project` exposes the
same data read-only, alongside `/api/tasks/:project`.

## The dashboard API's mutation surface (Phase P7)

Every endpoint through P5 was read-only — status, sessions, timeline,
tasks, memory — safe to leave unauthenticated on the local-only bind
(`api.host` default `127.0.0.1`). P7 adds a mutation surface for the
desktop app (Phase 8, `desktop/` — "the UI is purely an API client"),
which is a different risk: anyone who can reach the port can now change
state, not just observe it. `src/api/apiAuth.js` gates every mutating route with a
single local token (`state/api-token.txt`, generated once, `0600`-mode);
`requireAuth()` 401s on anything else, including an *unconfigured* token
— there is no "open by default" path.

The mutating routes fall into three shapes:

- **`POST /api/control/stop`** — the only one that acts on the live
  process in memory (`this.orchestrator.stop(reason)`), not a file. It's
  the same graceful stop the CLI's `stop` command already performed
  (`AgentRun.requestStop()`, never a kill) — the API is a second door to
  an existing mechanism, not a new one.
- **Mirrors of existing CLI mutations** — `/api/tasks/:project/add|remove|reorder`
  and `/api/memory/:project/notes` / `.../failures/:id/resolve` call the
  exact same `TaskQueue`/`MemoryStore` methods the CLI calls, with the
  same validation and guards. Both the CLI and the API read/write the
  same files on disk; neither is a special case of the other.
- **New operator overrides** — `TaskQueue#approveRetry()` and
  `#operatorSkip()`, the one piece of genuinely new domain logic in this
  phase. Both act ONLY on the *current* task and ONLY from a terminal
  (BLOCKED/FAILED) state (shared guard: `currentBlockedOrFailedTask()`):
  `approveRetry()` clears attempts/checkpoint/verify-result and resets the
  task to PENDING, so the next `start` retries it — relying on the
  existing P3 adoption rule (`currentIsResumable()`) to pick it back up
  under a fresh session rather than falling through to a static-plan
  restart. `operatorSkip()` instead marks the task DONE with an
  `operator-skipped` checkpoint and advances past it. Neither can ever
  touch a live/ACTIVE task: a task only reaches BLOCKED/FAILED after
  `block()` has already closed its session, by which point the
  orchestrator process that hit it has already exited — so these two
  overrides can never race a live agent or violate "never interfere while
  the process is alive."

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
