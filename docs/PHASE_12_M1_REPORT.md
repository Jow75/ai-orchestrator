# Phase 12 M1 — AI-Orchestrator Core Service: Completion Report

**Version:** `v2.8.0`
**Date:** 2026-07-27
**Baseline:** `v2.7.0` (Phase 11 complete)
**Plan:** `docs/PHASE_12_PLAN.md`

---

## 1. What shipped

AI-Orchestrator is no longer "an executable that sometimes runs." It is a
service that clients connect to. The CLI is now the first of those clients;
the Telegram router (M2) and the desktop control center (M3) will be the next
two, and both were deliberately left out of this milestone.

| Module | Responsibility |
| --- | --- |
| `src/daemon/daemon.js` | The service: API, exclusive Telegram inbound poll, scheduler tick, worker lifecycle, recovery |
| `src/daemon/daemonRecord.js` | `state/daemon.json` — is the service up, and on which port |
| `src/daemon/workerRegistry.js` | `state/workers/*` — which process supervises which project, and graceful stop requests |
| `src/daemon/workerSupervisor.js` | Spawn / adopt / stop mission workers; all the safety rules |
| `src/daemon/daemonClient.js` | One discovery + auth path for every client |

Modified, all additively: `src/app.js` (worker mode), `src/approvals/
approvalManager.js` (`receiveDecisions`), `src/api/dashboardServer.js` (daemon
routes behind an optional collaborator), `src/cli/index.js` (`serve`,
`daemon *`, daemon-aware `start`/`stop`/`status`), `src/config/defaults.js`,
`src/infra/paths.js`, plus two new PowerShell autostart scripts.

---

## 2. The three constraints this milestone removed

Each was established by reading the `v2.7.0` code, not by assumption
(`PHASE_12_PLAN.md` §2 carries the citations).

**E1 — One orchestrator per machine.** `state/heartbeat.json` was a
machine-wide lock (`src/app.js:296`, `:412`). Starting Calculator while Remote
Work ran was structurally impossible; Phase 10H parallelism was decided once
at launch and immutable. **Now:** ownership is per-project
(`state/workers/<project>.json`), and missions start and stop independently.

**E2 — Nothing existed between missions.** The API lived inside the mission
process; Telegram was polled only while a mission sat waiting on an approval.
A message sent when nothing was running was read by nobody. **Now:** the
service runs with zero missions and answers anyway.

**E3 — Telegram polling had no owner.** `getUpdates` is offset-acknowledged:
polling with `offset=N+1` permanently discards everything up to N. A daemon
polling alongside a waiting mission would have consumed that mission's
`APPROVE A7` reply and left it waiting forever — a livelock introduced *by*
the new architecture. **Now:** exactly one process receives, enforced at the
`ApprovalManager` level and tested from both sides.

The fix for E3 needed no new Telegram code, because `waitForDecision()` has
re-read the store and announced other processes' decisions since Phase 10.
The distinction that made it small: **outbound publishing is stateless and
safe to duplicate; inbound polling is offset-stateful and must have one
owner.**

---

## 3. THE PHASE 12 INVARIANT

> With no daemon running and no daemon configuration, every pre-Phase-12
> command behaves exactly as in `v2.7.0`.

This is a tested requirement, not an intention — see
`test/appWorkerMode.test.js` ("INVARIANT: …" ×2) and
`test/dashboardServer.daemon.test.js` (a server built without a daemon answers
503 on every `/api/daemon` route and is otherwise untouched). It was also
verified live: with the service stopped, `start` produced the identical banner
and behaviour, and `state/heartbeat.json` was never written by any worker.

Worker mode withdraws exactly four machine-singleton duties — global
heartbeat, API port, Telegram receive, stop-file watching — and changes
nothing about supervision. A worker is the same `Orchestrator` with the same
P0–P11 guarantees.

---

## 4. Live validation

Run against the real installation, the real bot, and real processes.

| # | Check | Result |
| --- | --- | --- |
| 1 | Service starts and answers with **zero** missions running | ✅ `daemon status` at 12s uptime, 0 missions, Telegram inbound active |
| 2 | A second CLI process reaches it | ✅ status + `curl /api/daemon/workers` |
| 3 | **Two projects supervised simultaneously** | ✅ `p12-svc-a` (pid 7444) + `p12-svc-b` (pid 18928) — the E1 capability |
| 4 | Real Telegram inbound, exclusively owned | ✅ owner's bot reachable; getUpdates offset advanced monotonically; **zero** poll failures over the whole session |
| 5 | Worker crash detected, service survives | ✅ stale records reaped, service unaffected |
| 6 | **Missions survive the service dying** | ✅ *after a fix* — see §5 |
| 7 | A restarted service **re-adopts** them | ✅ same pid 25900, listed `(adopted)` |
| 8 | Graceful stop of an **adopted** worker | ✅ *after a fix* — logs show `Supervision stopped by request; session preserved` → `Mission worker shut down cleanly` |
| 9 | Windows autostart installs and removes | ✅ task registered `Ready`, then removed |
| 10 | The Phase 12 Invariant, live | ✅ standalone `start` unchanged; heartbeat.json untouched |

**Not validated, and honestly flagged:** the final human step of the phone
round-trip — an owner sending `APPROVE A7` from their own Telegram account —
could not be performed, because only the account holder can send it. Every
mechanical part around it *was* proven: the service really polls the real bot
(offset advancing, zero failures), and the worker↔store↔daemon handoff is
tested end-to-end with a shared on-disk store in
`test/approvalPollOwnership.test.js`. **This is the one step needing you**
(§8).

A real reboot was also not performed. The autostart task was verified as
registered and removable; the reboot itself is yours to do.

---

## 5. Defects found by live validation

Unit tests passed on all three of these. Only running the real thing exposed
them — the same pattern as Phase 8's tab-clobbering bug and Phase 10's
flag collision.

**5.1 — Mission workers died with the service.** A plain `fork` does not
survive its parent here: killing the service took both missions with it. Every
service restart — an upgrade, a crash, a reboot — would have destroyed hours
of unattended work. **Fix:** workers spawn detached, the same conclusion the
desktop reached in Phase 8 for the same reason. Re-tested: worker survived,
next service adopted it.

**5.2 — "Stop" did not mean stop gracefully.** On Windows,
`process.kill(pid, 'SIGTERM')` against another process is `TerminateProcess`,
not a catchable signal. Stopping an adopted worker killed it mid-mission while
the CLI reported "the session stays resumable." It did not. **Fix:**
per-project stop-request *files* — the mechanism `ai-orchestrator stop` has
used since P0 — with a hard kill only as escalation after a grace window. The
same applied to `daemon stop`, which previously made a deliberate stop look
like a crash in the next `daemon status`.

**5.3 — The service recorded its configured port, not the bound one.** A
client trusting the record could be sent to a port nothing was listening on,
which presents as a network fault rather than a clear error.

Two further issues were found while building and are worth recording:

**5.4 — Conflict errors printed stack traces.** All three new supervision
conflicts now use Phase 11 M3's `userFacingError` catalogue (cause / impact /
fix), matching every other user-fixable error since M3.

**5.5 — `process.exit()` in a shutdown path silently truncated the test
file.** Six tests after it never ran, and the runner still reported success.
Exiting is now behind an overridable `exitProcess()`. Worth stating plainly:
for a while this milestone had a green suite that was not running all of its
tests.

---

## 6. Regression results

| Suite | Before (v2.7.0) | After (v2.8.0) |
| --- | --- | --- |
| Backend | 608 / 608 | **691 / 691** |
| Desktop | 20 / 20 | **20 / 20** |

83 new tests. Every pre-existing test passes unmodified — no existing test was
edited to accommodate the new architecture. One new test was *rewritten*
during the milestone (adopted-worker stop, from signal to stop-file) because
live validation proved its original expectation wrong.

New files: `daemonRecord` (8), `workerRegistry` (14), `workerSupervisor` (17),
`approvalPollOwnership` (5), `dashboardServer.daemon` (9), `appWorkerMode`
(13), `daemon` (17).

---

## 7. Deliberately deferred

- **Notification routing stays with workers.** The brief lists it as a service
  responsibility, and it will be — but moving it now, while workers still emit
  their own, would duplicate every event, which is precisely the class Phase 11
  M2 spent a milestone eliminating. It belongs with M2's Mission Card work,
  where the sending side is being rewritten anyway.
- **No new Telegram command grammar.** The service polls with the same
  `parseDecisionText` workers used, so the accepted message set is byte-for-byte
  `v2.7.0`. Widening it is M2, behind its own security review.
- **No desktop changes.** The desktop still works through its existing
  live/idle bridge. Making it a true multi-project daemon client is M3.
- **No mission runs inside the service.** Always a child process, so a mission
  crash can never take down the phone, the desktop and the scheduler at once.
- **Local-only.** The service binds `127.0.0.1` like every other surface here.

---

## 8. What needs you

1. **The phone round-trip** (§4). With the service running and a mission parked
   on an approval, reply `APPROVE <id>` from your Telegram account and confirm
   the mission resumes. This is the one M1 claim proven mechanically but not
   with a real human keystroke.
2. **A real reboot**, after `ai-orchestrator daemon install`, to confirm the
   service comes back. The task was verified as installable and removable, and
   is currently **not installed** — installing it changes your logon behaviour,
   so that decision is yours.
3. **Whether `daemon install` and `scheduler install` should both be on.** They
   answer different questions (keep the service available vs. finish an
   interrupted mission) and are independent.

---

## 9. Readiness

| Dimension | Verdict |
| --- | --- |
| Backwards compatibility | **Verified** — invariant tested and live-checked; no existing test modified |
| Simultaneous projects | **Verified live** — two independent missions at once |
| Exclusive remote channel | **Verified live** against the real bot; handoff tested end-to-end on disk |
| Mission survival across service restarts | **Verified live**, after the fix in §5.1 |
| Graceful stop | **Verified live**, after the fix in §5.2 |
| Windows autostart | **Mechanism verified**; reboot pending (§8) |
| Phone round-trip | **Mechanically proven; final human step pending** (§8) |
| Regression risk | **Low-to-moderate** — the process model changed, but every new path is opt-in and the old one is untouched |

**Phase 12 M1 is complete**, with the two open items in §8 stated rather than
glossed. Nothing has been pushed; `v2.8.0` is local on `main`, as after every
prior milestone.

Next: **M2 — Telegram Operator Interface** (`v2.9.0`), which is where the
inbound grammar widens and therefore where the security review in
`PHASE_12_PLAN.md` §6 gets exercised for real.
