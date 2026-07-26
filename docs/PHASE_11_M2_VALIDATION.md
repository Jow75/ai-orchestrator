# Phase 11 M2 — Operational Validation

**Date:** 2026-07-27 · **Version:** 2.5.0 → 2.5.1 · **Verdict:** VALIDATED, ready for M3

A dedicated live-validation pass, not a feature phase — following the
project's own rule: *build → live validate → fix real-world issues → then
continue.* M2 (v2.5.0) shipped fixes for duplicate Telegram approval
messages, the README.md dead-link bug, real attachments, and Mission Cards.
This session proved every one of those claims against the owner's real
Telegram bot and real missions, using instrumented real-API calls where a
human couldn't watch every message, and the owner's own phone where it
mattered. Two real defects were found and fixed before they could recur;
two more observations were investigated, confirmed as a platform ceiling
and an intentional design boundary respectively, and documented rather than
patched over.

---

## 1. What was validated (with evidence)

### A — Notification deduplication (real Telegram API, instrumented counts)

All four checks ran against the real bot with a counting wrapper in front
of the real `fetch` — messages actually reached the phone; the wrapper only
adds a definitive, non-fabricated call count.

| # | Check | Result |
|---|-------|--------|
| A1 | A single owner-gate approval → exactly one request message + one resolution message | **PASS** (2 real calls total, confirmed via message-id sequence) |
| A2 | A crash mid-wait, then a **second, independent** Orchestrator/ApprovalManager instance sharing only on-disk state (the truest process-restart simulation) re-enters the same gate | **PASS** — same request id reused, **zero** extra `sendMessage` calls |
| A3 | The provider+channel exclusion is conditional: provider enabled → channel suppressed (A1); provider **disabled** → channel correctly still delivers | **PASS** both directions |
| A4 | Reminder timing against **real elapsed time**: an immediate repeat is suppressed; a repeat after the real `reminderMs` interval sends; the default `reminderMs:0` never resends across multiple real delays | **PASS** all three |

### B/C — Telegram formatting & attachments (owner's own phone)

Four live messages sent (Mission Card, blocked-card, filename/URL
protection check, real document attachment). Owner-confirmed from the
actual Android Telegram client:

- Mission Cards render correctly; emojis (🎉⛔✅📄) display correctly.
- Filenames (`README.md`, `DiagnosticReport.md`, `notes.txt`, `report.pdf`)
  render as plain monospace text — **not** clickable links.
- A real `https://github.com/...` URL stayed a working clickable link
  alongside the protected filenames in the same message.
- The real document attachment opened correctly as a file on Android.

**Found and fixed live:** the owner's own phone check surfaced that
`mission:blocked`/`release:created` still printed the raw absolute
filesystem path (`C:\Users\...\report.pdf`) in the message text — technically
correct (the file exists there) but meaningless to a remote phone operator
who cannot open a Windows path from Telegram. Fixed: both now say the report
is attached (where the channel supports it) or available on the workstation,
never the path itself. See §3.2.

### D — Phone-first complete mission (real Claude Haiku, genuine phone reply)

A fresh task (`T2`, an owner-gated `capitalize-words` utility) queued onto
the existing `phone-demo` project. Full real cycle, the owner's own words:
*"I approved A24 from Telegram... the orchestrator resumed correctly and
completed the mission... I received the completion notification."*
Independently confirmed from the orchestrator's own log: resolution
`via":"telegram"`, task re-launched Claude, agent ran 1m 3s, task verified,
mission complete — with real files created (`capitalize.js`,
`test.capitalize.js`, updated `README.md`) and a real git commit.

### E — Multi-project isolation (real Telegram API)

Two projects (`m2-validation-projA`/`projB`) sharing the same approvals/
notifications directories (as any real installation does — isolation is by
project name, not separate directories):

- Independent request ids; no cross-project id collisions.
- Every real message body mentioned exactly one project — zero
  cross-contamination checked across all sent messages.
- Resolving project A left project B's pending request untouched.
- Separate on-disk notification-state files per project, non-identical
  content.

**PASS** — full isolation confirmed with real evidence.

### F — Recovery regression (real CLI processes, both failure modes)

Two full real-process scenarios, each through the actual `bin/ai-orchestrator.js`
CLI (mock driver — no API cost, since this exercises the supervision/
approval layer, not the agent's coding ability):

1. **Hard crash** — `taskkill /F` on a real running process mid-approval-wait,
   then a fresh CLI `start`. Log: *"Recovering after unclean shutdown"* →
   *"Resuming interrupted session"* (same session id) →
   **"Reusing existing pending approval request (not re-publishing)"** — the
   exact log line from the M2 commit-1 fix, produced by a genuine `taskkill`,
   not a test harness.
2. **Graceful stop/resume** — `ai-orchestrator stop` while paused, then a
   fresh `start`. Identical reuse behavior, log-confirmed.

Both scenarios then had the pending approval resolved via CLI and completed
normally (verified, session closed, mission complete) — **zero regressions**
in the completion path from the M2 dedup/idempotency changes.

---

## 2. UX review (from the owner's own phone experience)

1. **Clicking a desktop toast notification does nothing.** Investigated
   against `node-notifier` v10.0.1's own documentation: on Windows, the
   `desktop` channel uses `WindowsToaster` (SnoreToast), whose supported
   option set (`title`/`message`/`icon`/`sound`/`id`/`appID`/`remove`/
   `install`) has **no click-to-open or click-handler support at all** —
   that capability exists in `node-notifier` only for macOS's
   `NotificationCenter`. This is a confirmed platform-integration ceiling,
   not a bug in this codebase's wiring. Fixing it would mean swapping to a
   different native Windows notification mechanism entirely — real
   architecture, correctly out of scope for a validation pass. Documented
   in TROUBLESHOOTING.md; a legitimate M3+/backlog candidate if pursued.
2. **`mission:complete` doesn't attach the mission's changed source files**
   (`capitalize.js`, `test.capitalize.js`, ...). Confirmed by design, not a
   regression: `EVENT_ATTACHMENT` (added in the M2 attachments commit) only
   covers `mission:blocked`/`release:created`, each a **single** generated
   report document. `mission:complete` has no equivalent structured
   "here is the one file" reference — attaching every changed file would
   mean zero to dozens of attachments per completion, noise rather than
   signal. Now stated explicitly in CONFIGURATION.md rather than left
   ambiguous, per the owner's own request.

Everything else the owner reported from live use: remote approval, mission
resume, completion, Mission Card formatting, and the completion
notification all worked as intended, with **no further issues raised**.

---

## 3. Fixes shipped during this validation

### 3.1 `approval:resolved` was wrongly auto-excluded (commit `8d977e2`)

Found while designing the very first live dedup test, before it ever
reached the phone. The M2 commit-3 fix (provider+channel dedup) had
included `approval:resolved` in the auto-excluded event set. Neither
`TelegramApprovalProvider` nor `EmailApprovalProvider` ever announces a
resolution (each has only `publish()` for the initial request) — so
excluding it from the notification channel silently killed the *only*
notification an owner gets when a decision is made out-of-band (CLI/API/
desktop) while away from Telegram. Fixed: the auto-excluded set is now only
the two events the providers actually publish themselves
(`approval:required`/`human-action:required`); `approval:resolved` is never
auto-excluded. +4 tests. Live-verified (A1's resolution message).

### 3.2 Raw filesystem paths shown to a remote operator (commit `833d72c`)

Found from the owner's own phone check (§1, B/C). `mission:blocked`/
`release:created` now say the report is attached or available on the
workstation, never the raw `C:\Users\...` path. +4 tests. Live-verified.

---

## 4. Readiness verdict

| Dimension | Verdict | Basis |
|-----------|---------|-------|
| Notification deduplication | **Validated** | 4/4 real-API checks pass; one regression found and fixed before the owner ever saw it |
| Telegram formatting | **Validated** | Owner-confirmed on the actual Android client |
| Attachments | **Validated** | Owner-confirmed a real document opened correctly |
| Phone-first workflow | **Validated** | Complete real cycle, owner's own reply, independently confirmed via logs |
| Multi-project isolation | **Validated** | Real API, zero cross-contamination |
| Recovery (crash + stop/resume) | **Validated** | Two real-process scenarios, both log-confirmed, zero regressions |
| Operator UX | **2 items investigated, both correctly triaged** (platform limitation; intentional design, now documented) — no fix required |

**M2 is validated and complete.** Recommendation: proceed to **Phase 11 M3
— Doctor, recovery & operator guidance** (`doctor --fix`, remedy-first
error catalogue, guided recovery), per `docs/PHASE_11_PLAN.md` §6.
