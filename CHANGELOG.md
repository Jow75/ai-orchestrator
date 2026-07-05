# Changelog

All notable changes to AI-Orchestrator are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/) · Versioning: [SemVer](https://semver.org/).

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
