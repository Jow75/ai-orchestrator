# Project Context

Living snapshot of where AI-Orchestrator stands right now.
Updated periodically during active work sessions — always trust this file
over memory of "what was happening," and trust `git log`/the code itself
over this file if the two disagree (this file can lag reality between
updates).

For durable reference material that doesn't change run to run, see
ROADMAP.md (the phase plan), ARCHITECTURE.md (module design),
CHANGELOG.md (what shipped, in detail), CONFIGURATION.md, API.md,
TROUBLESHOOTING.md, and `desktop/README.md` (the desktop app). This file
is the "what's true *right now*" layer on top of those.

**Last updated:** 2026-07-12, after completing Phase 10 (Autonomous
Project Manager) — verified live end-to-end (see "Live verification"
below) — ahead of committing/tagging `v2.3.0`.

## Where things stand: P0–P7, Phase 8, Phase 9, Phase 10 ALL complete

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
| Phase 8 — Operator desktop application (Electron) | ✅ done | `v2.1.0` |
| Phase 9 — Multi-agent intelligence (roster, role routing, health) | ✅ done | `v2.2.0` |
| Phase 10 — Autonomous Project Manager (10A–10J) | ✅ done | `v2.3.0` |

**Test suite:** 429/429 passing (`node --test` at repo root: 334
pre-Phase-10 plus 95 new across 12 new test files), and 18 desktop-bridge
tests (`npm run test:desktop`).

The user's master prompt arc (desktop app → multi-agent → autonomous
project management) is now COMPLETE through Phase 10. The stated intent
after Phase 10: **do not jump straight to Phase 11** — let Phase 10 mature
through real-world use on AI-Orchestrator itself and THE FINISHER, fixing
approval/notification/coordination edge cases as they surface.

## What Phase 10 shipped (v2.3.0 — see CHANGELOG for full detail)

- **`src/approvals/`** (10A/10B/10C — the centerpiece): ApprovalPolicy
  (4 classes × 3 operating modes; unknown categories fail closed to
  owner-gate), ApprovalStore (persisted requests, phone-friendly ids A1…,
  full audit trail), ApprovalManager (auto-continue vs publish-and-pause,
  abortable waitForDecision, once-only `approval:resolved` even for
  decisions written by another process), implementation summaries
  (objective/duration/files/tasks/risks/systems from a detected plan
  marker), providers: Telegram (two-way — `APPROVE A7` by reply) and email
  (publish-only, real SMTP via new dependency-free `smtpClient.js`, which
  also made the email notification channel real).
- **Human-action pauses**: CAPTCHA/auth/login/browser/desktop/physical
  blocked-patterns pause gracefully (what/why/action/where → `DONE <id>`
  resumes) instead of terminal-blocking; approvals disabled ⇒ exact old
  behavior.
- **`src/mission/missionLifecycle.js`** (10D): received → analyzed →
  planned → [approval-pending → approved] → agents-assigned → executing ⇄
  verifying ⇄ fixing → completed|blocked|cancelled|failed, with history;
  CLI `lifecycle`, API `/api/lifecycle/:project`, desktop Missions strip.
- **`src/intelligence/`** (10E/10I): `intel <project>` (health score,
  next-work-item, pause advice, agent gaps) and `improve` (recurring
  failures, slow/reliable agents, verification bottlenecks, always-approved
  categories) — recommendations ONLY, never executed.
- **10F**: new notification events (approval/human-action/verify-failed/
  release/summaries) + severity levels with global/per-channel minSeverity.
- **`src/scheduler/`** (10G): daily/weekly/once/cron schedules
  (`config/schedules.json`), missed-run recovery, busy deferral, daily/
  weekly digest notifications; `schedules list|add|remove|enable|disable|
  run-due|watch`. Due missions spawn the real CLI.
- **`src/coordination/`** (10H): PARALLEL MISSIONS in one process
  (`start a b c` — each project on its own untouched Orchestrator; primary
  owns status.json, others write `state/status/<name>.json`); cross-mission
  resource locks (task `resources`, all-or-nothing, stale reclaim); task
  `dependsOn` (earlier-only ⇒ cycle-free); cross-agent message bus folded
  into briefings + automatic handoff notes; agent utilization stats;
  work-stealing assignment planner (recommendation-only).
- **`src/release/releaseManager.js`** (10J): `release prepare <proj>
  <version>` (notes + verification report from mission data) and
  approval-aware `release apply` (package.json bump, CHANGELOG entry, git
  commit + tag; NEVER pushes).
- **Surfaces**: ~10 new API endpoints (approvals/lifecycle/coordination/
  intelligence/improvement/schedules/messages + decide/add mutations behind
  the P7 token), 9 new CLI command groups, desktop **Approvals** view +
  lifecycle strip.
- **THE INVARIANT (tested)**: all four new orchestrator collaborators are
  optional — absent (every pre-P10 harness/config) ⇒ byte-for-byte legacy
  behavior. All 334 prior tests unchanged and green.

## Live verification (2026-07-12, real processes — not just unit tests)

1. Mission on the mock driver emitted the plan marker → paused
   `approval-pending` with request A1 → approved from a SECOND CLI process
   (`approvals approve A1`) → mission resumed within the poll interval,
   task verified, `completed`. Lifecycle + timeline recorded every step.
2. A past-due `once` schedule was recovered by `schedules run-due`,
   launched a real detached orchestrator, which paused on review (A3),
   was approved, and completed — lifecycle showed the fixed
   `approval-pending → approved` transition.
3. `release prepare` + `release apply` produced a real commit + `v0.1.0`
   tag in a real (throwaway) git repo, with generated notes/CHANGELOG.
4. `start p10-par-a p10-par-b` ran two missions in one process; the second
   WAITED on the first's `shared-db` resource lock (log-verified), then
   both completed; per-project status snapshot + multi-project heartbeat
   confirmed. Two real bugs found & fixed during the live pass (release
   `--version` flag collision; missing cross-process `approval:resolved`).

## What's next

1. **Maturation, not Phase 11** (the master prompt's own advice): run Phase
   10 for real on THE FINISHER and this repo; expect edge cases around
   approval timing, notification noise (tune `minSeverity`), and
   multi-mission coordination.
2. To go phone-first: enable `approvals.providers.telegram` (+ the
   notification channel) with a BotFather token/chat id, and consider
   `schedules watch` at logon via `scheduler install`.
3. Longer-term backlog (ROADMAP bottom): within-mission parallel task
   batches on the 10H primitives, more approval providers (WhatsApp/
   Discord/Slack/push), driver conformance kit, Windows service mode,
   packaged desktop installer, cross-machine aggregation.

## Conventions worth continuing if more work resumes here

- Version-snapshot-per-phase, each with its own git tag.
- Every phase: implementation → tests → full suite rerun (must stay green)
  → live smoke test (a real running process/app, not just unit tests) →
  docs → version bump → commit → tag.
- Never hide unfinished work or known limitations — state them plainly
  (see every phase's CHANGELOG "Deliberately deferred" section).
- When something feels off, investigate and fix it in the same pass — the
  Phase 10 live smoke caught two real bugs unit tests missed (a commander
  flag collision and a missing cross-process event emission), exactly like
  Phase 8's tab-clobbering bug.
- Approval flows specifically: always test the OUT-OF-BAND path (decision
  written by a different process than the one waiting) — in-process tests
  alone would have shipped the missing-emission bug.
