# Roadmap

## The v2 mission: from Claude launcher to Autonomous AI Project Manager

v1.x supervises a process. **v2 supervises progress toward a plan** — it
plans work, executes it, verifies real outcomes, remembers what happened,
and completes whole projects with minimal human intervention. The v2 work is
delivered in phases P0–P7, each cut as a version snapshot for clean rollback
points:

| Snapshot | Milestone |
| --- | --- |
| `v2.0.0-alpha.1` | **P0 complete** — progress awareness & loop prevention (locked) |
| `v2.0.0-alpha.2` | **P1 complete** — structured progress engine (files/git change facts) |
| `v2.0.0-alpha.3` | **P2 complete** — mission system: ordered tasks, verification engine, checkpoints |
| `v2.0.0-beta.1` | **P3 complete** — runtime-mutable prompt queue (add/remove/reorder) |
| `v2.0.0-beta.2` | **P4 + P5 complete** — intelligent briefing (Continuation Builder) + cross-session memory |
| `v2.0.0-rc.1` | **P6 complete** — verification engine expansion (JSON schema, lint, dependency checks) |
| `v2.0.0` | **P7 complete** — desktop backend (mutating API + auth token); v2 stable |
| `v2.1.0` | **Phase 8 complete** — operator desktop application (Electron) |
| `v2.2.0` | **Phase 9 complete** — multi-agent intelligence (agent roster, role routing, health) |
| `v2.3.0` | **Phase 10 complete** — Autonomous Project Manager (approvals, modes, remote providers, lifecycle, intelligence, notifications, schedules, coordination, self-improvement, releases) |
| `v2.3.1` | **Phase 10.5 complete** — operational validation & readiness: remote notifications configured + live-verified, real missions + phone approvals driven end-to-end, 10 failure sims replayed, 7 defects fixed (incl. a human-action livelock); `config/local.json`, `notify test`, `sessions --abandon` |
| `v2.4.0` | **Phase 11 M1 complete** — onboarding & first-run wizards: `init` guided setup, `projects add --interactive`, `notify setup telegram\|email` (auto chat-id discovery); a new user reaches a working project + phone approval without editing JSON (see `docs/PHASE_11_PLAN.md`) |
| `v2.5.0` | **Phase 11 M2 complete** — phone & notification experience: fixed two distinct causes of duplicate Telegram approval messages (resume/crash re-publish; provider+channel double-send), killed the README.md-as-dead-link bug with safe HTML formatting, added real Telegram document attachments, and executive Mission Cards on mission-complete/blocked |
| `v2.5.1` | **Phase 11 M2 Operational Validation** — live-validated every M2 claim against the real Telegram bot and real missions; found + fixed 2 more real issues (a wrongly-excluded resolution notification; raw filesystem paths shown to a remote operator); see `docs/PHASE_11_M2_VALIDATION.md` |
| `v2.6.0` | **Phase 11 M3 complete** — doctor, recovery & operator guidance: `doctor --fix` (structured findings, safe repairs + wizard hand-off, both confirmed), a remedy-first error catalogue, and guided recovery (`tasks list`/`approvals list` print the exact next command) |
| `v2.7.0` | **Phase 11 M4 complete — Phase 11 done** — UX consistency & polish: a shared terminology contract (`src/shared/vocabulary.js`) fixed a real drift (three different "success" icons across CLI/notifications/Mission Cards); one version source (`src/infra/version.js`) replaces three hand-synced literals; a startup banner; `notify tune` (interactive per-channel severity); a cross-product consistency audit found and fixed a real desktop/CLI parity bug (in-app project creation never set `claude.permissionMode`); `docs/CLI_GUIDE.md` gained its missing `init`/`notify`/`doctor --fix`/`--interactive` entries |

### Architectural principle for every phase: **engine-agnostic**

Claude Code is the first engine, not the only one. The progress engine,
verification engine, mission system, prompt queue, memory, and timeline must
never depend on which engine produced the work. Engine-specific knowledge
lives *only* behind the `AIDriver` interface. The target is a platform where
Claude, Gemini, OpenAI, DeepSeek, or a local LLM plug in as interchangeable
drivers. (P0 already honors this: progress is measured from the workspace,
not the agent, and blocked-state patterns are driver-extensible. P2's
verification engine follows suit: verifiers check the workspace/output/exit
code, never the engine that produced them.)

---

## P0 — Progress awareness & loop prevention ✅ (`v2.0.0-alpha.1`, locked)

- Workspace progress signatures (git/filescan, fails closed)
- Circuit breaker on consecutive no-progress runs + blocked-state detection
- Terminal `blocked` state, diagnostic reports, progress ledger
- Standardized per-run **exit reasons**, progress **confidence** scoring
- **Mission timeline** (CLI `timeline`, `/api/timeline/:project`)
- Inter-run delay; confirmed-bug fixes (temp leak, `plugins.enabled`)

## P1 — Progress engine ✅ (`v2.0.0-alpha.2`, complete)

- Promoted the P0 progress *signal* into a first-class engine
  (`progressEngine.js`): structured `created`/`modified`/`deleted` file
  facts and git-commit detection, replacing the git-status-based signature.
- **Fixed a real gap**: work inside a git-ignored directory now correctly
  registers as progress (P0's `git status`-based approach could not see it).
- Per-project `progress` config overrides (P0 was global-only).
- Caught and fixed a confidence-scoring bug in the same pass (method-name
  mismatch between the old and new progress signal shapes) — see CHANGELOG.
- Note: P6 shipped verification-engine expansion but deliberately did NOT
  wire verification outcomes into the confidence scorer — see P6's own
  section below for why (verification is already authoritative for task
  completion; a confidence bump for the same decision would be
  redundant, and the ledger entry is written before verification runs).

## P2 — Mission system ✅ (`v2.0.0-alpha.3`, complete)

- A mission = ordered tasks (`src/mission/`), each with objective, prompt,
  verification, per-task retry budget (`maxRuns`), and a checkpoint on
  completion. Legacy single-prompt projects are entirely unaffected
  (`tasks` absent/empty ⇒ v1/P0/P1 behaviour, byte-for-byte).
- **Verification engine (core)** shipped as part of P2, not deferred to P6:
  `file-exists`, `command`, `output-contains`, `files-changed` (the last
  reuses the P1 progress engine's change facts rather than re-deriving
  them). A task with no verifiers falls back to the mission marker as a
  lightweight per-task signal. P6 extends this same registry — never a
  parallel one.
- The orchestrator always knows the current task, its attempt count, and
  its checkpoint (`ai-orchestrator tasks <project>`,
  `GET /api/tasks/:project`); `status`/`/api/status` show task position.
- Usage-limit / crash / network mid-task → resume the *same task*, not the
  mission from the start (verified with a reboot-survival integration test).
- Exhausting a task's retry budget **blocks** (diagnostic report), same as
  P0's stagnation breaker — never silently skips unverified work.
- Checkpoints (`src/mission/checkpoint.js`) capture structured data only;
  turning them into a Claude-facing prompt is P4, not pulled forward here.

## P3 — Persistent prompt queue ✅ (`v2.0.0-beta.1`, complete)

- Reused P2's `TaskQueue` rather than building a parallel structure: the
  static `tasks` array and the runtime queue are the same underlying data.
  New `tasks add/remove/reorder` CLI commands (and the underlying
  `enqueue()`/`removeTask()`/`reorderTask()` methods) let an operator build
  up or adjust a project's plan without editing JSON — including
  bootstrapping mission mode on a project with no static `tasks` at all.
- `removeTask`/`reorderTask` only ever touch a `PENDING` (never-launched)
  task — refused outright on anything active, done, failed, or blocked.
- `getOrInitialize()`'s adoption rule generalized from "same session only"
  to "current task still idle, regardless of session lineage" — which is
  what lets queued-but-never-run tasks, and tasks appended after a prior
  mission completed, run on the next `start`. Preserves every P2 safety
  property: a BLOCKED or FAILED current task is never re-adopted (checked
  by task *state*, not merely queue position) — verified by a dedicated
  regression test, since an earlier draft of this rule got it wrong.
- Advances to the next prompt only after the current one is verified
  (reuses P2's verification engine unchanged); survives crashes, restarts,
  power loss, and rate limits (reuses P2's per-task persistence unchanged).

## P4 — Intelligent briefing / **Claude Continuation Builder** ✅ (`v2.0.0-beta.2`, complete)

> **Flagged as important — do not let this slip.** Replacing the bare
> "Continue." with a generated, structured briefing is one of the highest-
> leverage token savings in the whole project.

Every resume/retry now auto-generates a briefing from live orchestrator
state (`src/briefing/continuationBuilder.js`) instead of a static string:

```text
## Mission Continuation Briefing

**Project:** <name>
**Why you are being resumed:** <reason>

### Current task: <id>
Objective: <objective>

### Completed tasks — do NOT redo these
- <task> ✓

### Remaining tasks after this one
- <task>

### Your previous attempt (#N) was NOT accepted — here is exactly why
- **file-exists** failed: Not found: out.txt

### This task is done only when ALL of these checks pass
- <verifier description>

### Recent activity (most recent last)
- <exitReason>: <result summary>

Continue ONLY from here. Do not repeat completed work.
```

The agent never rediscovers what the orchestrator already knows, and —
the headline property — a failed-verification retry states the exact
failing check and its detail message, not a generic "try again."
Legacy (single-prompt) missions get the equivalent `buildLegacyContinuation()`
briefing, scoped to the whole mission rather than one task.

A global `briefing.enabled` switch (default `true`) reverts to the old
static `continuePrompt` string byte-for-byte when set to `false` — a
deliberate escape hatch for anyone who prefers the old behavior, not a
migration requirement.

## P5 — Memory ✅ (`v2.0.0-beta.2`, complete)

Long-term, cross-session memory (`src/memory/memoryStore.js`,
`state/memory/<project>.json`) — the piece P0's ledger and P2's checkpoints
don't cover: neither survives past the data structure that produced it (a
task queue reinitialization used to discard old checkpoints entirely), and
neither has a place for a durable fact a human wants remembered.

Three categories:

- **`notes`** — operator-authored durable facts (`memory add` CLI),
  categorized `project` (general) or `architecture` (build/structure/
  conventions). Never auto-added or removed.
- **`failures`** — auto-recorded every time supervision `block()`s (a
  BLOCKED or FAILED terminal outcome), independent of session or
  task-queue lifetime. `memory resolve` marks one fixed; only unresolved
  failures are surfaced going forward.
- **`taskHistory`** — archived from a task queue's DONE/FAILED/BLOCKED
  tasks right before a plan-shape change would otherwise discard them,
  so a later plan reusing the same task id can see what happened before.

All three feed the Phase P4 Continuation Builder: every resume/retry
briefing now also carries relevant operator notes, the unresolved-failure
catalog, and (task-scoped) this task id's prior archived attempts —
learning from past runs instead of silently repeating them. `GET
/api/memory/:project` exposes the same data read-only.

## P6 — Verification engine expansion ✅ (`v2.0.0-rc.1`, complete)

- P2 already shipped the core principle ("verification decides success,
  not the agent") and four verifier types. P6 extends the same
  `verifierRegistry.js` — not a rewrite — with three more:
  - **`json-schema`** — validates a JSON file against a schema (a small,
    dependency-free validator covering `type`/`required`/`properties`/
    `items`/`enum`/`minimum`/`maximum`/`minLength`/`maxLength`/`pattern`;
    documented as a bounded subset, not full JSON Schema draft support).
  - **`lint`** — runs a lint command like `command` does, but parses
    ESLint's `-f json` output (when present) into a specific, ranked
    problem list instead of raw stdout.
  - **`dependency`** — checks a package is declared in `package.json`
    and, by default, actually installed in `node_modules` — catches
    "edited package.json, never ran npm install."
- **Deliberately not wired**: `assessConfidence()`'s existing `'verified'`
  signal extension point (P0/P1) is not fed from verification results.
  Verification already authoritatively decides task completion in
  mission mode — a supplementary confidence-score bump for the same
  decision would be redundant, and the ledger entry for a run is written
  (via `assessProgress()`) *before* that run's verification even
  executes, so wiring it would mean reordering the exit-handling
  pipeline for a cosmetic score adjustment. Revisit only if confidence
  scoring itself needs to reflect verification for a concrete reason
  (e.g. a future dashboard view), not by default.
- Revisit plugin-extensible verifier types here if a real need emerges
  (deliberately deferred in P2 — see ARCHITECTURE.md).

## P7 — Desktop backend ✅ (`v2.0.0`, complete — v2 stable)

Backend-first, as planned: extended the HTTP API with mutating endpoints
behind a local auth token (`src/api/apiAuth.js`) — the UI is purely an
API client, and this is that API's mutation surface.

- **Stop** (`POST /api/control/stop`) — the one endpoint acting on the
  live process (`orchestrator.stop()`), same graceful shutdown the CLI's
  `stop` command already used. "Pause/resume" maps onto this plus the
  existing `start` command: supervision has no separate in-place pause
  concept — every resume already IS a `start` against a preserved,
  resumable session, so introducing a second pause primitive would
  duplicate that mechanism instead of reusing it.
- **Task queue mutation** (`add`/`remove`/`reorder`) mirrors the `tasks`
  CLI over HTTP with identical validation and guards.
- **Approve / skip** — the two genuinely new pieces: `TaskQueue#approveRetry()`
  resets a BLOCKED/FAILED current task to PENDING for the next `start` to
  retry (the sanctioned way back in after `block()` shut the door);
  `TaskQueue#operatorSkip()` marks it done-via-override and advances past
  it. Both require an explicit human decision (CLI or API), never
  automatic — P0's loop-prevention guarantee is unaffected.
- **Memory mutation** (`notes`, `failures/:id/resolve`) mirrors the
  `memory` CLI over HTTP.
- **Auth**: one local token (`state/api-token.txt`), required for every
  mutating endpoint; every existing read-only endpoint stays open, as it
  always has been on the local-only bind.

**Explicitly NOT built in this phase** (documented, not deferred quietly):
the actual Tauri/Electron shell, mission dashboard UI, progress timeline
visualization, checkpoint/diagnostics/memory viewers, multi-project
manager, notification center. All of these are real future work — a
concrete UI layer on top of an API that can now both read AND mutate —
but are out of scope for "backend-first."

## Phase 8 — Operator desktop application ✅ (`v2.1.0`, complete)

The concrete UI layer P7 was built for. See `desktop/README.md` for the
full architecture; summary:

- **Electron**, not Tauri — the whole codebase is Node/ESM already; the
  main process reaches the backend directly with no new toolchain.
- **Dual-mode integration** (`desktop/main/orchestratorBridge.js`): the
  dashboard HTTP API when an orchestrator is live, the same library
  classes the CLI uses when idle (there's no HTTP server to reach then).
  Starting a mission spawns the real CLI entry point as a detached child
  process — never a re-implementation of `Orchestrator`/`App` in the UI
  layer.
- Seven views: Dashboard, Missions, Tasks, Timeline, Memory Center, Logs,
  Settings — covering the full read/monitor/control surface P7's API
  exposed. Editing surfaces (full project config editing, every
  notification channel, a visual verify-condition builder) were
  deliberately left as view-and-open-file for v1 — see the desktop
  README's "Known limitations."
- Verified live (not just unit-tested): a full mission start → stop →
  resume → complete cycle, and a genuine crash-recovery pass (force-killed
  the spawned process mid-mission; the app's Start button correctly
  triggered the existing "Recovered interrupted session" path) — for free,
  since it spawns the real, already-tested CLI/supervision code.

**Still explicitly NOT built**: a packaged installer (dev-mode `npm start`
only), multi-agent coordination (Phase 9), autonomous planning/scheduling
(Phase 10).

## Phase 9 — Multi-agent intelligence system ✅ (`v2.2.0`, complete)

A team of specialized agents in place of one. An *agent* is a named,
role-tagged binding of an engine driver + capabilities + engine settings —
built ON TOP of the existing `AIDriver`/`DriverRegistry`, not replacing them.

- **Agent layer** (`src/agents/`): `agentProfile.js` (roles + validation),
  `agentRegistry.js` (loads `config/agents.json` + a project's `agents`
  block, wraps the driver registry), `agentRouter.js` (pure task→agent
  routing), `agentHealth.js` (install status + per-agent performance at
  `state/agents/health.json`).
- **Role routing**: a task's `agent` id > `role` > `capabilities` > the
  project default selects which agent runs it. The orchestrator resolves the
  driver **per task** from the routed agent; switching agents mid-mission
  starts a fresh engine conversation. Task done/failed/blocked outcomes are
  tallied per agent, and each checkpoint is stamped with its agent id.
- **Generic CLI driver** (`src/drivers/cliDriver.js`, id `cli`): one
  config-driven driver for any command-line engine (Gemini, Codex, OpenCode,
  local LLMs) — configured per agent, no class per engine. See
  `config/agents.example.json` for presets. Claude + mock remain the
  fully-tested reference engines.
- **Surfaces**: `agents list|health` CLI, `GET /api/agents[/health]`, and a
  desktop **Agents** view (per-agent role/install/performance cards) plus
  role/agent routing shown and settable in the Tasks view.
- **BACKWARD-COMPATIBILITY GUARANTEE** (the load-bearing invariant, tested):
  a project with no `agents.json` runs on a single *implicit* agent wrapping
  `project.driver` — byte-for-byte identical to pre-Phase-9. All 291 prior
  tests stayed green; 39 new agent tests added (334 total).

**Deliberately deferred** (documented, not hidden): sequential execution
only — concurrent/parallel agents are Phase 10 (which owns concurrency).
Inter-agent "communication" is handoff via the shared task queue + P5 memory
+ P4 briefing (a downstream agent's briefing carries the upstream agent's
checkpoint summary); live message-passing between simultaneously-running
agents needs concurrency first. The Gemini/Codex/OpenCode/local presets are
real `cli` config but unverified against those actual CLIs (not installed
here).

---

## Phase 10 — Autonomous Project Manager ✅ (`v2.3.0`, complete)

The transformation phase: from autonomous coding engine to autonomous
software engineering MANAGER — plan, assign, monitor, recover, communicate,
escalate, learn — owner-controllable from a phone. Ten sub-phases, all
shipped (see CHANGELOG 2.3.0 for full detail):

- **10A — Approval Manager** (`src/approvals/`, the centerpiece): four
  approval classes — `automatic` (routine work continues), `implementation-
  review` (a detected plan becomes an owner-facing summary: objective,
  estimated duration/files, tasks, risks, affected systems — APPROVE /
  REJECT / MODIFY), `owner-gate` (deploys, deletions, credentials, secrets,
  … always ask; configurable), `human-action` (CAPTCHA/login/browser
  prompts pause gracefully with what/why/action/where and resume on DONE).
  Unknown categories fail CLOSED to owner-gate. Full persisted audit trail.
- **10B — Operating modes**: `conservative` (everything asks) / `balanced`
  (default: routine proceeds, reviews + gates pause) / `autonomous` (only
  gates + human actions pause) — global and per-project.
- **10C — Remote approvals**: provider-independent interface; Telegram
  (two-way: APPROVE A7 from the phone) + email (publish-only, real SMTP via
  a new dependency-free client that also made the email notification
  channel real). WhatsApp/Discord/Slack/push = one subclass each, later.
- **10D — Mission lifecycle**: received → analyzed → planned →
  [approval-pending → approved] → agents-assigned → executing ⇄ verifying ⇄
  fixing → completed | blocked | cancelled | failed; recorded with history,
  exposed via CLI/API/desktop.
- **10E — Project intelligence** (`intel`): health score, what-to-work-on-
  next, is-something-running, pause-vs-continue, agent gaps — always
  recommendations, never actions.
- **10F — Notifications**: approval/human-action/verification-failed/
  release/summary events + severity levels with global and per-channel
  `minSeverity` policies.
- **10G — Scheduled missions** (`schedules`): daily/weekly/once/cron
  (dependency-free parser), missed-run recovery, busy deferral, daily/
  weekly digests; due missions spawn the real CLI.
- **10H — Coordination**: parallel missions in one process (`start a b`),
  each on its own untouched Orchestrator (concurrency by composition —
  every P0–P9 guarantee intact per mission); cross-mission resource locks
  (task `resources`); task dependencies (`dependsOn`, earlier-only ⇒ cycle-
  free); cross-agent message bus wired into briefings (automatic handoff
  notes); utilization stats; conflict detection; work-stealing assignment
  planner (recommendation-only — the foundation for distributed execution).
- **10I — Self-improvement** (`improve`): recurring failures, reliable/slow
  agents, verification bottlenecks, always-approved categories, dominant
  no-progress patterns → recommendations, never automatic rewrites.
- **10J — Release automation** (`release prepare/apply`): notes +
  verification report from mission data; approval-aware version bump,
  CHANGELOG entry, git commit + tag. Never pushes.

**Deliberately deferred** (honest scope): within-mission parallel task
batches (mission-level parallelism shipped; the coordination primitives are
the declared foundation); two-way email (IMAP) and further approval
providers; `schedules watch` as a true service (run it via the existing
Task Scheduler integration).

---

## Carried over from v1.x (fold into the phases above)

- ~~Email notification channel (SMTP)~~ — **done in Phase 10C** (dependency-
  free SMTP client). Windows service mode (run without logon) still open.
- More drivers: OpenAI Codex, Gemini CLI, Aider, OpenCode, Qwen, local LLMs,
  plus a driver conformance test-kit every driver must pass
- ~~Concurrent multi-project supervision in one process~~ — **done in Phase
  10H** (`start <a> <b>`, per-project status snapshots, shared locks)
- Cross-machine status aggregation

## Non-goals

- Editing or generating code itself — that is the agent's job; the
  orchestrator supervises and verifies.
- Interactive TUI sessions — supervision targets headless runs; interactive
  use already has a human present.
