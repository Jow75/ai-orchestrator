# Changelog

All notable changes to AI-Orchestrator are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/) · Versioning: [SemVer](https://semver.org/).

## [2.5.0] — 2026-07-26 — Phase 11 M2: Phone & notification experience

The second Phase 11 milestone, driven directly by a live operator
walkthrough of v2.4.0. Every item below traces to a confirmed defect, not
a guess: duplicate Telegram approval messages (two distinct causes),
`README.md` rendering as a dead link, and a plain-text mission-complete
message with no structure.

### Fixed

- **Duplicate approval notification, cause 1 — resume/crash re-publishing.**
  A stop/resume or crash recovery that re-entered a task/gate whose
  decision never arrived called `requestApproval()` again, which always
  minted a NEW request id and re-published it. A new
  `ApprovalStore.findPending()`, reused by `ApprovalManager.requestApproval()`,
  now returns the existing pending request as-is — no new id, no
  re-publish, no re-announcement.
  Verified with an integration test using TWO independent Orchestrator/
  ApprovalManager instances sharing only on-disk state (a real process
  restart), not the same in-memory instance.
- **Duplicate approval notification, cause 2 — provider + channel both
  firing.** Confirmed on the live config: with both
  `notifications.telegram.enabled` and `approvals.providers.telegram.enabled`
  true (a common setup — `approval:required` is a default subscribed
  event), every approval sent TWO near-identical Telegram messages, from
  two different code paths. The notification engine now auto-excludes
  `approval:required`/`human-action:required`/`approval:resolved` on a
  channel whose matching approval provider is already delivering them
  (operators can still name extra exclusions via a new per-channel
  `excludeEvents` config).
- **`README.md`/`DiagnosticReport.md` rendering as dead links on the
  phone.** Telegram sent every message with no `parse_mode`, so its
  auto-linkification ran unrestricted (`.md` happens to also be a ccTLD).
  Every Telegram send now uses `parse_mode: 'HTML'` with a new
  `formatTelegramText()` that escapes the text and wraps filename-like
  tokens in `<code>` — real URLs (including ones ending in a report
  extension) are left as single, unbroken, clickable links.

### Added

- **Formal notification idempotency** (`state/notifications/<project>.json`):
  once a notification with a stable identity (an approval/human-action
  request) is sent, it is never resent unless the previous delivery
  failed, an explicit reminder interval elapses (`notifications.reminderMs`,
  default off), or the operator runs the new `notify resend <project> <id>`.
- **Real Telegram document attachments.** `TelegramChannel.sendDocument()`
  (multipart upload via Node's global `FormData`/`Blob` — no new
  dependency) attaches a real file directly. `mission:blocked`'s diagnostic
  report and `release:created`'s release notes are now attached as real
  files (in addition to the safely-formatted text mention) whenever the
  channel supports it.
- **Executive Mission Cards.** Mission-complete and mission-blocked
  notifications now carry a structured card — duration, tasks done, files
  changed, tests passed, an honest confidence label (verified/partial/
  unverified — never dressed up), the real git commit the mission ended
  on, and (when blocked) the operator's exact next command — assembled
  from data the orchestrator already had, nothing new tracked.
- `notify resend <project> <id>` — force-resends one pending approval,
  bypassing the idempotency dedup, reusing the original message rendering.

### Tests

- +80 tests across 7 new/updated files (approval reuse, notification
  idempotency, provider/channel dedup, Telegram formatting, the Telegram
  channel's send/sendDocument — both previously untested at the unit
  level — and Mission Cards, including two real orchestrator integration
  tests). Backend suite **550/550** + 18 desktop.
- Live-verified against the REAL Telegram Bot API (not just mocked fetch):
  a text message and a document attachment both delivered successfully,
  and a realistic Mission Card rendered correctly with the actual git HEAD
  of this repo.

## [2.4.0] — 2026-07-14 — Phase 11 M1: Onboarding & first-run wizards

The first milestone of Phase 11 (operator experience). A brand-new user now
reaches a working project — and a phone that receives approvals — without
editing a single JSON file. Every wizard is a config writer only: it writes
the same `config/*.json` an expert edits by hand, so the optional-collaborator
invariant is untouched (a config with none of these keys behaves exactly as
before). CLI-first this milestone; desktop onboarding is a later phase.

### Added

- **`ai-orchestrator init`** — a guided first-run flow: environment probes,
  first-project creation, Telegram + email setup, the optional auto-resume
  task, a live channel test, and a "you're ready" summary. Idempotent and
  re-runnable; every step is skippable.
- **`projects add --interactive` (`-i`)** — a project-creation wizard that
  asks the questions, creates the working directory and a starter prompt when
  missing, and runs the result through the loader's own `validateProject`
  before writing. Removes the #1 new-user failure (a project born unable to
  write). `<name>`/`--dir`/`--prompt` are now optional; the non-interactive
  path is unchanged but errors with a remedy-first message when they're
  missing.
- **`notify setup telegram`** — validates the BotFather token via `getMe`,
  **discovers your chat id automatically** by polling `getUpdates` (detecting
  an active webhook and explaining the fix), sends a live test, and writes
  `notifications.telegram` + `approvals.providers.telegram`.
- **`notify setup email`** — collects SMTP settings (Gmail App-Password path
  spelled out), sends a real test email, translates the common SMTP failures
  (535 auth, STARTTLS, connection) into plain-language remedies, and writes
  `notifications.email` + `approvals.providers.email`.
- **`ConfigManager.writeLocalConfig(patch)`** — deep-merges a patch into the
  git-ignored `config/local.json` (preserving existing keys): the single
  sanctioned way the wizards persist credentials without touching the tracked
  `orchestrator.json`.
- **`src/onboarding/`** — a small, TTY-free prompt harness (`prompts.js`) and
  the wizards (`projectWizard.js`, `notifyWizard.js`, `init.js`), all
  injectable so every flow is unit-tested with no terminal or network.
- **Docs:** new `docs/DAY_ONE.md` (the guided "0 → first phone approval"
  page the wizards mirror); QUICKSTART/TELEGRAM_SETUP/EMAIL_SETUP now lead
  with the wizard and keep the manual steps as the "by hand" route.

### Tests

- +32 tests (prompt harness, `writeLocalConfig`, project wizard, Telegram/
  email wizards, `init` orchestration); backend suite **468/468** green.
- `init` and the project wizard verified live end-to-end through the real
  readline prompter.

## [2.3.1] — 2026-07-13 — Phase 10.5: Operational Validation & Readiness

An engineering-validation phase (no new architecture). The whole platform
was exercised end-to-end under real conditions: remote notifications
configured and live-verified (Telegram two-way + Gmail SMTP), a real
Claude mission run from approval to commit, the phone approval workflow
driven from an actual phone, ten failure simulations replayed, and
multi-project isolation proven. Seven defects surfaced during the audit
and this pass were fixed at the root.

### Added

- **`config/local.json`** — machine-local config, deep-merged over
  `config/orchestrator.json` and git-ignored, so credentials (SMTP
  passwords, bot tokens) never land in a tracked file. See CONFIGURATION.md.
- **`ai-orchestrator notify test`** — sends a real message through every
  enabled notification channel and prints a per-channel ✔/✘. The missing
  onboarding verifier for remote setup.
- **`ai-orchestrator sessions <project> --abandon`** — archive a stale
  resumable session WITHOUT launching anything, so the next `start` begins
  fresh (refuses if an orchestrator is actively supervising that project).
- **`projects add --permission-mode <mode>`** — the created project now
  includes a `claude.permissionMode` block (default `acceptEdits`); the
  previous behaviour left every new project unable to write unattended.
- **`doctor`** now warns on: a claude project with no write permissions,
  no enabled notification channel beyond desktop, and incomplete
  Telegram/email channel config.

### Fixed

- **Human-action livelock** (found live in the failure sims): a mission
  whose final output merely MENTIONED a blocker word (e.g. "the captcha
  was solved") re-triggered the human-action pause on every relaunch,
  paging the owner forever. Completion (marker / passed verification) now
  outranks fuzzy blocked-pattern matching — verified work never pauses.
- **Per-project `approvals.decisionTimeoutMs`/`decisionPollMs` ignored**:
  `waitForDecision()` read only the global config; it now honours the
  project's effective approval config.
- **`tasks skip`/`tasks approve` left the lifecycle stale**: skipping the
  final blocked task now syncs the mission lifecycle to `completed`
  (approve → `planned`) instead of leaving it stuck at `blocked`.
- **`intel` scored a blocked legacy mission "healthy"**: health scoring
  now also reads the mission lifecycle state, not only the task queue.
- **Missing-engine start error was a raw stack trace**: it is now a
  friendly, remedy-first message (the CLI suppresses the stack for
  user-facing errors).
- **Onboarding trap**: `projects add` + `doctor` (above) close the
  #1 new-user failure (a project born unable to write a single file).

## [2.3.0] — 2026-07-12 — Phase 10: Autonomous Project Manager

From autonomous coding engine to autonomous software engineering MANAGER:
the orchestrator now plans around approvals, communicates through remote
channels, records a standardized mission lifecycle, schedules its own
missions, coordinates parallel missions with shared-resource locks,
analyzes its own history, and automates releases — while the owner keeps
strict control over owner-gated decisions from a phone.

### Added — 10A/10B: the Approval Manager & operating modes

- **`src/approvals/`** — the centerpiece:
  - `approvalPolicy.js`: four approval classes (`automatic`,
    `implementation-review`, `owner-gate`, `human-action`) × three operating
    modes (`conservative` | `balanced` (default) | `autonomous`), decided per
    category. Category lists are configurable; an UNKNOWN category fails
    CLOSED to owner-gate. Modes settable globally and per project
    (`approvals.mode`), via config or `approvals mode --set`.
  - `approvalStore.js`: persisted requests at `state/approvals/<project>.json`
    with globally-unique phone-friendly ids (A1, A2, …), full decision audit
    trail (who/when/via/note), including auto-approved work.
  - `approvalManager.js`: classify → auto-continue or publish-and-pause;
    abortable `waitForDecision()` polling (store + two-way providers);
    emits `approval:required` / `approval:resolved` / `human-action:required`
    exactly once each (deduped across processes).
  - `implementationSummary.js`: a detected plan (output containing
    `approvals.planMarker`, default `IMPLEMENTATION PLAN READY`) becomes an
    owner-facing summary — objective, estimated duration (explicit or tasks ×
    ledger-average run time), estimated files changed, tasks, risks, affected
    systems — published for **APPROVE / REJECT / MODIFY** (MODIFY notes are
    carried into the agent's next briefing).
- **Owner gates**: a task may declare `approval: "<category>"`; owner-gated
  categories (production deployment, data/repo deletion, credentials,
  financial, production config, security, secrets, dangerous — configurable)
  never launch without a decision. Rejection marks the task BLOCKED (the P7
  approve/skip overrides apply) and blocks the mission.
- **Human interaction required**: new blocked-state patterns (CAPTCHA,
  authentication, external login, browser permission, desktop confirmation,
  physical interaction) now pause GRACEFULLY instead of terminally blocking:
  the owner is told exactly what happened, why it stopped, what to do, and
  where — replying `DONE <id>` resumes the mission. With approvals disabled
  the old terminal-block behavior is byte-for-byte preserved.

### Added — 10C: remote approval providers

- **`src/approvals/providers/`** — provider-independent interface
  (`approvalProvider.js`: `publish()` + optional `fetchDecisions()`; shared
  reply grammar `APPROVE/REJECT/MODIFY/DONE <id>`), with two adapters:
  - `telegramProvider.js` (two-way): publishes requests, polls `getUpdates`
    for owner replies (offset persisted; only the configured chat may decide).
  - `emailProvider.js` (publish-only by design — no IMAP dependency): sends
    the request with instructions to respond via Telegram/CLI/desktop.
  - Future WhatsApp/Discord/Slack/push adapters = one subclass each.
- **`src/notifications/smtpClient.js`** — dependency-free SMTP client
  (implicit TLS / STARTTLS / plaintext-for-local-relays, AUTH PLAIN/LOGIN,
  dot-stuffing, header-injection guard). The long-promised **email
  notification channel is now real** (`channels/email.js` placeholder
  replaced) — closes the v1.x "email channel (SMTP)" carry-over.

### Added — 10D: standardized mission lifecycle

- **`src/mission/missionLifecycle.js`**: received → analyzed → planned →
  [approval-pending → approved] → agents-assigned → executing ⇄ verifying ⇄
  fixing → completed | blocked | cancelled | failed. Every transition
  recorded with reason + history at `state/lifecycle/<project>.json`,
  exposed via `GET /api/lifecycle/:project`, the `lifecycle` CLI command,
  and the desktop Missions view.

### Added — 10E/10I: project intelligence & self-improvement

- **`src/intelligence/projectIntelligence.js`** (`intel <project>`,
  `GET /api/intelligence/:project`): health score with named signals,
  is-something-running, next highest-value ready work item, aging approvals,
  blocked-task decisions, dependency stalls, pause-vs-continue advice, agent
  assignment gaps. **Recommendations only — never executes.**
- **`src/intelligence/selfImprovement.js`** (`improve [project]`,
  `GET /api/improvement`): mines ledgers (now with per-run `durationMs` +
  `agentId`), the failure catalog, verification results, agent tallies, and
  the approval audit trail for recurring failures, reliable agents, slow
  agents, verification bottlenecks, always-approved categories (suggests
  automating them), and dominant no-progress patterns. Recommendations only.

### Added — 10F: notification engine expansion

- New events: `approval:required` (critical), `human-action:required`
  (critical), `approval:resolved`, `task:verification-failed` (warning),
  `task:done`, `release:created`, `summary:daily`, `summary:weekly`.
- **Severity policy**: every event has a severity (info/warning/critical,
  overridable via `notifications.eventSeverity`); a global
  `notifications.minSeverity` plus per-channel `minSeverity` decide who gets
  paged for what.

### Added — 10G: scheduled missions

- **`src/scheduler/`** — `cronExpression.js` (dependency-free 5-field cron:
  lists/ranges/steps/names, POSIX dom-vs-dow rule) and
  `missionScheduler.js`: `daily` / `weekly` / `once` / `cron` schedules in
  user-owned `config/schedules.json`, run state in machine-owned
  `state/schedules.json`. Due missions spawn the REAL CLI (`start
  <project>`), never a re-implementation; a running orchestrator defers the
  launch. **Missed-schedule recovery** by default (first sighting anchors a
  schedule; `recoverMissed: false` + grace window opts out).
- CLI: `schedules list|add|remove|enable|disable|run-due|watch`; API:
  `GET /api/schedules`, `POST /api/schedules/...` (auth).
- **Daily/weekly summary digests** (`notifications.summaries`): the watcher
  builds an activity digest (runs, progress, tasks done, blocks, pending
  approvals) and sends it through the notification engine.

### Added — 10H: multi-agent & multi-mission coordination

- **Parallel mission execution by composition**: `start <a> <b> [<c>]`
  supervises several projects in ONE process — each on its own untouched
  Orchestrator instance (every P0–P9 guarantee intact per mission), capped
  by `coordination.maxParallelMissions`. The first project owns
  `status.json`; the rest write `state/status/<project>.json`; one
  heartbeat records all (`projects: [...]`).
- **`src/coordination/`**:
  - `resourceLocks.js`: cross-mission resource locks (task `resources`
    field) — all-or-nothing acquisition, abortable waiting, stale-lock
    reclaim (dead pid / age), release on task completion AND mission end.
  - `dependencyGraph.js`: task `dependsOn` validation (earlier-tasks-only —
    cycles structurally impossible), ready-set computation, conflict
    detection, and an assignment planner with **work stealing**
    (recommendation-only — the declared foundation for distributed
    execution).
  - `agentMessages.js`: durable cross-agent message bus
    (`agent id` / `role:<role>` / `all` addressing); unread messages are
    folded into the recipient's next briefing (or fresh prompt) and marked
    consumed. The orchestrator posts automatic **handoff notes** when the
    next task routes to a different agent; `agents message` CLI +
    `POST /api/messages/:project` post manually.
- **Agent utilization stats**: per-agent `totalRuns`/`totalRunMs`/`avgRunMs`
  in the health report (`agents health`, API, desktop).
- CLI `coordination <project>`: held locks, ready tasks, dependency stalls,
  recent messages. API `GET /api/coordination/:project`.

### Added — 10J: release automation

- **`src/release/releaseManager.js`**: `release prepare <project> <version>`
  generates RELEASE_NOTES.md + VERIFICATION_REPORT.md + release.json under
  `state/releases/` from task checkpoints, verification results, and ledger
  stats. `release apply` is **approval-aware** (`release.approvalCategory`,
  default `commit` → automatic in balanced mode; set an owner-gate category
  to force sign-off; an approval is consumed exactly once): bumps the
  target's package.json, prepends the CHANGELOG entry, git commit + tag.
  **Pushing to a remote is never automated.**

### Changed

- `Orchestrator` accepts four new OPTIONAL collaborators (approvalManager,
  lifecycle, resourceLocks, messageBus) — absent ⇒ byte-for-byte pre-Phase-10
  behavior (all 334 prior tests unchanged and green).
- `validateSingleTask` gains optional `dependsOn`, `resources`, `approval`.
- Progress-ledger records now carry `durationMs` and `agentId`.
- Desktop app: new **Approvals** view (decide requests in one click),
  lifecycle strip in Missions, six new bridge/IPC surfaces.
- `config/orchestrator.json` notification events extended with the Phase 10
  events.
- Release CLI: `--version` collided with commander's program-level version
  flag (found in the live smoke run) — release commands take the version as
  a positional argument instead.

### Fixed

- `approval:resolved` is now announced exactly once even when the decision
  is written by ANOTHER process (CLI/desktop while the orchestrator waits) —
  found live when the lifecycle skipped the `approved` state.

### Verified

- **429/429 tests** (334 prior + 95 new across 12 new test files) plus 18
  desktop-bridge tests.
- **Live smoke pass** (real processes, not mocks): a mission paused on a
  detected implementation plan, was approved via a second CLI process, and
  completed; a past-due `once` schedule was recovered by `schedules
  run-due`, launched a real detached mission, paused on review, and
  completed after approval; `release prepare`+`apply` produced a real
  commit + `v0.1.0` tag in a real git repo; two parallel missions in one
  process serialized on a shared `resources` lock (log-verified:
  "Waiting for locked resources … held by p10-par-a") and both completed.

### Deliberately deferred (documented, not hidden)

- Within-mission parallel task batches (multiple concurrent runs inside ONE
  mission): parallelism ships at mission level; the coordination layer
  (ready sets, locks, assignment planner) is the declared foundation.
- Telegram is the only two-way approval provider; email is publish-only.
- WhatsApp/Discord/Slack/push approval adapters: interface ready, not built.
- The `schedules watch` daemon is a foreground process (pair it with the
  Windows Task Scheduler integration to run at logon).

## [2.2.0] — 2026-07-10 — Phase 9: Multi-Agent Intelligence System

A team of specialized agents in place of a single one. An *agent* is a
named, role-tagged binding of an engine driver + capabilities + engine
settings, layered ON TOP of the existing driver system — tasks route to the
best-fit agent (coding / testing / documentation / research / review /
planner), sequentially, verified between each.

### Added

- **`src/agents/`** — the agent layer:
  - `agentProfile.js`: the `ROLES` vocabulary and pure agent-definition
    validation (mirrors `missionPlan.validateSingleTask`).
  - `agentRegistry.js`: loads `config/agents.json` (global) merged with a
    project's optional `agents` block; wraps the existing `DriverRegistry`
    (each agent references a driver id). **Backward-compat core:** a project
    with no agents configured resolves to a single *implicit* agent wrapping
    `project.driver`.
  - `agentRouter.js`: pure task→agent routing — explicit `agent` id > `role`
    > `capabilities` > project default.
  - `agentHealth.js`: per-agent engine install status + performance tallies
    (tasks done/failed/blocked, attempts, last used) at
    `state/agents/health.json`; never throws into supervision.
- **`src/drivers/cliDriver.js`** (driver id `cli`) — one generic,
  config-driven CLI engine driver so Gemini/Codex/OpenCode/local LLMs are
  added by config, not a class per engine (`command`, `args`, `promptArg`/
  stdin, configurable usage-limit/network regex patterns). Registered in the
  driver registry alongside `claude` and `mock`.
- **Task routing hints**: `validateSingleTask` gains optional `role`,
  `agent`, and `capabilities`. Absent → the default agent (i.e. unchanged).
- **Orchestrator**: resolves the driver **per task** from the routed agent
  (was: one driver per project); switching agents mid-mission starts a fresh
  engine conversation; each checkpoint is stamped with its `agentId`; per-
  agent outcomes are recorded; new `agent:assigned` event; `status.json`'s
  `mission` block gains `currentAgent`/`currentAgentRole`.
- **CLI**: `agents list [project]` and `agents health [project]`.
- **API**: `GET /api/agents[?project=]` and `GET /api/agents/health[?project=]`
  (read-only, like the other GETs).
- **Desktop app**: a new **Agents** view (per-agent role/install/performance
  cards, current agent highlighted); the Tasks view shows each task's agent/
  role and its Add-task form gains role + agent selectors; the Dashboard's
  Agent card shows the current agent + role.
- **Config**: `config/agents.example.json` (Claude coding/review/testing
  agents + disabled Gemini/Codex/OpenCode `cli` presets).
- **Tests**: 39 new — `agentProfile`, `agentRegistry`, `agentRouter`,
  `agentHealth`, `cliDriver` unit suites; `orchestrator.p9` (two-agent
  routing + the legacy-guarantee integration test); plus desktop-bridge
  agent dispatch. **334 total, all green** (the 291 pre-Phase-9 tests
  unchanged).

### Guarantee

A project with no `config/agents.json` behaves **byte-for-byte** as it did
before Phase 9 (one implicit agent = `project.driver`) — asserted by
dedicated unit and integration tests. Backend changes outside `src/agents/`
were limited to the per-task driver resolution in `orchestrator.js`, the
optional task fields, the `status.json` field, and version-string bumps.

### Known limitations (documented, not hidden)

- **Sequential only** — one agent at a time. Concurrent/parallel agents are
  Phase 10 (which owns concurrency); building them now would risk the stable
  single-supervisor core.
- **Inter-agent communication** is handoff via the shared task queue + P5
  memory + P4 briefing (a downstream agent's briefing already carries the
  upstream agent's checkpoint summary), not live message-passing between
  simultaneously-running agents.
- The **Gemini/Codex/OpenCode/local `cli` presets** are real configuration
  but unverified against those actual CLIs (not installed here); `claude`
  and `mock` are the verified reference engines.

## [2.1.0] — 2026-07-07 — Phase 8: Operator Desktop Application

The first real UI on top of P7's dashboard API: an Electron desktop app
(`desktop/`) — a pure client of the existing backend, never a
reimplementation of it. Dashboard, mission control, task queue, timeline,
memory center, logs, and settings, all in one window.

### Added

- **`desktop/`** — a sibling subproject (own `package.json`, own
  `node_modules`; the root project's dependencies/tests are untouched).
  CommonJS main process; plain HTML/CSS/JS renderer (no framework, no
  bundler) — Electron loads the static files directly.
- **`desktop/main/orchestratorBridge.js`** — the dual-mode integration
  layer every IPC handler goes through: when an orchestrator process is
  live (`state/heartbeat.json`), calls the dashboard HTTP API exactly as
  P7 intended ("the UI is purely an API client"); when idle, calls the
  same library classes the CLI's read-only commands use
  (`ConfigManager`/`TaskQueue`/`MemoryStore`/`MissionTimeline`/
  `SessionManager`, all already exported from `src/index.js`) — reuse, not
  duplication, since there is no HTTP server to reach when nothing is
  running. Starting a mission spawns the real `bin/ai-orchestrator.js
  start <project>` as a detached child process (via
  `ELECTRON_RUN_AS_NODE`, no system Node dependency) — the same command a
  human would type — so no supervision logic is reimplemented; stopping
  prefers `POST /api/control/stop`, falling back to the CLI's own
  `stop.requested` file mechanism if the API is unreachable.
- **`desktop/main/logTail.js`** — tails the winston log files for the Logs
  view; works regardless of which process (this app, the CLI, or the
  Scheduler task) started the mission being watched.
- **Seven views**: Dashboard (live status, project grid), Missions
  (start/stop/resume, create a project), Tasks (queue viewer;
  add/remove/reorder/approve/skip), Timeline, Memory Center (notes,
  failure catalog, archived task history), Logs, Settings (API token
  show/rotate, project locations, config file shortcuts).
- 14 new tests (`desktop/test/orchestratorBridge.test.js`, `node --test`):
  live/idle branch selection, HTTP-vs-library dispatch, and the stop
  fallback, against real temp-dir fixtures and a fake `fetch` — no
  Electron/Chromium involved. Also picked up automatically by the root
  `node --test` run (291 total; the 277 pre-existing backend tests are
  unchanged).
- Live-verified via a Playwright `_electron` driver (not committed — a
  throwaway verification script): every view renders without a console
  error; a full mission start → stop (mid-mission) → resume →
  complete cycle against the `mock` driver; and a genuine crash-recovery
  pass — force-killed the spawned orchestrator process mid-mission,
  clicked Start again from the app, and confirmed the Timeline recorded
  "Recovered interrupted session (reboot-or-power-loss)" before completing
  normally.

### Fixed

- A real bug caught during the live-verification pass, not by unit tests:
  the renderer originally mounted every tab into one shared `#view-root`
  element. `missions.js` schedules a delayed re-render after Start/Stop to
  refresh its own live/idle read — if the user switched tabs before that
  timeout fired, it clobbered whatever tab was now showing with stale
  Missions markup. Fixed by giving each tab its own persistent container
  div (`.view-panel[data-view=...]`), so a late callback from a
  since-abandoned tab can only ever write into that tab's own hidden
  container.

### Known limitations (documented, not hidden)

- The Logs view shows orchestrator lifecycle/system events, not the
  agent's raw conversation — confirmed no code path persists full agent
  stdout to disk today. A live child-stdout pipe was deliberately not
  built either: a detached mission must survive the desktop app closing,
  and an unread stdio pipe on an unattended child can fill and block the
  orchestrator's own writes. A per-session transcript file would be a
  reasonable small backend addition later.
- Settings is view-and-create, not a full editor: project locations and
  notification config are shown read-only with a shortcut to the actual
  JSON file; only creating a new legacy (single-prompt) project is fully
  in-app.
- No packaged installer — `npm start` runs the app in dev mode.
  `electron-builder` packaging is a reasonable fast-follow.
- Task `verify` rules are entered as raw JSON, mirroring `tasks add
  --verify-file`, not a visual condition builder.

## [2.0.0] — 2026-07-06 — Phase P7: Desktop Backend — v2 stable

Backend-first, per the roadmap: extends the dashboard HTTP API with
mutating endpoints behind a local auth token. The actual Tauri/Electron
desktop shell is out of scope for this phase — "the UI is purely an API
client," and this is that API's mutation surface. With P7 complete, the
full P0–P7 v2 roadmap ("Autonomous AI Project Manager") is delivered.

### Added

- **`src/api/apiAuth.js`**: a local token (`state/api-token.txt`,
  generated once, `0600`-mode) gates every mutating endpoint below.
  Deliberately not a full auth system — one shared secret, matching the
  "one operator, one machine" model the rest of the CLI already assumes.
  `requireAuth()` checks `Authorization: Bearer <token>` or `X-API-Token`;
  a missing/unconfigured token always 401s (never open-by-default).
- **Mutating dashboard API endpoints** (all require the token; every
  existing read-only endpoint is unchanged and still unauthenticated):
  - `POST /api/control/stop` — gracefully stops the live orchestrator
    (the one endpoint that acts on the in-memory process, not a file).
  - `POST /api/tasks/:project/add|remove|reorder` — mirror the `tasks`
    CLI exactly (same validation, same PENDING-only guards).
  - `POST /api/tasks/:project/approve` / `.../skip` — **new** operator
    overrides (see below), not previously available via CLI either.
  - `POST /api/memory/:project/notes` — mirrors `memory add`.
  - `POST /api/memory/:project/failures/:id/resolve` — mirrors `memory resolve`.
- **`TaskQueue#approveRetry()`**: resets a BLOCKED/FAILED **current**
  task back to PENDING (attempts/checkpoint/verify-result cleared) so the
  next `start` retries it, instead of falling through to a static-plan/
  legacy restart. The only sanctioned way to re-enter a task that
  `block()` shut the door on — always an explicit operator decision,
  never automatic, preserving P0's loop-prevention guarantee.
- **`TaskQueue#operatorSkip()`**: marks the current BLOCKED/FAILED task
  DONE (with an `operator-skipped` checkpoint noting why) and advances
  past it — for when automated verification can't be satisfied but a
  human has confirmed the work is acceptable. Only ever the current task,
  only from a terminal state — can never touch a live/ACTIVE task, so it
  can never interfere with a live agent (by the time a task is
  BLOCKED/FAILED, `block()` has already closed the session and the
  orchestrator process has already exited).
- **CLI**: `tasks approve <project> <taskId>`, `tasks skip <project>
  <taskId> [--reason]`, `api-token [--rotate]`.
- 26 new tests: `TaskQueue#approveRetry()`/`operatorSkip()` unit tests
  (including refusing a non-current or non-terminal task, and proving the
  approved queue gets ADOPTED rather than reinitialized by the next
  session), `apiAuth` unit tests (token generation/persistence/rotation,
  middleware accept/reject, and the "no token configured = always 401"
  safe default), and a real-HTTP `DashboardServer` integration suite
  (ephemeral port, real `fetch` calls) covering every mutating endpoint's
  auth gate and actual on-disk effect. 277 tests total. Verified live: a
  real `App` instance supervising a real mock mission, stopped via a
  genuine HTTP POST to `/api/control/stop` with the auto-generated token
  — session correctly preserved for resume, exactly as the CLI's `stop`
  already guaranteed.

### Known limitations (documented, not hidden)

- No actual desktop application ships in this phase — Tauri/Electron
  shell, mission dashboard UI, timeline visualization, etc. are explicitly
  future work building **on top of** this API, not delivered here.
- The auth model is intentionally minimal: one static shared token, no
  expiry, no per-action scopes, no multi-user support. Sufficient for
  "one operator, one machine, gating accidental/remote mutation," not a
  multi-tenant or internet-facing deployment model.
- `approveRetry`/`operatorSkip` assume single-process operation (no
  orchestrator concurrently supervising the same project while an
  operator calls them) — true by construction today (a task can only be
  BLOCKED/FAILED after the process that hit it has already exited), but
  would need reconsideration if multi-process supervision is ever added.

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
