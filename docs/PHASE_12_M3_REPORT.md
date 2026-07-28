# Phase 12 M3 — Operator Control Center: Completion Report

**Version:** `v3.0.0`
**Date:** 2026-07-28
**Baseline:** `v2.11.0` (Phase 12 M2.2 complete)
**Plan:** `docs/PHASE_12_PLAN.md` §4, M3

---

## 1. What shipped

The desktop app becomes a pure client of the Core Service, closing the gap M1
deliberately left open (*"the desktop keeps working through its existing
live/idle bridge; M1 only adds the daemon it will later prefer"*). Before this
milestone, `desktop/main/orchestratorBridge.js` knew about exactly one kind of
liveness — `state/heartbeat.json`, written only by a standalone `ai-orchestrator
start` — so the moment reboot persistence (M2.1) made the Core Service the
normal state, the desktop's own liveness check went permanently blind to it.

| Change | Where |
| --- | --- |
| `supervisor()` — daemon / standalone / neither | `orchestratorBridge.js` |
| `apiBase()` prefers the port the service actually bound | `orchestratorBridge.js` |
| `startMission()` hands a second project to the service instead of spawning a rival | `orchestratorBridge.js` |
| `stopMission(reason, project)` — stops one mission, never the service | `orchestratorBridge.js` |
| `getRegistry()` — every project, one call, same records the phone gets | `orchestratorBridge.js` |
| `getServiceStatus()` — the `/service` answer, with autostart resolved from Task Scheduler even while the service is down | `orchestratorBridge.js` |
| `getAllApprovals()` — every decision waiting, across every project | `orchestratorBridge.js` |
| `isProjectLive(project)` — one project's liveness, not the machine's | `orchestratorBridge.js` |
| **Control Center** — new landing tab | `renderer/views/control.js` |

---

## 2. The defect this milestone exists to fix

Before M3, "is anything live" meant one file. Read literally:

```js
async isLive() {
  const heartbeat = readJsonSafe(paths.heartbeatFile);
  return Boolean(heartbeat && heartbeat.state === 'running' && isPidAlive(heartbeat.pid));
}
```

`state/heartbeat.json` is written by exactly one code path: a standalone
`ai-orchestrator start`. The Core Service never touches it — it has its own
record (`state/daemon.json`) and its own per-project worker registry. So with
the service supervising two missions and answering a phone, every desktop read
that branched on `isLive()` took the file path: `getStatus()` read a stale
`status.json`, `getTasks()` bypassed the API a running worker was updating,
and the header read *"Idle — no orchestrator running"* while the service sat
one HTTP call away.

This was not hypothetical for this investigation. It is the same shape of bug
as Bug 1 (M2.1) — a diagnostic asking the wrong question and reporting
confidently — just one layer up, in the client that had not learned the
service exists.

**The fix is one method, used everywhere liveness was checked:**

```js
async supervisor() {
  const client = await this.service();
  if (client.isRunning()) return 'daemon';
  const heartbeat = readJsonSafe(paths.heartbeatFile);
  return (heartbeat?.state === 'running' && isPidAlive(heartbeat.pid)) ? 'standalone' : null;
}
async isLive() { return (await this.supervisor()) !== null; }
```

The service is checked first because when both a service and a standalone run
exist — legitimately, on different projects — the service is the one that
owns the API port. Every read (`getStatus`, `getTasks`, `getMemory`,
`getTimeline`, `getAgents`, …) inherits the fix through `isLive()`/`apiBase()`
without being touched individually.

### A second-order version of the same bug, found while fixing the first

`desktop/renderer/views/missions.js` gated one project's Start/Stop buttons on
`getHealth()` — "is the API reachable at all". Under the service that answers
`true` for the **whole machine** the instant any one project has a worker.
Left unfixed, the Missions tab would have shown *every idle project* as
running the moment the Core Service — now the normal state — was up, disabling
Start everywhere. Added `isProjectLive(project)`, which asks the worker
registry (service) or matches the heartbeat's own `project` field (standalone)
instead of asking the machine a yes/no question and applying the answer to
whichever project happens to be selected.

---

## 3. Two decisions with real consequences

**`startMission()` hands the project to the service rather than spawning a
rival.** The pre-M3 code refused outright whenever anything was live —
correct when one orchestrator could exist at all, and a regression against the
exact capability M1 built (the service supervises several projects at once).
It now checks `supervisor()`: `'daemon'` hands the project to
`DaemonClient.startMission()`; `'standalone'` still refuses, because a
standalone run genuinely does hold the whole machine.

**`stopMission()` requires a project under the service, and never calls
`/api/control/stop`.** That route asks the addressed process to shut down
entirely — under a standalone orchestrator that is one mission; under the
service it is *every* mission and the phone channel with it. `stopMission`
now routes to `/api/daemon/missions/stop` with an explicit project name, and
refuses an unqualified call under the service rather than guessing:

> *"The Core Service supervises several projects — say which mission to
> stop."*

`project` stays an optional second argument so the pre-M3 single-orchestrator
call shape (`stopMission(reason)`) still works standalone.

---

## 4. The Control Center

A new landing tab (`renderer/views/control.js`), and deliberately **not**
project-scoped — every other tab answers a question about one project chosen
from the header picker; this one answers the question an owner actually opens
the desktop with:

> Is the service up, what is it running, and what is waiting on me?

- **Service header.** Running / Stopped, uptime, worker count, whether
  Telegram inbound is live, whether it survives a reboot — resolved from Task
  Scheduler locally so the reboot answer is available *even while the service
  is down*, the same failure mode Bug 1 (M2.1) hid in for months.
- **Every project, one screen.** Reads `getRegistry()` — the identical records
  `/projects` renders on a phone, so a terminal, a phone and the desktop
  cannot drift on what "blocked" means (the drift Phase 11 M4 removed
  elsewhere). Each card carries a Start/Stop button that calls the same
  `startMission`/`stopMission` path.
- **Everything waiting, across every project.** `getAllApprovals()` — the
  desktop's `/approvals`.
- **Simulation disclosed at the picker and the card.** The last surface left
  from the v2.10.0/M2.2 disclosure work: the project `<select>` now shows
  `🧪 simulated`, and a fixture's card in the Control Center carries the same
  notice a phone gets. `listProjects()` computes it from live config, same
  rule as everywhere else — `isSimulatedProject`, not a stored flag.
- **Honest about its own limits.** With no service running, project cards
  come from local files and say so — *"the Core Service is not running — this
  list is read from local files and cannot show live missions"* — rather than
  rendering an empty machine.

---

## 5. Verification

| | |
| --- | --- |
| Backend tests | **972 passing** (+3 over M2.2's 969) |
| Desktop tests | **41 passing** (+21 over M2.2's 20 baseline) |
| Phase 12 Invariant | holds — standalone `start` takes the identical code path it always has |

New desktop coverage: `supervisor()` under every combination of service/
standalone/neither/both; `apiBase()` preferring the bound port;
`startMission`/`stopMission` routing to the service with the right body shape
and refusing an unqualified stop; `getRegistry()` live and degraded;
`getServiceStatus()` normalizing the worker list to a count and answering
autostart while stopped; `getAllApprovals()` merging per-project stores with
the right badge; `isProjectLive()` under all three supervision states.

Live-verified against the real running service (pid recorded in `state/
daemon.json`, v2.10.0 at the time): `supervisor()` → `'daemon'`,
`getRegistry()` → 6 real project records including the `🧪 SIMULATED`
`validation-sandbox`, `getServiceStatus()` → real pid/version/uptime/worker
count with autostart resolved, `isProjectLive('calculator-proof')` → `false`
(correctly — no worker running that project at the time of the check, rather
than the old code's `true` for everything).

---

## 6. Files

**New**
- `desktop/renderer/views/control.js`

**Changed**
- `desktop/main/orchestratorBridge.js` — `supervisor()`, daemon-aware
  `apiBase()`/`isLive()`, `startMission`/`stopMission` routing,
  `getRegistry()`, `getServiceStatus()`, `getAllApprovals()`,
  `isProjectLive()`, `listProjects()` simulation flag
- `desktop/main/main.js`, `desktop/main/preload.js` — new IPC channels
- `desktop/renderer/app.js` — Control Center as the landing tab; header badge
  asks the service first; project picker discloses simulation
- `desktop/renderer/views/missions.js` — per-project liveness instead of
  machine-wide health; explicit project on stop
- `desktop/renderer/index.html` — new nav entry and view panel
- `desktop/test/orchestratorBridge.test.js` — 21 new tests
