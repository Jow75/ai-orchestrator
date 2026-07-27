# Phase 12 M2 — Telegram Operator Interface: Completion Report

**Version:** `v2.9.0` · **Date:** 2026-07-27 · **Baseline:** `v2.8.0` (Phase 12 M1)
**Plan:** `docs/PHASE_12_PLAN.md` §4 · **User guide:** `docs/OPERATOR_CONSOLE.md`

---

## 1. What shipped

M1 made the daemon always present. M2 makes it something you can **operate**.

The remote channel stops being a place to reply `APPROVE A7` and becomes a
console: list projects, select one, ask for work, watch it happen, stop it if
it goes wrong. Eleven new modules in two directories (`src/events/`,
`src/operator/`), 187 new tests, and **zero lines added to the mission worker
path** — which is why the Phase 12 Invariant survives a second milestone.

| Directive priority | Status |
| --- | --- |
| **1** Project registry | ✅ `/projects` — name, description, path, status, worker, last activity, branch, commit, health |
| **2** Project context | ✅ `/project <name>`, remembered per channel, survives restarts |
| **3** Phone-first conversations | ✅ free text → proposal → approval → real mission → real plan → approval → work |
| **4** Mission lifecycle | ✅ Planning / Coding / Testing / Fixing, derived from real state, no percentages |
| **5** Multi-project management | ✅ several supervised at once, isolated queues/approvals/logs (live-verified) |
| **6** Remote project creation | ⏸ **deferred to M4** (see §8) — the safety rule it depends on is decided here |
| **7** Operator safety | ✅ single-use expiring confirmation on `/stop`, `/reset`, `/shutdown` |
| **8** Future launcher | ⏸ **deliberately not implemented** (the directive says so) — nothing in M2 blocks it |

---

## 2. The architectural decision of this milestone

**The inbound read had to move up one level, and this was not optional.**

M1 established that Telegram's `getUpdates` is offset-acknowledged: polling
with `offset=N+1` permanently *discards* every update up to `N`. M1 solved the
two-process version of that (the daemon is the only poller; workers set
`receiveDecisions: false`).

M2 hit the same rule inside one process. `ApprovalManager.pollProvidersOnce()`
parses each update as a decision and **throws away everything else**. That was
correct while `APPROVE A7` was the entire grammar. The moment the owner can
type `/projects`, a second reader would be needed for commands — and the two
would consume each other's messages exactly as two daemons would.

So the split moved *after* the read, where it is free:

```text
provider.fetchMessages()          ← the one and only consuming read
        │
        ▼
commandGrammar.parseCommand()
        │
   ┌────┴─────┐
   ▼          ▼
decision   command / free text
   │              │
   ▼              ▼
ApprovalManager.applyRemoteDecision()   CommandRouter
   │                                          │
   └──────────────► Event Store ◄─────────────┘
```

`applyRemoteDecision()` was extracted from `pollProvidersOnce()`, so the
gateway resolves approvals through the *identical* store path — including the
once-only `approval:resolved` emission that a waiting worker depends on. Two
ways to apply a decision would eventually have become two behaviours; there is
one. `pollProvidersOnce()` itself is untouched and remains the standalone path.

---

## 3. Honesty under pressure: the two gates

The directive asks for estimated files, tasks, commits, tests, duration, risks
and confidence when a mission is proposed — and, three lines later, forbids
inventing any of them.

Both are satisfiable, but not at the same moment. So there are two gates:

| | Gate 1 — `M4` | Gate 2 — `A9` |
| --- | --- | --- |
| **Question** | Do you want this at all? | Do you accept *this* plan? |
| **When** | The instant you type it | After the agent has read the codebase |
| **Shows** | Objective as typed, branch, path, queue depth, this project's *measured* history | Objective, tasks, files, estimated duration, estimated files changed, risks — **extracted from the agent's own plan** |
| **Built from** | Facts on disk | Phase 10's `implementationSummary.js`, unchanged |

Gate 1 deliberately carries **no estimate of this request's size**. Nothing has
looked at the code yet; a number produced there would be a fabrication wearing
a number's clothes. What it does carry is real and labelled as what it is
("This project's recent history (not a prediction)").

Gate 2 is where the directive's list actually gets answered — by something that
read the repository, through machinery that has existed and been live-proven
since Phase 10.

Nothing new executes work. An approved request becomes a prompt file under
`state/operator/prompts/` and one task on the project's queue — the path
`tasks add` has used since P3 — then a supervised worker. **Remote operation
introduces no new execution path**, which is exactly why it inherits every
P0–P11 guarantee.

---

## 4. What "real progress" means here

> *"Progress must come from real execution. Never fake percentages. Never
> invent confidence. Never simulate work."*

`missionMonitor.js` re-reads `state/lifecycle/<project>.json` and
`state/tasks/<project>.json` every 15 s and turns observed **changes** into
events. A task counted as done is one whose verifiers passed and whose
checkpoint persisted.

- **There is no percentage anywhere in the module.** Elapsed time is not
  progress; a mission 2 of 5 tasks in is "2/5", not "40%".
- **Deriving beats reporting**, for two structural reasons: the worker path
  stays at zero changes, and it works for workers this daemon did not spawn
  (adopted after a restart, or started standalone) — the missions most worth
  watching are precisely the ones that outlived something.
- **It announces only what nothing else covers.** A running mission already
  notifies about approvals, completion, blocking, and crashes. Re-announcing
  those would double every message that matters most — the exact defect class
  Phase 11 M2 spent a milestone eliminating. `ANNOUNCED_PHASES` is `planned`,
  `executing`, `verifying`, `fixing`, `cancelled`, and every exclusion has a
  stated reason in the source.
- **A "Packaging" phase is not reported.** The directive lists it; the mission
  lifecycle has no such state. Inventing one would be simulating work.

---

## 5. Security posture (`PHASE_12_PLAN.md` §6, exercised)

The plan said the security review gets exercised "for real" in M2. It did.

| Requirement | How it is met | Test |
| --- | --- | --- |
| Chat-id restriction | Applied in `fetchMessages()`, **before any parsing** — so no command surface added later can become reachable | `telegramRouting.test.js` |
| No free text implicitly starts work | Free text can only create an inert proposal; approval is a separate explicit message | `commandRouter.test.js` ×6 |
| An unknown instruction is refused, not reinterpreted | `/delete-everything` returns `unknown-command`; it never becomes a mission objective | `commandGrammar.test.js`, `commandRouter.test.js` |
| A decision verb with a bogus id resolves nothing | `APPROVE everything` is refused rather than searched for a match | `commandGrammar.test.js`, `commandRouter.test.js` |
| Prose is not mistaken for a command | "status update: the importer is done…" stays prose | `commandGrammar.test.js` |
| Destructive commands require explicit confirmation | Single-use, expiring, per-channel codes; a bare `/confirm` with two pending is **refused**, not guessed | `confirmations.test.js` ×10 |
| Project creation confined to approved roots | `operator.projectRoots` exists, defaults to **empty**, and empty means refuse (M4 will consume it) | — (M4) |
| Mutating API behind the P7 token | `POST /api/operator/command` 401s without it; nothing reaches the router | `dashboardServer.operator.test.js` |
| Local-only bind | Unchanged | — |

One design note worth stating: the whole grammar can be switched off with
`operator.enabled: false`, which leaves exactly the `v2.8.0` message set.
Approvals are **never** gated by that flag — they predate the operator
interface and are orthogonal to it.

---

## 6. Live validation

Run against a real Core Service on the real installation, with the real
Telegram bot configured and polling (`state/approvals/telegram.offset` advanced
through real `getUpdates` calls; zero poll errors in the log).

Missions ran on the **mock driver** on purpose — this milestone is about the
operator path, not the engine, and a mock mission exercises every line of it
without spending credits.

| # | Claim | Result |
| --- | --- | --- |
| 1 | Service reports its operator interface | ✅ `daemon status` → `Commands: enabled · Channels: telegram` |
| 2 | `/projects` reports real state | ✅ 4 real projects, real branches (`main`, `master`), real health |
| 3 | Context persists across separate processes | ✅ `/project` in one CLI invocation, honoured by the next |
| 4 | Free text starts nothing | ✅ proposal `M1` raised; `Missions (0/3) none running`; no task queued |
| 5 | Approval starts a real supervised mission | ✅ worker pid 13288 forked, task `M1` queued, prompt written under `state/` |
| 6 | The plan gate fires with real content | ✅ `A25` published — the daemon received it, the worker waited on it |
| 7 | Daemon → worker approval hand-off | ✅ `APPROVE A25` applied by the daemon; the worker resumed and completed via the store re-read |
| 8 | Two projects at once, isolated | ✅ one `waiting-approval`, one `running`, separate queues and branches |
| 9 | Destructive gate | ✅ `/stop` returned a code and stopped nothing; a wrong code performed nothing; the right code stopped it |
| 10 | Security refusals | ✅ unknown command refused; bogus decision id refused; prose stayed prose |
| 11 | Event log is a complete record | ✅ 12 events from `mission.created` to `mission.completed`, in order |
| 12 | CLI works with the service **stopped** | ✅ `projects status` and `events` answer from disk |

Two things remain the owner's (§9).

---

## 7. Defects found by live validation

### 7.1 A completed mission worker never exited (M1 code, found in M2)

**The most serious thing in this report.**

A forked worker's IPC channel is a live libuv handle, so its event loop never
drained. A mission would finish, archive its session, release its project
claim, log *"Mission worker shut down cleanly"* — and stay resident forever.
**Every successful mission leaked one process.**

Worse, with no `exit` event the daemon never recorded `worker.completed`, so
the event log — the thing every M2 interface reads — showed missions that
started and never ended. The first live run made that visible: `worker.started`
at 10:46, `mission.completed` at 10:47, and no worker event ever.

**Why M1 missed it.** M1's live pass watched a worker that exited with code 1.
A throwing process terminates whatever handles are open; only a mission that
*succeeds* reaches the clean shutdown path. A crash-focused validation
structurally cannot exercise the case.

**Fix.** `App.shutdown()` now closes the channel in worker mode
(`closeWorkerChannel()`), last, after the project claim is released.

**Test.** `test/workerExit.test.js` forks a real worker with a real IPC channel
and asserts it exits. It was **run against the unfixed code and confirmed to
fail** (25 s timeout, worker still resident) — a regression test that has never
seen the bug it claims to catch is a hope, not a test.

**Re-validated live:** second mission → `worker.completed {code: 0}` recorded
naturally, process gone, no leaked node processes on the machine.

### 7.2 The progress rate limiter treated "never pushed" as "pushed at epoch 0"

Correct with a real clock (the arithmetic is astronomically large), and it
silently swallows the very first update under any other one — including the
injected clock a test uses. Found by a test that failed for the right reason.
`undefined` is now handled explicitly: a limiter whose correctness depends on
the current year is not a limiter.

### 7.3 (Design, caught before shipping) The gateway captured its provider list

Snapshotting `approvalManager.providers` at construction meant a replaced
provider would keep being polled through a stale object — reading an
offset-acknowledged feed with a stale handle is the precise class of bug the
component exists to prevent. Now derived on every read.

### 7.4 (Not a defect, worth documenting) Git Bash mangles `/commands`

`ai-orchestrator operator "/projects"` arrives as
`C:/Program Files/Git/projects` under MSYS path conversion. A shell artifact,
not a code bug — but a real user would hit it, so `docs/CLI_GUIDE.md` and
`docs/OPERATOR_CONSOLE.md` say so, and the grammar already accepts the
slash-free form (`operator "projects"`) in any shell.

---

## 8. Deliberately deferred

Stated plainly rather than quietly dropped.

- **Remote project creation (`/new`)** — Priority 6, worded "eventually" in the
  directive and scheduled for M4 in `PHASE_12_PLAN.md`. The security decision
  it depends on is made *here*, in the milestone that widened the grammar:
  `operator.projectRoots` exists, defaults to empty, and empty means refuse.
- **The launcher** — Priority 8, explicitly "do not implement yet". Nothing in
  M2 blocks it: the service already starts, and the console is already a client.
- **Delete / move / rename project** — Priority 7 lists these as examples of
  destructive actions. They do not exist anywhere in the product yet. When M4
  adds them they inherit the confirmation gate built here; shipping remote-only
  destructive operations first would be backwards.
- **A "Packaging" phase** — no such lifecycle state exists (§4).
- **Moving notification routing into the service** — M1 deferred this to M2.
  It turned out not to be the right fix: the mission monitor announcing only
  the phases nothing else covers removes the duplication problem *without*
  moving the sending side, so workers keep emitting their own Mission Cards
  exactly as they have since Phase 11 M2.
- **Desktop changes** — M3. `GET /api/registry`, `GET /api/events`, and
  `POST /api/operator/command` are what it will move onto.

---

## 9. What needs you

1. **The phone round-trip, from your own Telegram account.** Everything is in
   place and the outbound half is live-verified (approval requests and progress
   pushes reached the bot during validation). The inbound half is proven
   mechanically and against canned real-API payloads, but the final human
   keystroke is yours — the same item M1 left open.

   A safe way to do it, costing nothing: the `m2-validation` project is still
   defined and uses the **mock driver**. With `ai-orchestrator serve` running,
   message your bot:

   ```text
   /projects
   /project m2-validation
   Add a settings page to the dashboard.
   APPROVE M<n>          ← starts a real supervised mission
   APPROVE A<n>          ← the plan gate
   ```

   Delete `config/projects/m2-validation.json` when you are done (it is
   git-ignored, like every project instance).

2. **A real reboot with `daemon install`** — still open from M1, unchanged.
3. **Decide whether the leaked workers from before §7.1 matter to you.** The
   machine is clean now, but if you ran M1 missions successfully between
   `v2.8.0` and today, each left a resident node process. `Get-Process node`
   will show any survivors.

---

## 10. Regression results

**876 → 878 backend tests, all passing** (+187 over `v2.8.0`'s 691), plus
**20/20 desktop**.

New files: `eventStore` (11), `commandGrammar` (12), `operatorContext` (7),
`missionRequests` (11), `confirmations` (10), `projectRegistry` (15),
`operatorRender` (15), `commandRouter` (40), `operatorGateway` (13),
`missionMonitor` (16), `telegramRouting` (11), `dashboardServer.operator` (12),
`daemonOperator` (12), `workerExit` (2).

**One existing test was modified**, and it is worth naming rather than
burying: `daemon.test.js`'s "with no two-way provider the poll loop stays off"
asserted on `daemon.pollTimer`, a field this milestone moved into the operator
gateway. The assertion is unchanged in substance — nothing to poll, no timer
armed — and now reads `daemon.gateway.timer`. Its sibling test ("the inbound
poll loop is the exclusive consumer") needed **no** change and still passes
against the new architecture, which is the stronger signal.

---

## 11. Readiness

| Dimension | Verdict |
| --- | --- |
| Backwards compatibility | **Verified** — the invariant is re-tested for M2; the standalone path is untouched and re-proven |
| Remote operation | **Verified live** — registry, context, proposals, approvals, start/stop, all through the real service |
| Free text cannot start work | **Verified** — tested from six angles and confirmed live |
| Destructive-action safety | **Verified live** — nothing on one message, wrong codes inert, ambiguity refused |
| Real progress, no invention | **Verified** — counts only, no percentages, no re-announcement of what the mission already sends |
| Multi-project isolation | **Verified live** — two projects, separate queues, separate branches, separate approvals |
| Event log as the spine | **Verified live** — a complete ordered record of a full mission, readable by CLI and API |
| Phone inbound round-trip | **Mechanically proven; final human keystroke pending** (§9.1) |
| Regression risk | **Low** — no worker code changed except the §7.1 fix, which removes a leak |

**Phase 12 M2 is complete**, with the open items in §9 stated rather than
glossed. Nothing has been pushed; `v2.9.0` is local on `main`, as after every
prior milestone.

Next: **M3 — Operator Control Center** (`v3.0.0`), the desktop as a pure client
of the registry and event log this milestone built.
