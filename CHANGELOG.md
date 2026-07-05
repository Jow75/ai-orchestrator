# Changelog

All notable changes to AI-Orchestrator are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/) · Versioning: [SemVer](https://semver.org/).

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
