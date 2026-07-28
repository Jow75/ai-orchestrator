# Phase 10.5 — Product Readiness Assessment

**Date:** 2026-07-13 · **Version:** 2.3.1 · **Verdict:** READY for Phase 11

An engineering-validation phase, not a feature phase. The goal was to
prove — with real processes, real credentials, and a real phone — that
AI-Orchestrator can function as the owner's autonomous software engineer,
interrupting the owner only for genuine owner-level decisions. This
document records what was done, the evidence, and an evidence-based score.

---

## 1. What was validated (with evidence)

### Environment (Part 1)

- `node --test`: **436/436 passing** (was 429; +7 new regression tests).
- `npm run test:desktop`: **18/18 passing**.
- `doctor`: all green across 5 projects; the only ✘ is the optional
  auto-resume scheduled task.
- Every subsystem launches: status, agents, schedules, approvals,
  lifecycle, intel, notify, CLI, API, desktop bridge.

### Remote notifications (Part 2)

- **Telegram** — token `<redacted>` validated via `getMe`
  (bot handle redacted). Chat id **`<redacted>`** discovered from
  the owner's first message. Two-way approval provider + one-way channel
  both live. `notify test` → ✔ telegram.
- **Email** — real Gmail SMTP (`smtp.gmail.com:587`, STARTTLS, app
  password) through the built-in dependency-free `smtpClient.js`. Real
  test emails delivered. `notify test` → ✔ email.
- **Credentials** live in the new git-ignored `config/local.json` —
  confirmed ignored by `git check-ignore`.
- **Future providers** (WhatsApp/Discord/Slack/push): the
  `ApprovalProvider`/notification-channel abstraction is intact and each
  remains "one subclass" of work — not implemented, by instruction.

### Real mission, end to end (Part 3)

`validation-demo` (a fresh project created exactly as a new user would,
via `projects add`) ran a real Haiku Claude mission:
owner-gate approval **A7** → approved out-of-band from a second CLI
process → implementation → **5 verifiers** (3 file-exists, `node test.js`,
`git log`) → real git commit → `completed`. Lifecycle recorded every
transition; notifications fired.

### Phone workflow (Part 4)

`phone-demo` mission paused on owner-gate **A8**; the owner **approved from
their actual phone** by replying `APPROVE A8` in Telegram; the mission
resumed within the poll interval and completed. This is the headline
workflow — mission arrives → phone notified → owner approves remotely →
mission finishes — proven with a real device.

### Failure simulations (Part 5) — 10/10

| # | Scenario | Result |
|---|----------|--------|
| 1 | Rejected approval | mission blocked with the owner's reason; lifecycle `blocked` |
| 2 | Modified approval | mission continued; MODIFY note carried into the task |
| 3 | Verification failure to exhaustion | retried to `maxRuns`, blocked, diagnostic report named the exact failing check |
| 4 | Crash recovery | crash → 15 s backoff → resumed → completed |
| 5 | Human-action pause | captcha pattern → paused → `DONE` → resumed |
| 6 | Notification-channel failure | dead webhook logged + swallowed; mission unaffected |
| 7 | Parallel missions | two missions, one process; second waited on the first's `shared-db` lock, then completed |
| 8 | Stop / resume | stopped mid-run; restart resumed the same conversation to completion |
| 9 | Missed-schedule recovery | past-due `once` schedule launched by `run-due`, completed |
| 10 | Resource-lock contention | (covered by #7) lock acquired/waited/released, log-verified |

**A real bug surfaced here** (see §3): the human-action pause could
livelock. Found live, fixed at the root, regression-tested, and
re-verified live.

### Multi-project isolation (Part 6)

- Per-project state files: `state/tasks/<p>.json`,
  `state/lifecycle/<p>.json`, `state/status/<p>.json`, memory per project.
- **Memory isolation:** a note added to `sim-par-a` did not appear in
  `sim-par-b`.
- **Corruption containment:** garbage written into one project's task
  queue produced a clean "no queue" message for that project while every
  other project listed, ran, and completed normally.

---

## 2. Configuration completed

- `config/local.json` created (git-ignored) with Telegram + Gmail
  credentials; both providers and both channels enabled.
- `config/orchestrator.json` notification events already cover the Phase
  10 event set.
- `THE FINISHER` project given a `claude.permissionMode` block (was the
  audit's outstanding gap); still needs a real mission prompt before its
  first serious run.
- Two stale `waiting-retry` sessions (THE FINISHER, example) cleared with
  the new `sessions --abandon`.

---

## 3. Bugs found and fixed (7)

1. **Human-action livelock** (found live). A run whose output merely
   mentioned a blocker word re-triggered the human-action pause on every
   relaunch — paging the owner forever. **Fix:** completion (marker /
   passed verification) now outranks fuzzy blocked-pattern matching.
   Regression test + live re-verification.
2. **Per-project approval timing ignored.** `waitForDecision()` read only
   global `decisionTimeoutMs`/`decisionPollMs`. **Fix:** it now honours the
   project's effective approval config. Regression test added.
3. **`tasks skip`/`approve` left the lifecycle stale.** Skipping the final
   blocked task left the mission showing `blocked` forever. **Fix:** the
   task queue syncs the lifecycle (`completed`/`planned`). Live-verified +
   3 regression tests.
4. **`intel` scored a blocked mission "healthy".** Health scoring ignored
   the lifecycle. **Fix:** it now also reads the lifecycle state.
5. **Missing-engine start error was a raw stack trace.** **Fix:**
   friendly, remedy-first message; CLI suppresses the stack for
   user-facing errors.
6. **Onboarding trap: `projects add` created unwritable projects.**
   **Fix:** it now writes `claude.permissionMode: "acceptEdits"` and
   `doctor` warns about any project still missing it.
7. **No way to test notifications or clear a stale session.** **Fix:**
   `notify test` and `sessions --abandon` added.

---

## 4. Readiness scores (evidence-based)

| Dimension | Score | Basis |
|-----------|:----:|-------|
| Architecture | 9.5 / 10 | Optional-collaborator invariant intact; 436 tests; clean module boundaries |
| Reliability | 9 / 10 | 10/10 failure sims; crash/stop/reboot recovery proven; one livelock found & fixed |
| Automation | 9 / 10 | Real unattended mission + parallel missions + schedules all live |
| Remote workflow | 9 / 10 | Phone approval driven end-to-end on a real device; two-way Telegram + email |
| Maintainability | 9 / 10 | Every fix root-caused with a regression test; docs kept in lockstep |
| Documentation | 8.5 / 10 | 7 guides synced this phase; setup guides now match reality |
| Onboarding | 7 / 10 | Biggest remaining gap: still config-file editing, no first-run wizard |
| Operator experience | 7.5 / 10 | `notify test`/`--abandon`/doctor warnings help; setup is still manual |
| Developer experience | 9 / 10 | `mock` driver, doctor, clear errors, fast test suite |
| **Overall** | **8.6 / 10** | Production-grade engine; onboarding/UX is the frontier |

---

## 5. Remaining issues (all non-blocking, Phase 11 candidates)

- Onboarding is still hand-editing JSON — no guided first-run wizard.
- `THE FINISHER` needs a real mission prompt before a serious run.
- Auto-resume scheduled task not installed on this machine (optional).
- No packaged desktop installer; desktop app runs from source.
- Notification noise is untuned (all channels get everything at `info`);
  per-channel `minSeverity` exists but isn't set.

---

## 6. Recommendation

**AI-Orchestrator is ready to enter Phase 11.** The engine is
production-grade and now proven under real-world conditions — including
the full phone-first remote workflow. The remaining friction is entirely
in onboarding and operator experience, which is exactly Phase 11's
mandate. See [PHASE_11_PROPOSAL.md](archive/phase-11/PHASE_11_PROPOSAL.md).
