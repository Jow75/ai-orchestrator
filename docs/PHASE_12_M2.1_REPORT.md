# Phase 12 M2.1 — Residency, Honesty, and Ports

**Version:** 2.10.0 · **Date:** 2026-07-28 · **Status:** complete, live-validated

This milestone was not planned. It is the direct response to the M2 live-validation
report, and every line of it traces to something that report found.

The console itself passed. The full workflow — `/help`, `/projects`,
`/project <name>`, mission proposal, M-series approval, A-series implementation
approval, execution, completion notification — behaved exactly as designed, and
the two-stage approval architecture was confirmed as correct. What follows are
the two defects and one architectural request that came out of running it for
real.

---

## Bug 1 — the service did not survive a reboot

**Reported:** after restarting Windows, with no Electron and no CLI launched,
`/projects` from a phone produced no response. Running `node bin\ai-orchestrator.js
serve` by hand brought the console straight back.

**Root cause.** Nothing had crashed. `Get-ScheduledTask` showed exactly one
orchestrator task on the machine:

```text
TaskName   : AI-Orchestrator Auto-Resume
State      : Ready
```

The Core Service task — `AI-Orchestrator Core Service`, registered by
`scripts/install-daemon-task.ps1`, shipped in M1 — had **never been installed**.
The `daemon install` command that installs it existed and had never been run.

The deeper problem is that this was undetectable. `doctor` checked only the
auto-resume task, which is a *different job* (finish the mission a reboot
interrupted) and which *was* installed. So every diagnostic the system offered
reported a healthy installation, and the only symptom was silence on a phone.

**What changed.** One layer failed, so the remedy is layered:

| Layer | What it does |
| --- | --- |
| `daemon install` | Registers the logon task — and now **verifies** it registered, rather than trusting the script's exit code |
| Task restart-on-failure | 3 attempts, one minute apart, plus `MultipleInstances=IgnoreNew` |
| `daemon ensure` | Starts the service only if it is not already running or starting |
| `START_SERVICE.bat` | Double-click launcher for manual startup |
| `/service`, `daemon status` | Running / Starting / Stopped, **and** whether it survives a reboot |
| `doctor` | Now **fails** when the logon task is missing |

Two design points are worth stating, because both were decisions rather than
defaults:

**Restart-on-failure without fighting a deliberate stop.** An earlier revision
of the install script deliberately omitted `-RestartCount`, reasoning that the
scheduler would resurrect a service the operator had just stopped. The exit code
resolves it: the daemon has always exited `0` on a signal or `daemon stop` and
`1` on an uncaught exception, and Task Scheduler's `-RestartCount` applies only
to *failures*. A crash restarts; a deliberate stop does not.

**"Starting" is a real state.** Between claiming `state/daemon.json` and
answering HTTP, the service is neither stopped nor usable. Reporting it as
Running makes the next command fail; reporting it as Stopped makes a caller
start a **second** daemon — and two daemons both claim the Telegram long-poll,
where `getUpdates` hands each message to exactly one caller. The symptom of that
would be a console answering every other message.

**Verified live.** Task installed and inspected (`RestartCount 3`,
`RestartInterval PT1M`, `MultipleInstancesPolicy IgnoreNew`, `ExecutionTimeLimit
PT0S`); `daemon ensure` started the service and, run again, correctly declined
to start a second; `/service` over the real bot reported *"After a reboot: starts
automatically ✔"*.

### Closed by a real reboot — 2026-07-28 21:10 (11/11 PASS)

The above verified the *mechanism*. Bug 1 is about the machine coming back on
its own, and only a real reboot can show that. The owner performed a Windows
**Restart**, launched nothing by hand — no daemon, no Electron, no CLI — and
messaged the bot from a phone. `/projects`, `/status` and `/service` all
answered. `scripts/verify-reboot-persistence.ps1` then passed every check:

| Check | What it establishes | Result |
| --- | --- | --- |
| C1 | A boot happened recently enough to be a reboot test (48 min old) | PASS |
| C2 | The Core Service logon task is registered | PASS |
| C3 | Task Scheduler ran it during **this** boot (21:11:31, boot 21:10:57) | PASS |
| C3b | It restarts itself after a crash (`RestartCount=3`, `PT1M`, `IgnoreNew`) | PASS |
| C3c | It ran at **logon**, 0.6 min after boot — not a later hand-start | PASS |
| C4 | A live process matches the recorded pid (12104, v2.10.0) | PASS |
| C5 | The process started **after** the reboot — not a survivor | PASS |
| C6 | The running process is the one the task launched (0.2 s apart) | PASS |
| C7 | The API answers (`GET /api/daemon`) | PASS |
| C8 | The exclusive Telegram inbound channel is live | PASS |
| C9 | The operator console responds on the router a phone message uses | PASS |

The checks are worth more than their count. C5 and C6 exist because "a service
is running after a reboot" is the *conclusion*, not the evidence: a process that
survived the shutdown, or one an operator started by hand while testing, both
produce a green `daemon status` and neither proves autostart. Comparing process
start time against `LastBootUpTime` and against the task's `LastRunTime`
separates the three. C1 exists because a stale session makes the entire run
meaningless, and the script detects Windows **Fast Startup** for the same
reason — with it enabled, "Shut down" does not produce a real boot, so the
script tells the operator to use *Restart* instead.

**Bug 1 is closed on live evidence**, not on the fix having been written.

---

## Bug 2 — a mission completed with no implementation

**Reported:** asked for *"a simple calculator desktop application with React and
Electron"*. The console reported the mission complete, tests passed, verified.
The workspace contained one empty README.

**Answer to the question asked:** option 1 — the workspace was intentionally
simulated. `config/projects/m2-validation.json` carried `"driver": "mock"` and a
comment saying so. `status.json` confirms it:

```json
"session": { "engineSessionId": "mock-session-100001" },
"agent":   { "driver": "mock", "state": "exited" }
```

The mock driver replayed the two scripted runs it was configured with, and every
layer above reported faithfully what it was told. **Nothing malfunctioned.**

But the report is right that this is a defect, and it is worth being precise
about which one. Three separate things were wrong:

### 2a. No surface disclosed that the engine was a fixture

An owner reading *"Mission complete · Verified"* on a phone had no way to know,
and the only remedy available was to walk to the machine and open a JSON file.
Simulation is now a fact the whole system carries
(`src/drivers/simulation.js`), disclosed at every surface: the `/projects`
badge, `/status`, the mission proposal (gate 1), the implementation-plan
approval (gate 2), and the Mission Card — where the notice sits **above** the
status line, because a phone notification preview shows the first line and
"Mission complete" must not travel alone.

The proposal for a simulated project also no longer borrows the real flow's
promise. It previously said *"a planning run starts… it will come back with a
real plan"*; for a fixture that is simply untrue, and it now says the plan is
canned and approving it produces no code.

### 2b. The completion marker was counted as a passing test

This one is **independent of the mock driver and affected real missions.** The
checkpoint for that calculator task reads:

```json
"filesTouched": [],
"verify": { "passed": true, "results": [
  { "type": "marker", "passed": true, "detail": "Completion marker found" }
]}
```

A task that declares no verifiers of its own falls back to the mission
completion marker. That records exactly one fact: the agent emitted the string
`MISSION COMPLETE`. `buildMissionCard` counted it as a passing verifier, which
is how a mission that wrote nothing produced *"Tests: 1/1 passed · Confidence:
Verified"* — the agent grading its own homework, reported as verification.

`missionCard.js` already carried the rule this violated: *"never dress this up
as verified when it wasn't."* Markers are now excluded from both the Mission
Card's test count and the operator console's verifier pass rate. A marker-only
task is `unverified`, which is what it always was.

### 2c. A completed mission that changed nothing said nothing

Cards now state it explicitly. It is the shared signature of both failure modes
this card has actually produced: a simulated engine, and a real engine answering
without write permission (the 2026-07-04 incident). Neither is visible from
"Tasks: 1/1 done".

### Naming

The report's recommendation is taken. `m2-validation` described what the project
was *for*, not what it *does*, and that ambiguity is what turned a working
fixture into a bug report. It is retired and replaced by **`validation-sandbox`**,
whose name, description, README, and fixture text all say it is simulated and
writes nothing. Historical state under `state/` is left intact as the record of
the incident.

---

## Architectural request — the port registry

**Requested:** detect ports in use; reserve permanent ports for projects needing
stable endpoints; auto-allocate for new projects; maintain a registry; prevent
conflicts; let projects cooperate through a central manager.

Delivered as `src/runtime/portRegistry.js`, with three ideas in order of
importance:

1. **The OS is the authority on "in use", not the registry file.** Ports are
   tested by binding them. A registry answering from its own records would hand
   out a port Docker, SQL Server, or a stale node process already holds, and be
   confidently wrong exactly when it matters. The registry records *intent*; the
   kernel reports *reality*; an allocation requires both to agree.
2. **Stable without bookkeeping.** A port is derived deterministically from
   `project:service` (FNV-1a, modulo the range) — the same service gets the same
   port on every machine and every run, before anything is written down and
   again after the state file is deleted.
3. **Reservations are a human decision; allocations are not.** THE FINISHER needs
   5173 because something outside this machine expects it there — that is a fact
   about the world and lives in `config/ports.json`. Dynamic allocations are
   machine-owned and live in `state/ports.json`.

**A real bug, found by live-validating this feature.** `ports check 4711`
reported *"Listening: nothing"* while the Core Service was serving on it. The
probe bound only `0.0.0.0`, and on Windows that **succeeds** while another
process holds `127.0.0.1:<port>`:

```text
0.0.0.0      BINDS (reports free)
127.0.0.1    refused (in use)
```

Loopback is the *default* for dev servers — Vite, Next, and this project's own
API — so the false negative would have hit the common case, handing out ports
that were already serving. The probe now requires both addresses to bind. There
is a regression test binding a loopback-only socket and asserting the port does
not probe free.

### What this deliberately is not

The request named a "Development Runtime Manager". A port broker is the part of
that which is real today. A module that also claimed to manage runtimes while
only managing ports would be the same class of overreach as a mission card
reporting "verified" for work nothing checked — and process supervision already
exists one layer up in `daemon/workerSupervisor.js`, which is where any future
runtime management belongs.

---

## Verification

| | |
| --- | --- |
| Tests | **919 passing, 0 failing** (up from 878; 33 new) |
| New suites | `test/serviceControl.test.js` (14), `test/portRegistry.test.js` (19) |
| Phase 12 Invariant | Holds — standalone `start` is untouched by every change here |
| Backward compatibility | No breaking changes; `simulated` and `ports` are additive and optional |

**Live validation on the real machine and the real bot:**

- Core Service logon task installed, settings inspected in Task Scheduler
- `daemon ensure` starts the service; run again, declines to start a second
- `daemon status` reports Running + autostart state
- `/service` over Telegram reports uptime, workers, and reboot survival
- `/projects` shows `🧪 SIMULATED` on `validation-sandbox` and on nothing else
- `ports reserve` / `get` / `list` / `check` exercised against live sockets
- `GET /api/ports` and `GET /api/ports/:project/:service` verified over HTTP

One incidental finding worth recording: running `ai-orchestrator operator
"/service"` from Git Bash mangles the argument into a Windows path
(`C:/Program Files/Git/service`) before Node ever sees it — an MSYS path-conversion
artifact, not a product defect. It raised two spurious mission requests, which
the two-gate design meant were harmless proposals; both were rejected. Use
PowerShell, or quote defensively, when driving the operator CLI from Git Bash.
