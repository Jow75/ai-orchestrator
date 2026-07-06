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
| `v2.0.0-beta.2` | P4 — intelligent briefing (Continuation Builder) + P5 memory |
| `v2.0.0-rc.1` | P6 — verification engine expansion (JSON schema, lint, dependency checks) |
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
- Tests/build signals for the confidence scorer still arrive with P6
  verification, which reuses `assessConfidence()` rather than a parallel path.

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

## P4 — Intelligent briefing / **Claude Continuation Builder** (`v2.0.0-beta.2`)

> **Flagged as important — do not let this slip.** Replacing the bare
> "Continue." with a generated, structured briefing is one of the highest-
> leverage token savings in the whole project.

Every resume auto-generates a briefing from orchestrator state, e.g.:

```text
Mission: <name>
Current task: <task>
Completed tasks: <list>   (do not redo)
Remaining tasks: <list>
Workspace changes: <git summary since last run>
Verification results: <pass/fail with details>
Known problems: <blockers / failed attempts>
Last checkpoint: <checkpoint summary>
Continue ONLY from here.
```

The agent never rediscovers what the orchestrator already knows.

## P5 — Memory (`v2.0.0-beta.2`)

- Long-term, separated memory: project / execution / task / failure /
  architecture memory. Learn from past runs instead of repeating mistakes.
  (P0's ledger + timeline are the seed of execution memory.)

## P6 — Verification engine expansion (`v2.0.0-rc.1`)

- P2 already shipped the core principle ("verification decides success,
  not the agent") and four verifier types. P6 extends the same
  `verifierRegistry.js` — not a rewrite — with JSON schema validation,
  linting, dependency/build-graph checks, and whatever else real missions
  need. Verified signals continue to raise the confidence score via the
  same `assessConfidence()` extension point P0/P1 established.
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
