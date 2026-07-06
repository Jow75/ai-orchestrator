# Changelog

All notable changes to AI-Orchestrator are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/) · Versioning: [SemVer](https://semver.org/).

## [2.0.0-rc.1] — 2026-07-06 — Phase P6: Verification Engine Expansion

Extends the same `verifierRegistry.js` P2 shipped — not a rewrite — with
three new verifier types. Every existing verifier, the registry contract,
and every caller (mission engine, Continuation Builder) are unchanged.

### Added

- **`json-schema` verifier**: validates a JSON file against a schema
  (inline `schema` or an external `schemaFile`). A small, dependency-free
  validator — no ajv/etc. — supporting `type`, `required`, `properties`,
  `items`, `enum`, `minimum`/`maximum`, `minLength`/`maxLength`, `pattern`.
  Explicitly NOT a full JSON Schema draft implementation (no `$ref`,
  `oneOf`/`anyOf`/`allOf`, `additionalProperties`, format validators) —
  documented as a bounded subset rather than silently unsupported.
  Failure detail names the exact field and reason, e.g. `at "$.port":
  expected integer, got string`.
- **`lint` verifier**: same execution model as `command`, but when the
  command's output parses as ESLint's `-f json` shape, the failure detail
  becomes a specific, ranked problem list (`src/a.js:12 [no-unused-vars]
  'x' is never used`) instead of a wall of raw stdout. Any other linter's
  output (or ESLint without `-f json`) falls back to the same
  exit-code-and-truncated-output detail `command` already produces.
- **`dependency` verifier**: checks a project's `package.json` declares a
  named package (`dependencies`/`devDependencies`/`peerDependencies`, or
  a narrower `where`) and, unless `installed: false`, that it's actually
  present in `node_modules` — catching the common half-finished case of
  editing `package.json` without ever running `npm install`.
- **Continuation Builder**: `describeVerifier()` gained readable
  descriptions for all three new types, so a task gated by them renders
  properly in the "checks pass" section of a retry briefing instead of
  falling through to the generic `(see project config)` fallback.
- 15 new verifier unit tests (all three types: pass, specific failure
  detail, and edge cases like missing files/invalid JSON/non-JSON lint
  output) plus a real orchestrator integration test proving a
  `dependency` verifier gates actual task completion and retry through
  the full supervision loop. 251 tests total. Verified live via a direct
  script exercising all three verifiers against real files.

### Known limitations (documented, not hidden)

- `json-schema` is intentionally a subset (see above) — a project needing
  full draft compliance should verify via a `command` verifier invoking
  a real JSON Schema CLI instead.
- `lint`'s rich failure detail only activates for ESLint's exact `-f json`
  array shape; every other linter gets the same generic detail `command`
  always provided (still functional, just less specific).
- `dependency` only understands npm's `package.json`/`node_modules`
  layout — no support for other package managers' lockfile-only
  installs (e.g. pnpm's content-addressed store) where a package can be
  installed without a matching `node_modules/<name>` directory existing.
- The verifier registry remains deliberately NOT plugin-extensible (a P2
  decision, reaffirmed here) — a closed, known set validated at
  config-load time. Revisit only if a real, concrete need emerges.
- Verification outcomes are NOT wired into `assessConfidence()`'s
  existing `'verified'` signal extension point, despite earlier ROADMAP
  language suggesting P6 would do so — verification already
  authoritatively decides mission-mode task completion, so a
  confidence-score bump for the same decision is redundant, and the
  ledger record for a run is written before that run's verification even
  executes. ROADMAP.md corrected to reflect this rather than leave a
  stale promise standing.

## [2.0.0-beta.2] — 2026-07-06 — Phase P4: Continuation Builder + Phase P5: Memory

Replaces the single static `continuePrompt` string — sent unchanged on
every resume, retry, or crash recovery since v1 — with a structured
briefing generated from live orchestrator state on every relaunch.

### Added

- **`src/briefing/continuationBuilder.js`**: `buildLegacyContinuation()`
  (single-prompt missions) and `buildTaskContinuation()` (mission mode,
  scoped to the current task). Both turn orchestrator state the agent
  would otherwise have to rediscover — completed tasks (so they're never
  redone), remaining tasks, and recent ledger activity — into one prompt.
  The headline feature: on a retry after a failed verification,
  `buildTaskContinuation()` names **exactly which check failed and why**
  (`file-exists failed: Not found: out.txt`), not a generic "try again".
- **`TaskQueue#recordVerifyResult()`**: stores the current task's latest
  verification outcome on every attempt (pass, retry, or exhausted),
  independent of `checkpoint` (which is only set on a terminal outcome).
  This is what the builder reads to explain a failed retry.
- **`Orchestrator#buildContinuationPrompt()`**: the single call site both
  supervision modes now route through for a resume/retry prompt. Reads
  `config.briefing` (`enabled`, `recentRunCount`); `enabled: false` (the
  default in hand-built configs that omit the block) reverts to the old
  static-string behaviour byte-for-byte — a deliberate escape hatch, not
  a migration requirement.
- **`ORCHESTRATOR_DEFAULTS.briefing`**: `{ enabled: true, recentRunCount: 3 }`
  — on by default for real deployments.
- **`MockDriver#receivedPrompts`**: every prompt a test launch was called
  with, in order — lets orchestrator-level tests assert on real prompt
  content instead of parsing logs.
- 15 new tests: 11 unit tests for both builder functions (including the
  "does NOT list a passing check as a failure" negative case), and 4
  orchestrator integration tests proving the real supervision loop feeds
  a failed task's specific verifier failure into the very next launch's
  prompt — verified live via a direct call into the builder as well.

### Known limitations (documented, not hidden — P4)

- `recentRunCount` is a flat cap, not adaptive to prompt-size budgets —
  a task with very long `resultText` entries could still produce a long
  briefing (each entry is capped at 300 chars, but there is no overall
  briefing-length ceiling).

Phase P5 immediately follows, closing the one gap P4 explicitly deferred:
the briefing above only drew on *this session's* ledger activity, with
nothing surviving past the data structure that produced it.

### Added (Phase P5 — Memory)

- **`src/memory/memoryStore.js`**: cross-session project memory, persisted
  at `state/memory/<project>.json`, in three categories:
  - `notes` — operator-authored durable facts (`memory add` CLI),
    categorized `project` or `architecture`. Never auto-added or removed.
  - `failures` — auto-recorded every time `Orchestrator#block()` fires (a
    BLOCKED or FAILED terminal outcome), independent of session or
    task-queue lifetime. An operator marks one resolved (`memory resolve`)
    once its cause is fixed; only unresolved failures are surfaced.
  - `taskHistory` — archived from a task queue's DONE/FAILED/BLOCKED tasks
    right before `TaskQueue` reinitializes and would otherwise discard
    them (a static-config edit mid-mission). A later plan reusing the
    same task id can now see what happened last time.
- **`TaskQueue` gains an optional `memoryStore` dependency**: calls
  `archiveTaskHistory()` immediately before a plan-shape-changed
  reinitialization discards the outgoing queue's tasks — this was a real,
  silent data-loss gap in P3's reinit path, closed here rather than
  carried forward.
- **The Continuation Builder (P4) now folds in memory**: both
  `buildLegacyContinuation()` and `buildTaskContinuation()` accept
  `memoryNotes`/`activeFailures`, rendered as "Project memory" and "Known
  problems from past attempts" sections; `buildTaskContinuation()` also
  accepts `priorAttempts` (this task id's archived history), rendered as
  "attempted before, under an earlier version of this plan".
  `Orchestrator#buildContinuationPrompt()` fetches all three from
  `this.memoryStore` before delegating — no other call site changed.
- **CLI**: `memory list <project>` (shows notes/failures/task history),
  `memory add <project> --note "..." [--category project|architecture]`,
  `memory resolve <project> <failureId>`.
- **API**: `GET /api/memory/:project` — read-only, mirrors `/api/tasks/:project`.
- **`paths.memoryDir`** (`state/memory/`) added to path resolution and
  runtime directory creation, alongside every other state subdirectory.
- 23 new tests: `MemoryStore` unit tests (persistence, note/failure/
  task-history lifecycle, graceful no-op when `memoryDir` is unset),
  `continuationBuilder` tests for the three new sections, a `TaskQueue`
  test proving archiving fires exactly on plan-shape reinitialization
  (and only for terminal tasks — an ACTIVE task has nothing to archive),
  and 5 orchestrator integration tests proving a real `block()` records a
  failure and a real continuation prompt carries operator notes and the
  unresolved-failure catalog. Verified live via the `memory add`/`memory
  list` CLI commands.

### Known limitations (documented, not hidden — P5)

- Memory is per-project only; there is no cross-project memory (e.g. "a
  pattern that recurs across every project using this driver"). Revisit
  if a real multi-project pattern emerges.
- `taskHistory` accumulates without pruning — a project reinitialized
  many times over its life grows an ever-longer archive. Harmless at
  realistic scale (JSON file, read in full only per-project), but not
  bounded the way `recentNotes`/`activeFailures` are at read time.
- Failures are never auto-resolved — even a task that later succeeds
  leaves its earlier failure entry `resolved: false` until an operator
  runs `memory resolve`. This is deliberate (an operator should confirm
  the *cause* was actually fixed, not infer it from one later success),
  but means the catalog can go stale if operators don't maintain it.

## [2.0.0-beta.1] — 2026-07-06 — Phase P3: Persistent Prompt Queue

Makes P2's task plan runtime-mutable: `tasks add/remove/reorder` build up
or adjust a project's mission without editing JSON, reusing the exact same
`TaskQueue` rather than introducing a parallel structure.

### Added

- **`TaskQueue` mutation methods**: `enqueue()` (append a task, carrying
  its full normalized definition), `removeTask()` and `reorderTask()`
  (both refuse anything that isn't `PENDING` — never touch an active,
  done, failed, or blocked task), `ensure()` (load-or-create an empty,
  session-less queue for bootstrapping).
- **`missionPlan.validateSingleTask()`**: extracted from
  `normalizeAndValidateTasks()` so the CLI's `tasks add` validates a new
  task through the exact same path as the static config array — one
  validation path, not two that could quietly disagree.
- **CLI**: `tasks` is now a command group — `list` (the P2 display, moved
  here), `add --id --prompt [--objective] [--max-runs] [--verify-file]`,
  `remove <taskId>`, `reorder <taskId> up|down`.
- **Queue entries now carry their full task definition** (objective,
  resolvedPromptFile, continuePrompt, verify, maxRuns), not just runtime
  state — the orchestrator reads a task's definition straight off its
  queue entry instead of looking it up in static config by id. This is
  what lets a CLI-enqueued task (never declared in `project.tasks` at all)
  run with zero special-casing anywhere in the orchestrator.
- **`getOrInitialize()` adoption generalized**: previously only a queue
  belonging to the *same* session was reused; now any queue whose current
  task is still `PENDING`/`ACTIVE` is adopted regardless of session
  lineage. This is what makes queued-but-never-run tasks, and tasks
  appended after a prior mission already completed, actually run on the
  next `start`.
- 21 new tests: `TaskQueue` mutations, `validateSingleTask()`, and a
  5-scenario orchestrator integration suite proving a project with **no
  static `tasks` at all** can be driven end-to-end by the CLI queue
  (including reordered execution order and removed tasks never running).
  Verified live via the real CLI: queue two tasks, reorder, `start`, and
  confirm the reordered task ran first.

### Fixed (caught while implementing the adoption-rule generalization)

- The first draft of the generalized adoption rule checked only
  `currentIndex < tasks.length` ("is there a task left") — which does NOT
  distinguish a genuinely idle task from one sitting `BLOCKED` or `FAILED`
  at the current position (`block()`/`markFailed()` never advance the
  index). That draft would have let a brand-new session silently
  re-attach to a **blocked** mission's stuck task — exactly the loop P0
  exists to prevent. Caught by an existing P2 test whose expectations
  the naive rule violated; fixed by checking the current task's own state
  (`currentIsResumable()`) instead of the index alone, and added a
  dedicated regression test (`getOrInitialize() NEVER re-adopts a BLOCKED
  task under a new session`) so this cannot silently regress again.
- Two old orchestrator test harnesses (`orchestrator.test.js`,
  `orchestrator.p0.test.js`) predated `paths.tasksDir` and crashed once
  mission-mode detection started checking for an existing queue
  unconditionally; `TaskQueue.load()` now also guards against a missing
  `tasksDir` directly (returns `null`, matching "no queue" semantics)
  rather than relying solely on callers to supply a complete `paths` object.

### Known limitations (documented, not hidden)

- `tasks add` requires the target project to already pass full config
  validation (`workingDirectory`, `driver`, and either `promptFile` or
  existing `tasks`) — it layers mission content onto an already-valid
  project rather than bootstrapping one from nothing.
- Cross-session task memory (e.g. "T1 was already done in a previous,
  now-abandoned attempt") is not tracked — Phase P5.

## [2.0.0-alpha.3] — 2026-07-06 — Phase P2: Mission System

Converts the orchestrator from a single-prompt supervisor into a true
mission engine: a project may now define an ordered plan of **tasks**,
each independently verified — "Claude does not determine success;
verification determines success" — while every existing single-prompt
project keeps running exactly as before.

### Added

- **Mission plan** (`src/mission/missionPlan.js`): validates and normalizes
  a project's `tasks` array at config-load time (fail fast, actionable
  errors); `isLegacyMission()` is the single switch between v1 behaviour
  and mission mode.
- **Task queue** (`src/mission/taskQueue.js`): persistent progress through
  the plan — current task, attempts, state, checkpoint — at
  `state/tasks/<project>.json`. Scoped to the session id, so a crash,
  usage limit, or reboot resumes the *same task*, not the mission from
  task 1 (verified with a dedicated reboot-survival integration test).
- **Task lifecycle** (`src/mission/taskState.js`): PENDING → ACTIVE → DONE,
  with FAILED/BLOCKED terminal states on exhausted retries or a detected loop.
- **Verification engine (core)** (`src/verify/`): `file-exists`, `command`,
  `output-contains`, `files-changed` verifiers plus a registry that runs
  them in isolation (one failing/throwing verifier fails only itself).
  `files-changed` deliberately reuses the P1 progress engine's change facts
  rather than re-invoking git — one source of truth for "what changed".
  This is P6's foundation, not a placeholder to be replaced.
- **Checkpoints** (`src/mission/checkpoint.js`): structured, data-only
  record of a task's outcome (files touched, verify results, summary) —
  scoped deliberately to data; turning it into a Claude-facing briefing is
  Phase P4, not pulled forward here.
- **Orchestrator integration**: `handleTaskCompletion()` runs a task's
  verifiers (or the marker fallback) instead of the legacy marker-only
  check; passing advances to the next task's own prompt (same engine
  conversation); failing retries with `continuePrompt` up to the task's
  `maxRuns`, then **blocks** with a diagnostic report — exhausted
  verification is never silently skipped, mirroring P0's stagnation
  breaker (which still runs in parallel as an extra net).
- **Observability**: `status.mission` (current task, position, state,
  attempts) surfaced in `status.json`/`/api/status`; new `ai-orchestrator
  tasks <project>` CLI command and `GET /api/tasks/:project`; `task:done`
  event recorded on the mission timeline and available to plugins.
- 66 new tests (missionPlan, taskQueue, checkpoint, verifiers, StatusManager
  — previously untested directly — and a 9-scenario orchestrator
  integration suite covering multi-task completion, retry, exhaustion,
  usage-limit/crash-mid-task resume, and reboot survival). 109 → 175 total,
  all passing.

### Fixed

- **Mock driver fidelity bug, caught by writing these tests**: scripted
  `writeFile`/`appendFile` effects silently failed (swallowed by a bare
  `catch`) when the target's parent directory didn't exist yet (e.g.
  `src/index.js` when `src/` isn't created), unlike real agents which
  create parent directories automatically. Now mirrors that behaviour.

### Changed

- `configManager.validateProject()`: `promptFile` is required only in
  legacy mode; a mission-mode project (non-empty `tasks`) validates each
  task's own prompt instead, and surfaces every task problem (missing id,
  duplicate id, missing prompt file, unknown verifier type) in one error.
- `PROJECT_DEFAULTS` gained `tasks: []` and `progress: {}` documented as
  first-class, empty-by-default fields.

### Known limitations (documented, not hidden)

- Editing a project's `tasks` mid-mission (same session, different task
  ids) reinitializes the queue rather than reconciling the diff — logged
  clearly, not silently guessed at.
- A brand-new session after a `blocked` mission always restarts task 1;
  cross-session task memory arrives with Phase P5.
- The verifier registry is a fixed, known set (not plugin-extensible) by
  deliberate choice this phase — revisit if a real need emerges.

## [2.0.0-alpha.2] — 2026-07-06 — Phase P1: Progress Engine

Promotes P0's yes/no workspace signature into a first-class, structured
progress engine, and fixes a real correctness gap discovered while building
it.

### Added

- **`src/progress/progressEngine.js`**: replaces P0's git-status-based
  signature with a bounded full-tree scan (`size:mtime` per file, skipping
  only noise directories) plus git HEAD tracking. Snapshots persist at
  `state/progress/<project>.snapshot.json` and diff against the previous
  run to produce **structured change facts**: `created`/`modified`/`deleted`
  file lists and counts, and whether a git commit was made.
- **Per-project `progress` config override**: a project's own
  `config/projects/<name>.json` may set a `progress` block (e.g. a higher
  `maxConsecutiveNoProgress` for a project with long research phases);
  omitted keys fall back to the global setting. `PROJECT_DEFAULTS.progress`
  documents this as an empty object.
- Ledger records now include `changes` (counts) and `changedFiles` (sampled
  lists, capped at 25 entries each) alongside the existing progress fields.

### Fixed

- **The P0→P1 gap**: P0's signature relied on `git status`, which is blind
  to anything matched by `.gitignore`. Agent work inside a git-ignored
  directory (a common case — build output, scratch files) registered as "no
  progress" and could trip the circuit breaker incorrectly. P1's full-tree
  scan sees those files; verified end-to-end (`test/progressEngine.test.js`,
  *"THE P0 GAP FIX"*) and via a live CLI run against a real git repo with a
  `.gitignore`d directory.
- **A confidence-scoring bug caught during this phase's own smoke testing**:
  `progressConfidence.js` matched method names (`'git'`/`'filescan'`)
  belonging to the module P1 just replaced. `progressEngine.js` reports
  `'git+scan'`/`'scan'`, which matched neither branch, so every P1 progress
  verdict silently scored as the lowest tier regardless of actual evidence
  — confidence would have read "low" even for a clean git commit. Fixed by
  matching method *tiers* (substring match) instead of exact P0-era strings;
  regression-tested (`test/progressConfidence.test.js`).
- Removed `src/progress/workspaceSignature.js` (fully superseded — kept it
  would have meant two overlapping, subtly different implementations of the
  same concept; see ARCHITECTURE.md for the `size:mtime` vs. content-hash
  trade-off this makes explicit).

### Known limitations (documented, not hidden)

- Change detection uses file `size:mtime`, not content hashing — chosen
  deliberately since P1 scans the *whole* tree (necessary to catch
  git-ignored work) and hashing every file's content on every run would not
  scale. A file touched without content changes could register a false
  "modified" — harmless in this system's fail-safe direction (see
  ARCHITECTURE.md's "Progress awareness" section for the full reasoning).
- `progress` config remains per-project or global only; there is no
  per-task granularity yet (arrives with the P2 mission system).

## [2.0.0-alpha.1] — 2026-07-05 — Phase P0 complete & locked

Finalizes Phase P0 of the v2 "Autonomous AI Project Manager" line and marks
it as the locked foundation (see [ROADMAP.md](ROADMAP.md) for the phase plan
and version-snapshot scheme). Builds on the 1.1.0 loop-prevention core with
the classification and observability primitives every later phase consumes.

### Added

- **Standardized exit reasons** (`src/core/exitReason.js`): every run is
  classified into a fixed, engine-agnostic vocabulary — `progress`,
  `completed`, `no_progress`, `blocked_permission`, `blocked_tool`,
  `blocked_missing_file`, `blocked_other`, `rate_limit`, `network`, `crash`,
  `spawn_failure`, `user_stop`, plus `timeout`/`verification_failed`/
  `orchestrator_stop` reserved for later phases. Recorded on the ledger,
  the session's `lastExit`, and the `session:exit`/`session:progress` events.
- **Progress confidence** (`src/progress/progressConfidence.js`): each
  progress verdict carries a `high`/`medium`/`low` level, a 0–1 score, and
  the corroborating signals (git-commit > git > filescan > unmeasurable).
  Verification signals from P6 will raise it through the same function.
- **Mission timeline** (`src/state/missionTimeline.js`): a sparse,
  human-readable event stream per project (`state/timeline/<project>.jsonl`)
  — mission started, progress, rate-limit, resumed, blocked, complete. New
  `ai-orchestrator timeline <project>` command and `GET /api/timeline/:project`.
- **Driver-extensible blocked detection**: `detectBlockedState()` now accepts
  engine-specific patterns via an optional `driver.blockedPatterns`, keeping
  detection AI-agnostic. Added a `missing-file` blocked category.
- New library exports for all of the above.

### Changed

- Version line moved to the `v2.0.0-alpha.*` snapshot scheme; each completed
  phase is now tagged for clean rollback points.
- `assessProgress()` now also computes exit reason + confidence and records
  them; `session.lastExit` carries `exitReason`, `progressed`, `confidence`.

## [1.1.0] — 2026-07-05 — Progress awareness (Phase P0)

Emergency reliability fixes after the 2026-07-04/05 overnight incident, in
which a write-denied agent completed 343 no-progress runs and consumed two
full Claude usage windows. The orchestrator now supervises **progress**, not
just the process.

### Added

- **Progress circuit breaker** (`src/core/loopBreaker.js`): after
  `progress.maxConsecutiveNoProgress` (default 3) completed runs that change
  nothing in the workspace, supervision stops instead of looping.
- **Workspace progress signatures** (`src/progress/workspaceSignature.js`):
  git-aware (HEAD + porcelain + dirty-file contents) with a filesystem-scan
  fallback. **Fails closed** — an unmeasurable workspace counts as no
  progress, so an environment problem pauses for review instead of looping.
- **Blocked-state detection** (`src/core/blockedPatterns.js`): recognises
  agent distress signals — permission-denied, no-access, cannot-proceed,
  awaiting-input — and stops immediately when combined with no progress.
  This alone would have caught the incident on run #1.
- **New `blocked` session state**: terminal and *not* auto-resumable, so a
  restart cannot re-enter the same futile loop. The session is archived to
  history with a diagnostic report.
- **Diagnostic reports** (`src/report/diagnosticReport.js`): on any stop,
  `state/diagnostics/<project>-<ts>.md` explains the reason, likely cause,
  recommended fix, and recent run history.
- **Progress ledger** (`src/progress/progressLedger.js`): one record per run
  in `state/ledger/<project>.jsonl` — cause, progress, signature, and the
  agent's final response (the per-run audit trail the incident lacked).
- **Inter-run delay** (`progress.interRunDelayMs`, default 15 s): paces
  continue-relaunches and caps conversation-growth burn.
- **`mission:blocked` event** and notification, plus a `blocked` status state.
- Mock driver can now simulate real workspace changes (`writeFile` /
  `appendFile` in a run script) to exercise the progress engine in tests.
- 25 new tests (blocked patterns, loop breaker, signatures, ledger, and P0
  orchestrator integration including an incident-reproduction test).

### Fixed

- **Temp-file leak**: `writeJsonAtomic` now removes its temp file when the
  atomic rename fails (the EPERM path seen twice during the incident).
- **`plugins.enabled`** is now honored (plugins previously always loaded).
- Orphaned `.status.json.*.tmp` files removed and ignored going forward.

## [1.0.0] — 2026-07-04

Complete rebuild of the original generated skeleton around the actual
mission: supervising real AI coding-agent processes. (The pre-rebuild
snapshot is preserved in git history.)

### Added

- **Supervision core** — launch → passively observe → classify exit →
  recover loop (`src/core/orchestrator.js`); the orchestrator never touches
  a live agent process.
- **Exit classifier** distinguishing mission-complete, usage-limit,
  network, interrupted, spawn-failure, and crash — each with its own
  recovery strategy.
- **Usage-limit engine**: parses reset times from engine output (epoch and
  clock-time forms), clamps waits, sleeps interruptibly, resumes the same
  engine conversation automatically.
- **Crash recovery engine**: exponential backoff, consecutive-crash
  give-up that always preserves the session for later resume.
- **Claude Code driver**: headless `-p --output-format stream-json`
  launches, prompt via stdin, engine session-id capture for `--resume`,
  activity extraction for status, limit/network message patterns.
- **Mock driver** for testing the full pipeline without an AI engine.
- **State layer**: atomic JSON persistence with corruption quarantine,
  per-project session records + history, live `status.json`, heartbeat
  with double-launch guard and unclean-shutdown detection.
- **Reboot recovery**: Task Scheduler auto-resume task
  (`scheduler install`), heartbeat-based recovery on next start.
- **Notifications**: desktop (default-on), webhook, Discord, Telegram;
  email stubbed for a future release.
- **Plugin system**: `plugins/` modules with event subscription and driver
  registration; failures isolated.
- **Dashboard API**: read-only local HTTP endpoints (status, sessions,
  history, projects, health).
- **CLI**: `start`, `resume`, `stop`, `status`, `sessions`, `projects`,
  `drivers`, `scheduler`, `doctor`; plus `START_AI.bat`.
- **Tests**: 53 unit/integration tests (node:test), covering classification,
  wait policy, backoff, persistence, sessions, config validation, and the
  full supervision loop including limit-resume and give-up-then-resume.
- MIT LICENSE; full documentation set rewritten to match the implementation.

### Changed

- Configuration migrated from YAML to JSON (`config/orchestrator.json`,
  `config/projects/*.json`) per the project specification.
- Dependencies reduced from 24 to 8 runtime packages; tests moved from Jest
  to Node's built-in runner.

### Removed

- The generic multi-agent task-queue framework (agent pools, task queue,
  worker/researcher/coder agents) — replaced by the process-supervision
  architecture the mission actually requires.
