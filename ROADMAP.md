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
| `v2.0.0-alpha.2` | P1 — progress engine (files/git/build/test/verification signals) |
| `v2.0.0-alpha.3` | P2 — mission system (ordered tasks with budgets & checkpoints) |
| `v2.0.0-beta.1` | P3 — persistent prompt queue |
| `v2.0.0-beta.2` | P4 — intelligent briefing (Continuation Builder) + P5 memory |
| `v2.0.0-rc.1` | P6 — verification engine |
| `v2.0.0` | P7 — desktop application; stable release |

### Architectural principle for every phase: **engine-agnostic**

Claude Code is the first engine, not the only one. The progress engine,
verification engine, mission system, prompt queue, memory, and timeline must
never depend on which engine produced the work. Engine-specific knowledge
lives *only* behind the `AIDriver` interface. The target is a platform where
Claude, Gemini, OpenAI, DeepSeek, or a local LLM plug in as interchangeable
drivers. (P0 already honors this: progress is measured from the workspace,
not the agent, and blocked-state patterns are driver-extensible.)

---

## P0 — Progress awareness & loop prevention ✅ (`v2.0.0-alpha.1`, locked)

- Workspace progress signatures (git/filescan, fails closed)
- Circuit breaker on consecutive no-progress runs + blocked-state detection
- Terminal `blocked` state, diagnostic reports, progress ledger
- Standardized per-run **exit reasons**, progress **confidence** scoring
- **Mission timeline** (CLI `timeline`, `/api/timeline/:project`)
- Inter-run delay; confirmed-bug fixes (temp leak, `plugins.enabled`)

## P1 — Progress engine (`v2.0.0-alpha.2`, next)

- Promote the P0 progress *signal* into a first-class engine: explicit
  git-diff analysis, new/modified file inspection, and pluggable progress
  checks — all producing structured, confidence-scored progress facts.
- Per-project `progress` config overrides (P0 is global-only).
- Feed richer signals into the confidence scorer (tests/build in P6).

## P2 — Mission system (`v2.0.0-alpha.3`)

- A mission = ordered tasks, each with objective, prompt, verification,
  completion criteria, retry policy, budget, and checkpoint.
- The orchestrator always knows current / completed / remaining / failed /
  blocked tasks. Usage-limit mid-task → wait → resume the *same task*.

## P3 — Persistent prompt queue (`v2.0.0-beta.1`)

- Queue multiple prompts up front; advance to the next only after the
  current one is verified complete. Survives crashes, restarts, power loss,
  and rate limits.

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

## P6 — Verification engine (`v2.0.0-rc.1`)

- Verification — not the agent's word — decides success: file/dir checks,
  git checks, build, tests, JSON validation, custom shell commands. A task
  is complete only when verification passes. Verified signals raise the
  confidence score introduced in P0.

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
