# Project Context

Living snapshot of where AI-Orchestrator's v2 rebuild stands right now.
Updated periodically during active work sessions — always trust this file
over memory of "what was happening," and trust `git log`/the code itself
over this file if the two disagree (this file can lag reality between
updates).

For durable reference material that doesn't change run to run, see
ROADMAP.md (the phase plan), ARCHITECTURE.md (module design),
CHANGELOG.md (what shipped, in detail), CONFIGURATION.md, API.md,
TROUBLESHOOTING.md. This file is the "what's true *right now*" layer on
top of those.

**Last updated:** 2026-07-06, after committing and tagging `v2.0.0` (stable).

## Where things stand: the full P0–P7 roadmap is complete

| Phase | Status | Tag |
| --- | --- | --- |
| P0 — Progress awareness & loop prevention | ✅ done | `v2.0.0-alpha.1` |
| P1 — Structured progress engine | ✅ done | `v2.0.0-alpha.2` |
| P2 — Mission system (tasks, verification, checkpoints) | ✅ done | `v2.0.0-alpha.3` |
| P3 — Persistent, runtime-mutable prompt queue | ✅ done | `v2.0.0-beta.1` |
| P4 — Continuation Builder (structured resume/retry briefings) | ✅ done | `v2.0.0-beta.2` |
| P5 — Cross-session memory (notes/failures/task history) | ✅ done | `v2.0.0-beta.2` |
| P6 — Verification engine expansion (schema/lint/deps) | ✅ done | `v2.0.0-rc.1` |
| P7 — Desktop backend (mutating API + auth token) | ✅ done | `v2.0.0` |

**Test suite:** 277/277 passing (`node --test`), 0 known regressions.

The comprehensive final engineering report the operating mandate (below)
required has been delivered in-conversation. This file remains the living
snapshot for whatever comes next (bug fixes, the actual desktop UI,
carried-over v1.x items — see ROADMAP.md's bottom sections).

## Operating mandate (why phases ran without a stop-and-ask each time)

The user issued a standing authorization to implement P1 through P7
without pausing for approval after each phase, subject to engineering
discipline (tests, docs, clean commits, honest limitations) and the
architecture principles below. That mandate is now fulfilled — all seven
phases shipped, each tagged, each with a full test suite rerun and a live
smoke test, none skipped or partially done.

Non-negotiable architectural principles carried through every phase:
AI-provider/engine-agnostic (nothing outside `src/drivers/` knows which
engine produced work), progress-driven (workspace-derived facts decide
progress, not the agent's say-so), verification-first ("Claude does not
determine success; verification determines success"), event-driven,
modular, extensible, recoverable (crash-anywhere durability via atomic
writes), observable, testable. All held throughout — see the final
engineering report for the phase-by-phase accounting.

## What each phase actually shipped (one line each — see CHANGELOG.md for detail)

- **P4** (`src/briefing/continuationBuilder.js`): generated resume/retry
  briefings replace the static `continuePrompt` string; a failed
  verification retry names exactly which check failed and why.
- **P5** (`src/memory/memoryStore.js`): cross-session notes, an
  auto-recorded failure catalog, and task history archived before a
  plan-shape reinit would discard it — all folded into the P4 briefing.
- **P6** (`src/verify/verifiers/{jsonSchema,lint,dependency}.js`): three
  new verifier types on the same registry. Deliberately did NOT wire
  verification into `assessConfidence()`'s `'verified'` signal (redundant
  with verification already being authoritative; corrected stale ROADMAP
  language saying otherwise).
- **P7** (`src/api/apiAuth.js`, `DashboardServer` mutating routes,
  `TaskQueue#approveRetry()`/`#operatorSkip()`): a local-token-gated
  mutation surface on the dashboard API (stop, task queue edits,
  approve/skip a blocked task, memory notes/resolve) — backend-first, no
  desktop UI shipped (explicitly out of scope for this phase).

## A bug fixed along the way (worth knowing about)

`.gitignore` had an **unanchored** `state/` rule that was silently
matching `src/state/` as well as the intended runtime `state/` directory.
Result: `sessionManager.js`, `statusManager.js`, `missionTimeline.js`,
`heartbeat.js`, and `statePersistence.js` had **never been committed**,
since before P0 — a fresh clone would have been missing the entire
session/status persistence layer. Fixed by anchoring the runtime-data
rules (`/state/`, `/logs/`, `/sessions/`, `/status.json`) to the repo
root, and committed the previously-untracked files in the same commit as
P4+P5 (`8d0bb84`). If anything in `src/state/` seems to have vanished
after a future `git clone`, this is the first thing to check.

## What's next (all outside the P0–P7 mandate — genuinely new work, not owed)

1. **The actual desktop application** — Tauri/Electron shell consuming
   the API P7 built (mission dashboard, timeline visualization, task
   queue manager UI, checkpoint/diagnostics/memory viewers). P7 only
   built the backend for this.
2. **Carried-over v1.x items** (ROADMAP.md's bottom section): email
   notification channel, Windows service mode, more engine drivers
   (Codex, Gemini CLI, Aider, ...) plus a driver conformance test-kit,
   concurrent multi-project supervision, cross-machine status aggregation.
3. Anything the user directs next — no more phases are outstanding.

## Conventions worth continuing if more work resumes here

- Version-snapshot-per-phase, each with its own git tag; P4+P5 were
  bundled into one `beta.2` snapshot per an earlier user-approved scheme.
- Every phase: implementation → tests (unit + a real orchestrator/API
  integration test using `MockDriver`/real HTTP calls) → full suite
  rerun (must stay green) → live smoke test (CLI and/or a real running
  process, not just unit tests) → docs (all seven root `.md` files, not
  just CHANGELOG) → version bump → commit → tag.
- Never hide unfinished work or known limitations — every phase's
  CHANGELOG entry has an explicit "Known limitations" section.
- Test harness pattern: hand-built fake `configManager`/`sessionManager`/
  `statusManager`/`paths` wired directly into `new Orchestrator({...})`,
  driven by `MockDriver`'s scripted runs (`test/orchestrator.p*.test.js`).
- When something feels off (a bug in git status, a stale doc claim),
  investigate and fix it in the same pass rather than deferring — this is
  how the `.gitignore` bug and the stale P6 confidence-scoring promise
  were both caught.
