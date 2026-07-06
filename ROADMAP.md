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
| `v2.0.0` | P7 — desktop application; stable release |

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

## P7 — Desktop application (`v2.0.0`)

- Backend-first: extend the HTTP API with mutating endpoints (pause/resume/
  skip/approve) behind a local auth token; the UI is purely an API client.
- Tauri (preferred) or Electron shell: mission dashboard, progress timeline,
  prompt-queue manager, usage/rate-limit monitor, checkpoint viewer,
  diagnostics, memory viewer, multi-project manager, notification center.

---

## Carried over from v1.x (fold into the phases above)

- Email notification channel (SMTP); Windows service mode (run without logon)
- More drivers: OpenAI Codex, Gemini CLI, Aider, OpenCode, Qwen, local LLMs,
  plus a driver conformance test-kit every driver must pass
- Concurrent multi-project supervision in one process
- Cross-machine status aggregation

## Non-goals

- Editing or generating code itself — that is the agent's job; the
  orchestrator supervises and verifies.
- Interactive TUI sessions — supervision targets headless runs; interactive
  use already has a human present.
