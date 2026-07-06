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

**Last updated:** 2026-07-06, after committing and tagging `v2.0.0-rc.1`.

## Where things stand

| Phase | Status | Tag |
| --- | --- | --- |
| P0 — Progress awareness & loop prevention | ✅ done | `v2.0.0-alpha.1` |
| P1 — Structured progress engine | ✅ done | `v2.0.0-alpha.2` |
| P2 — Mission system (tasks, verification, checkpoints) | ✅ done | `v2.0.0-alpha.3` |
| P3 — Persistent, runtime-mutable prompt queue | ✅ done | `v2.0.0-beta.1` |
| P4 — Continuation Builder (structured resume/retry briefings) | ✅ done | `v2.0.0-beta.2` |
| P5 — Cross-session memory (notes/failures/task history) | ✅ done | `v2.0.0-beta.2` |
| P6 — Verification engine expansion (schema/lint/deps) | ✅ done | `v2.0.0-rc.1` |
| P7 — Desktop application backend | ⬜ not started | `v2.0.0` (planned) |

**Test suite:** 251/251 passing (`node --test`), 0 known regressions.

## Operating mandate (why I'm not stopping to ask after each phase)

The user issued a standing authorization to implement P1 through P7
without pausing for approval after each phase, subject to engineering
discipline (tests, docs, clean commits, honest limitations) and the
architecture principles below. Stop only when: every phase is done, a
genuinely important architectural decision needs a human, or a real
blocker appears. A comprehensive final engineering report is owed at the
end covering implementation, architecture, tests, limitations, and a
readiness/version recommendation.

Non-negotiable architectural principles carried through every phase:
AI-provider/engine-agnostic (nothing outside `src/drivers/` knows which
engine produced work), progress-driven (workspace-derived facts decide
progress, not the agent's say-so), verification-first ("Claude does not
determine success; verification determines success"), event-driven,
modular, extensible, recoverable (crash-anywhere durability via atomic
writes), observable, testable.

## What P4 + P5 actually changed

- **P4** (`src/briefing/continuationBuilder.js`): every resume/retry now
  gets a generated briefing instead of the old static `continuePrompt`
  string — completed/remaining tasks, and on a verification-failed
  retry, **exactly which check failed and why**. Wired through
  `Orchestrator#buildContinuationPrompt()`. `briefing.enabled: false`
  reverts to the old string byte-for-byte.
- **P5** (`src/memory/memoryStore.js`, `state/memory/<project>.json`):
  operator notes (`memory add` CLI), an auto-recorded unresolved-failure
  catalog (fires on every `block()`), and task history archived just
  before a plan-shape reinit would otherwise discard it. All three feed
  straight into the P4 briefing. `GET /api/memory/:project` is read-only
  access to the same data.

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

## What P6 actually changed

`src/verify/verifierRegistry.js` gained three verifier types, extending
the same registry (not a rewrite): `json-schema` (small dependency-free
validator — documented as a bounded subset, not full draft compliance),
`lint` (parses ESLint's `-f json` output into a specific problem list on
failure), `dependency` (checks `package.json` + `node_modules` agree).
**Deliberately not done**: wiring verification outcomes into
`assessConfidence()`'s `'verified'` signal — verification is already
authoritative for task completion, and the ledger entry for a run is
written before that run's verification executes, so this would need a
pipeline reorder for a cosmetic score bump. ROADMAP.md's earlier language
implying this was corrected rather than left standing as a stale promise.

## Next up

1. **P7 — Desktop application backend**: mutating HTTP endpoints
   (pause/resume/skip/approve) behind a local auth token; the actual
   Tauri/Electron UI is out of scope for the backend phase. Tag `v2.0.0`
   (stable).
2. **Final engineering report** once P7 lands — see the operating mandate
   above for exactly what it must cover.

## Conventions to keep following

- Version-snapshot-per-phase, each with its own git tag; P4+P5 were
  bundled into one `beta.2` snapshot per an earlier user-approved scheme.
- Every phase: implementation → tests (unit + a real orchestrator
  integration test using `MockDriver`) → full suite rerun (must stay
  green) → live CLI smoke test → docs (all seven root `.md` files, not
  just CHANGELOG) → version bump → commit → tag.
- Never hide unfinished work or known limitations — every phase's
  CHANGELOG entry has an explicit "Known limitations" section.
- Test harness pattern: hand-built fake `configManager`/`sessionManager`/
  `statusManager`/`paths` wired directly into `new Orchestrator({...})`,
  driven by `MockDriver`'s scripted runs (`test/orchestrator.p*.test.js`).
