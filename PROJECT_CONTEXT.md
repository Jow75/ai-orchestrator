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

**Last updated:** 2026-07-28, after **Phase 12 M2.1 (Residency, Honesty,
Ports), v2.10.0** — committed + tagged, NOT pushed.

---

## Where things stand right now (2026-07-28)

**M2 was live-validated on the real machine and the real bot, and the console
passed** — `/help` → `/projects` → `/project` → proposal → M-approval →
A-approval → execution → completion all behaved as designed. The two-stage
approval model is confirmed correct. **M2.1 is the response to what that run
found.** Full report: `docs/PHASE_12_M2.1_REPORT.md`.

Three things came out of it, and all three are now closed:

1. **The service did not survive a reboot.** Not a crash — the
   `AI-Orchestrator Core Service` logon task shipped in M1 and had *never been
   installed*, and `doctor` checked only the unrelated auto-resume task, so
   every diagnostic called the machine healthy while a phone got silence. Now:
   `daemon ensure` (idempotent, never starts a second daemon),
   `START_SERVICE.bat`, restart-on-failure on the task, `/service` +
   `daemon status` reporting Running/Starting/Stopped **and** reboot survival,
   and `doctor` **failing** when the task is missing. Task is installed on this
   machine and verified in Task Scheduler.

2. **A simulated mission reported itself as real work.** A `mock`-driver
   project asked for a React/Electron calculator reported "complete, verified"
   over an empty workspace. Nothing malfunctioned; nothing *disclosed*.
   Simulation is now a first-class fact (`src/drivers/simulation.js`) disclosed
   at every surface. Two sub-defects fell out of it, and **one affected real
   missions**: the completion marker (the agent emitting `MISSION COMPLETE`)
   was being counted as a passing *test*, producing "Tests: 1/1 · Verified" for
   work nothing checked. Markers are now excluded from test counts and pass
   rates everywhere.

3. **The port registry** (`src/runtime/portRegistry.js`) — the architectural
   request. Deterministic per `project:service`, availability confirmed by
   binding rather than by trusting a file, reservations in `config/ports.json`
   and allocations in `state/ports.json`. `ports get/reserve/release/list/check`
   plus `GET /api/ports/:project/:service`.

`m2-validation` is retired in favour of **`validation-sandbox`**, which says in
its name, description, README and fixture text that it is simulated.

**NEXT: Phase 12 M3 — Operator Control Center (desktop as daemon client),
`v3.0.0`.** Note for M3: `projectRegistry.describe()` already carries
`simulated` on every record, so the desktop gets the disclosure for free — it
must render it.

---

**Phase 12 was 2 of 4 done at M2.** M1 made the daemon always present; **M2 makes it
something you can operate from a phone**. The remote channel stopped being a
place to reply `APPROVE A7` and became a console: `/projects` (a real registry
the daemon owns — status, worker, branch, commit, health), `/project X` (a
context that persists per channel), `/status`, `/tasks`, `/start`, `/stop`,
`/approvals`, `/missions`, `/events`, `/reset`, `/shutdown`. New
`src/operator/` (9 modules) and `src/events/` (the append-only JSONL log at
`state/events/events.jsonl` — the spine every interface reads). Full guide:
`docs/OPERATOR_CONSOLE.md`; report: `docs/PHASE_12_M2_REPORT.md`.

**THE ARCHITECTURAL MOVE OF M2:** the inbound read went up one level.
`ApprovalManager.pollProvidersOnce()` parses each update as a decision and
DISCARDS the rest — fine while `APPROVE A7` was the whole grammar, data loss
the moment `/projects` exists (getUpdates is offset-acknowledged). The new
`OperatorGateway` performs the ONE consuming read per provider per tick and
routes decisions *and* commands from it; decisions go through the extracted
`ApprovalManager.applyRemoteDecision()`, the identical store path (and
once-only `approval:resolved` emission) `pollProvidersOnce` always used.
`pollProvidersOnce` is untouched and is still the standalone path.

**THE HONESTY CONSTRAINT, and how it was met:** the directive wants estimated
files/tasks/duration/risks/confidence on a mission proposal, and forbids
inventing any of them. So there are TWO gates. Gate 1 (`M4`, the instant you
type) shows only facts — objective as typed, branch, path, queue depth, and
this project's *measured* history, labelled as history; **no estimate of this
request's size, because nothing has read the code yet**. Gate 2 (`A9`) is
Phase 10's implementation-review flow, unchanged: the agent plans, and
`implementationSummary.js` extracts the real numbers FROM THE PLAN. An approved
request becomes a prompt file under `state/operator/prompts/` plus one task on
the project's queue (the `tasks add` path since P3) plus a supervised worker —
**remote operation adds no new execution path**, which is why it inherits every
P0–P11 guarantee. Progress is likewise derived, not reported:
`missionMonitor.js` re-reads lifecycle + task-queue files every 15s; counts
only, **no percentages anywhere**, and it never re-announces phases the mission
itself already notifies about.

**Live validation found a serious M1 defect:** a mission worker that COMPLETED
never exited — the forked IPC channel is a live libuv handle, so the event loop
never drained. Every successful mission leaked a resident process, and with no
`exit` event the daemon never recorded `worker.completed`, so the event log
showed missions that started and never ended. M1's live pass missed it because
the worker it watched exited with code 1 (a throwing process terminates
regardless of open handles); only a mission that *succeeds* reaches the clean
shutdown path. Fixed in `App.shutdown()`; the regression test
(`test/workerExit.test.js`) forks a real worker and **was confirmed to fail
against the unfixed code**. Two smaller fixes: the progress rate limiter
treated "never pushed" as "pushed at epoch 0", and the gateway captured its
provider list at construction.

Tests: **878/878 backend** (+187) + 20/20 desktop. **One** existing test was
modified — `daemon.test.js`'s "no provider ⇒ no timer" now reads
`daemon.gateway.timer` instead of `daemon.pollTimer`, the field this milestone
moved; the assertion is unchanged in substance, and its sibling
("the inbound poll loop is the exclusive consumer") needed no change at all.

**Still needs the owner:** (1) the phone round-trip from your own Telegram
account — outbound is live-verified, inbound is proven mechanically; the
`m2-validation` project is left defined on the **mock driver** so you can do
the whole loop for free (delete it after); (2) a real reboot with `daemon
install`, unchanged from M1. **Next: M3 — Operator Control Center (`v3.0.0`)**,
the desktop as a pure client of the registry and event log M2 built.

---

Previous: **Phase 12 M1 (AI-Orchestrator Core
Service), v2.8.0** — committed + tagged, NOT pushed.

**Phase 12 is underway** (M1 of 4). The product changed shape: it is no longer
"an executable that sometimes runs" but **a service clients connect to**.
`ai-orchestrator serve` runs an always-on daemon (`src/daemon/`) owning the
HTTP API, the **exclusive** Telegram inbound poll, the scheduler tick, and
mission workers as supervised child processes. Three constraints were removed:
(E1) supervision ownership moved from the MACHINE (`state/heartbeat.json`) to
the PROJECT (`state/workers/<project>.json`), so **several projects now run at
once** — previously structurally impossible; (E2) the API and remote channel
now exist when **no mission is running** — before, both lived inside the
mission process and vanished with it; (E3) Telegram `getUpdates` is
offset-acknowledged, so two pollers destroy each other's messages — inbound
now has exactly one owner (`ApprovalManager.receiveDecisions`, default `true`
so every old caller is unchanged; workers set it `false` and still see
decisions via the store re-read `waitForDecision` has done since Phase 10).

**THE PHASE 12 INVARIANT (tested + live-checked):** with no daemon running and
no daemon config, every pre-Phase-12 command behaves exactly as in `v2.7.0`.
No existing test was modified to accommodate the new architecture.

**Live validation found three real defects, all fixed:** mission workers died
with the service (plain `fork` doesn't survive its parent here → now detached,
the same conclusion the desktop reached in Phase 8); "stop" wasn't graceful on
Windows (a cross-process `SIGTERM` is `TerminateProcess`, so stopping an
adopted worker killed it mid-mission while the CLI claimed the session stayed
resumable → now per-project stop-request files, hard kill only as escalation);
and the service recorded its configured rather than bound port. A fourth issue
found while building: a `process.exit()` in a shutdown path silently truncated
a test file, hiding six tests behind a green run.

Tests: **691/691 backend** (+83) + 20/20 desktop. Two items still need the
owner: the final human step of the phone round-trip (`APPROVE <id>` from your
own Telegram account) and a real reboot with `daemon install` (verified
installable/removable, currently **not installed** — that changes logon
behaviour, so it's your call). Full report: `docs/PHASE_12_M1_REPORT.md`;
plan for all four milestones: `docs/PHASE_12_PLAN.md`. **Next: M2 — Telegram
Operator Interface (`v2.9.0`)**, where the inbound command grammar widens and
the security review in `PHASE_12_PLAN.md` §6 gets exercised.

Previous: **Phase 11 M4 (UX Consistency, Remote
Polish & Documentation), v2.7.0** — committed + tagged, then pushed to
GitHub (`github.com/Jow75/ai-orchestrator`) with a GitHub Release on
`v2.7.0`. **`v2.7.0` is the official stable baseline** — the known-good
checkpoint to return to before any further development. Phase 11 planning
docs and milestone reports are archived under `docs/archive/phase-11/`.
**Phase 11 is now complete** (M1→M4, `v2.4.0`→`v2.7.0`). New `src/shared/vocabulary.js` is
the single source for mission-outcome icons/labels, approval-decision
labels, confidence labels, and check marks — fixed a confirmed drift where
the same "mission succeeded" outcome rendered as three different icons
(CLI ✔ / notification title 🎉 / Mission Card ✅) purely from independent
inline literals; all three now agree on ✅. New `src/infra/version.js`
replaces three hand-synced hardcoded version literals (package.json, the
CLI's `.version()`, `statusManager.js`) with one source — this release is
the first to prove it (only `package.json` was edited). New startup banner
(`src/cli/banner.js`, printed once when `start` launches: version,
project(s), resolved approval mode, enabled channels) and `notify tune`
(interactive per-channel `minSeverity` — the config key existed since Phase
10F but only via hand-edited JSON until now). A full cross-product
consistency audit (install → init → doctor → create project →
notifications → approvals → mission lifecycle → recovery → shutdown →
resume) found and fixed a **real bug**, not just stale docs: the desktop
app's in-app "create project" never set `claude.permissionMode` (unlike the
CLI's `projects add`, defaulted since 10.5/M1) — a desktop-created project
would silently accomplish nothing on its first real mission; both paths now
match. Also fixed 8 documentation gaps, the largest being `docs/
CLI_GUIDE.md` (billed as "every command") missing `init`, the whole
`notify` group, `doctor --fix`, and `projects add --interactive` entirely.
Backend suite **608/608** + 20/20 desktop. Full plan: `docs/
archive/phase-11/PHASE_11_PLAN.md`; full report + Phase 11 retrospective +
Phase 12 recommendation: `docs/archive/phase-11/PHASE_11_M4_REPORT.md`.
**Next: let Phase 11 mature through real-world use before shaping Phase
12** (the same advice this project gave itself after Phase 10, which
proved out well — Phase 10.5's maturation pass is what produced the
evidence base Phase 11 was built from).

Previous: **Phase 11 M3 (Doctor, Recovery & Operator Guidance), v2.6.0**
— `doctor` rebuilt from structured findings + `doctor --fix` (safe direct
repairs on confirmation; anything needing real input hands off to the
matching M1 wizard), two new evidence-based checks (quarantined corrupt
state files; an unsupervised resumable session), `src/infra/errors.js`
error catalogue, guided recovery in `tasks list`/`approvals list`. See
`docs/archive/phase-11/PHASE_11_M3_REPORT.md` for full detail.

Before that: **Phase 11 M2 + Operational Validation (v2.5.0/v2.5.1),
2026-07-26/27** — phone & notification experience (approval-reuse dedup,
provider+channel dedup, safe Telegram formatting, real attachments, Mission
Cards), then live-validated against the real Telegram bot and real
missions (2 more real bugs found and fixed); see CHANGELOG and
`docs/archive/phase-11/PHASE_11_M2_VALIDATION.md` for full detail.

Before that: **Phase 11 M1 (v2.4.0), 2026-07-14** — onboarding & first-run
wizards (`init`, `projects add --interactive`, `notify setup
telegram|email`); see CHANGELOG for full detail.

Before that: **Phase 10.5 (v2.3.1), 2026-07-13** — an engineering-validation
phase, no new architecture. Remote notifications configured AND live-verified (two-way
Telegram bot `@jowgei_orchestrator_bot`, chat id 6522731464, + Gmail SMTP
through the built-in smtpClient); credentials now live in the new
git-ignored `config/local.json`. Two real Haiku Claude missions run end to
end (`validation-demo`: approval A7 → implement → 5 verifiers → commit →
completed; `phone-demo`: **owner approved A8 from their actual phone via
Telegram** → resumed → completed). All ten failure simulations replayed
(reject, modify, verify-fail, crash, human-action, notify-fail, parallel,
stop/resume, missed-schedule, lock contention). Multi-project isolation
proven (state separation + corruption containment). **Seven defects fixed
at the root**, each with a regression test: (1) a human-action LIVELOCK
found live — a run mentioning a blocker word re-paused forever; completion
now outranks fuzzy blocked-pattern matching; (2) per-project
`approvals.decisionTimeoutMs`/`decisionPollMs` now honoured by
waitForDecision; (3) `tasks skip`/`approve` now sync the mission
lifecycle; (4) `intel` health now reads lifecycle state (no more "blocked
= healthy"); (5) missing-engine start error is now friendly, not a stack
trace; (6) `projects add` now writes `claude.permissionMode` + doctor
warns when missing; (7) new `notify test` + `sessions --abandon`. Test
suite: **436/436** + 18 desktop. Full write-up:
`docs/PHASE_10.5_READINESS.md`; Phase 11 plan: `docs/archive/phase-11/PHASE_11_PROPOSAL.md`.
Readiness verdict: **8.6/10, READY for Phase 11** (onboarding/UX is the
frontier). THE FINISHER now has a `claude` block; still needs a real
mission prompt before its first serious run.

Previous update: 2026-07-13, after a full product-readiness audit (no new
phase work) — the audit that seeded the Phase 10.5 objectives.
Before that: 2026-07-12, after completing Phase 10 (Autonomous Project
Manager) — verified live end-to-end — ahead of tagging `v2.3.0`.

## Where things stand: P0–P7, Phase 8, Phase 9, Phase 10, Phase 11 ALL complete

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
| Phase 10.5 — Operational validation & readiness | ✅ done | `v2.3.1` |
| Phase 11 — Operator Experience (M1–M4: onboarding, phone/notifications, doctor/recovery, UX consistency) | ✅ done | `v2.7.0` |
| Phase 12 M1 — AI-Orchestrator Core Service (daemon, worker supervision, exclusive remote channel) | ✅ done | `v2.8.0` |
| Phase 12 M2 — Telegram Operator Interface (project registry, command grammar, event log, mission requests) | ✅ done | `v2.9.0` |
| Phase 12 M2.1 — Residency, honesty, ports (from M2 live validation) | ✅ done | `v2.10.0` |
| Phase 12 M3 — Operator Control Center (desktop as daemon client) | ⏳ next | `v3.0.0` |
| Phase 12 M4 — Launch experience & remote project creation | ⏳ planned | `v3.1.0` |

**Test suite (current, 2026-07-28):** 919/919 backend + 20/20 desktop —
M2.1 added 33 (`serviceControl` 14, `portRegistry` 19) plus the simulation and
marker regressions; the 608/608 figure was the Phase 11 M4 snapshot and
436/436 below is this section's original Phase-10.5-era one.

The user's master prompt arc (desktop app → multi-agent → autonomous
project management) completed at Phase 10; the stated intent at the time
was **do not jump straight to Phase 11** — let Phase 10 mature first. That
maturation pass (Phase 10.5) produced the evidence base Phase 11 was built
from, and **Phase 11 (Operator Experience, M1–M4) is now also complete**
(see "Last updated" above). The same advice now applies one phase later:
**let Phase 11 mature before shaping Phase 12** — see "What's next" below.

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

1. **Maturation, not Phase 12** (same advice this project gave itself after
   Phase 10, which proved out well): run Phase 11 for real on THE FINISHER
   and this repo; let actual use — not speculation — surface what Phase 12
   should be. Phase 11 itself is already phone-first (`init` connects
   Telegram/email) and self-diagnosing (`doctor --fix`); day-to-day use
   should mostly mean running missions, not more setup.
2. If/when Phase 12 planning starts, the two candidates flagged-but-deferred
   across Phase 11 (see `docs/archive/phase-11/PHASE_11_M4_REPORT.md` §10) need their own
   evidence pass first, per this project's standing rule: a driver
   conformance kit / additional engines (Gemini, Codex, OpenCode — the
   `cli` driver already supports them, just unverified against the actual
   CLIs), and a packaged desktop installer.
3. Longer-term backlog (ROADMAP bottom): within-mission parallel task
   batches on the 10H primitives, more approval providers (WhatsApp/
   Discord/Slack/push), Windows service mode, cross-machine aggregation.

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
