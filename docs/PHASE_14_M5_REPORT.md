# Phase 14 M5 — Test & Verification Visibility

**Version:** `v3.19.0`  
**Date:** 2026-08-02  
**Plan:** [PHASE_14_PLAN.md](PHASE_14_PLAN.md)  
**Predecessor:** [M6 — AI-Assisted Engineering Mission Templates](PHASE_14_PLAN.md)  

Surfaces the specific verifiers that passed or failed on a project's most recent task run, and why — the per-checkpoint detail that `missionCard.js`'s aggregate "Tests: n/m passed" summary intentionally leaves out.

---

## 1. What was built

- **`/tests [project]` (aliases `/verify`, `/verification`)** — a read-only command reading directly from `this.taskQueue.load(project)`, the exact persisted queue `/tasks` already reads. Reads each task's `checkpoint.verify.results` computed by `verifierRegistry.js`'s `runVerifiers()`.
- **Evidence-Only Verifier Exclusion:** Completion marker results are excluded using `missionCard.js`'s `isEvidenceVerifier()` — matching the core rule that an agent's self-declared completion marker is not proof of verification.
- **Detailed Verifier Feedback:** Displays one block per task (`T1 [done]:`) with pass/fail icons (`✅`/`❌`), verifier type (`file-exists`, `command`, `lint`, `json-schema`, `dependency`), and detailed error explanations (e.g. `Not found: dist/bundle.js`).
- **Honest Differentiation:** Distinguishes between "no verification data yet" (no task queue recorded) and "No completed task has recorded verifier results yet" (tasks exist but no evidence verifiers were attached).
- **Security & Read-Only Invariant:** Explicitly never runs tests on demand. Arbitrary remote command execution is restricted to the approval-gated mission pipeline; `/tests` only inspects persisted verification facts.
- **Kill Switch & Event Emission:** Gated by `operator.tests.enabled`; emits `tests.viewed` on successful reads, matching the read-visibility convention of `/workspace`, `/git`, and `/log`.
- **Refactoring:** Centralized verifier tallying into `tallyEvidence()` in `missionCard.js` to ensure uniform calculation across Mission Cards, approvals, and `/tests`.

---

## 2. Verification & Test Evidence

- **Unit Tests:** `test/operatorRender.test.js` (+4 tests) and `test/commandRouter.test.js` (+7 tests).
- **Regression Suite:** Full backend suite passed at 1,387/1,387 tests; desktop suite passed at 41/41 tests.
- **Live Validation:** Validated via the operator CLI bridge against live projects (`calculator-proof`, `Human Typer Fast Speed`, and invalid project names), confirming correct render formats, alias resolution, and event logging.

