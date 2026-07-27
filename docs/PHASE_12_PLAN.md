# Phase 12 — Architectural Evolution: Core Service, Telegram Operator, Control Center & Launcher

**Status:** planning complete, M1 in progress
**Baseline:** `v2.7.0` (Phase 11 complete — the production baseline this phase must never regress)
**Author:** Phase 12 architecture pass, 2026-07-27

---

## 1. What this phase is

Phase 12 changes *what AI-Orchestrator is as a process*, not what it can do.

Today the product is **an executable that sometimes runs**. After Phase 12 it is
**a permanent service that clients connect to** — desktop, Telegram, CLI, and
any future web UI all become clients of one daemon.

This is the first phase since P7 to change the process model, so it carries the
highest regression risk of any phase so far. The governing constraint is
therefore stated before any design:

> **THE PHASE 12 INVARIANT.** With no daemon running and no daemon
> configuration present, every pre-Phase-12 command behaves byte-for-byte as it
> does in `v2.7.0`. `ai-orchestrator start <project>` continues to be a
> complete, self-sufficient orchestrator that owns its own heartbeat, its own
> API server, and its own Telegram polling. The daemon is an *additive*
> supervisor, never a required one.

This mirrors the Phase 10 invariant ("all four new collaborators are optional —
absent ⇒ byte-for-byte legacy behavior"), which has held for two phases and is
the single biggest reason this codebase has never had a compatibility break.

---

## 2. Evidence base

Every architectural claim below is cited to code in the `v2.7.0` baseline.
Nothing here is speculative; each item was verified by reading the current
implementation during the Phase 12 evidence pass.

### E1 — One orchestrator per machine, enforced by hard lock

`src/app.js:296-302` (single) and `src/app.js:412-417` (parallel) both call
`heartbeat.inspectPrevious()` and **throw** on `already-running`. The desktop
enforces the same rule client-side at
`desktop/main/orchestratorBridge.js:471-473`.

**Consequence:** starting Calculator while Remote Work is already running is
impossible. Phase 10H parallelism is *intra-process* (`start a b c`), decided
once at launch and immutable thereafter. The desired control center — four
projects, independently startable — cannot be built on this model. A supervisor
that owns missions as children is required.

### E2 — Nothing exists when no mission is running

- The dashboard API is constructed and started *inside* `App` and torn down in
  `App.shutdown()` (`src/app.js:197-219`, `:354`, `:549`). No mission ⇒ no
  HTTP server ⇒ the desktop falls back to direct file reads
  (`orchestratorBridge.js:130-135`).
- Telegram inbound polling happens **only** inside
  `ApprovalManager.waitForDecision()` → `pollProvidersOnce()`
  (`src/approvals/approvalManager.js:295`). No paused approval ⇒ no polling.
- The only always-on component is a Windows Scheduled Task registered by
  `scheduler install` (`src/cli/index.js:1557-1572`) — a periodic tick that
  launches a process, not a resident service.

**Consequence:** a Telegram message sent when no mission is running is read by
nobody. M2's operator console and M4's remote project creation are impossible
without a resident process. This is why the daemon is M1 and not M3.

### E3 — Telegram `getUpdates` offset is a single-owner resource

`TelegramApprovalProvider.fetchDecisions()`
(`src/approvals/providers/telegramProvider.js:90-116`) calls
`getUpdates?offset=N+1`, which **acknowledges and discards** all updates up to
`N`, then persists the new offset to `state/approvals/telegram.offset`
(`:74-87`).

**Consequence:** if a daemon polls continuously *and* a running mission's
`ApprovalManager` also polls, they consume each other's updates. An
`APPROVE A7` reply delivered to the daemon is discarded, and the mission that
was waiting for it waits forever. This is a real livelock, structurally
identical to the human-action livelock found live in Phase 10.5 — and it would
be introduced *by* the daemon if not designed out. Poll ownership must be
exclusive, by construction, not by convention.

### E4 — Cross-process decision delivery is already solved and proven

`waitForDecision()` (`src/approvals/approvalManager.js:272-301`) re-reads the
store from disk on every iteration and calls `emitResolved()` for decisions
written by *any* other process — the cross-process path Phase 10's live
validation specifically hardened (the "missing `approval:resolved` emission"
bug). `emittedResolutions` (`:48-59`) guarantees exactly-once announcement.

**Consequence — and this is the key design unlock:** the fix for E3 requires
**no new Telegram code and no new IPC**. The daemon owns inbound polling and
writes decisions to the file-backed `ApprovalStore`; workers simply stop
receiving, and pick decisions up through the store re-read they already
perform. Publishing (outbound `sendMessage`) is stateless and stays where it
is. The distinction is precise:

> **Outbound is safe to duplicate. Inbound is offset-stateful and must have
> exactly one owner.**

### E5 — Detached execution and the live/idle client pattern already exist

The desktop already spawns missions detached so they survive window closure
(`orchestratorBridge.js:470-497`), and already implements the
live-API-or-idle-files dual path throughout. Phase 12 does not invent the
"UI is a client" idea — it finishes it, by giving the client something that is
always there to talk to.

### E6 — Existing state is file-backed and atomic

Every subsystem persists through `writeJsonAtomic`/`readJsonSafe`
(`src/state/statePersistence.js`), and `resolvePaths()`
(`src/infra/paths.js:33-89`) is the single source of location truth.

**Consequence:** files remain the source of truth in the daemon design. IPC
between daemon and worker is an *optimization* for liveness and event latency,
never the system of record. A daemon crash therefore cannot lose mission state,
and a restarted daemon can re-adopt live workers by reading their records.

---

## 3. Target architecture

```
                    ┌──────────────────────────────────────┐
   Telegram  ───────►                                      │
   Desktop   ◄──────►   AI-Orchestrator Core Service       │
   CLI       ◄──────►   (daemon — one per machine)         │
   Web (future) ────►                                      │
                    │  owns:                               │
                    │   • HTTP API (:4711)                 │
                    │   • Telegram long-poll (EXCLUSIVE)   │
                    │   • scheduler tick                   │
                    │   • notification routing             │
                    │   • worker lifecycle                 │
                    │   • project registry                 │
                    └───────────────┬──────────────────────┘
                                    │ spawn + IPC (liveness/events)
                                    │ files (source of truth)
                    ┌───────────────┴──────────────────────┐
                    │                                      │
          ┌─────────▼─────────┐              ┌─────────────▼─────────┐
          │ Mission Worker    │              │ Mission Worker        │
          │ project: finisher │              │ project: calculator   │
          │ (App worker mode) │              │ (App worker mode)     │
          │  • no global HB   │              │  • no global HB       │
          │  • no API server  │              │  • no API server      │
          │  • no TG receive  │              │  • no TG receive      │
          │  • full P0–P11    │              │  • full P0–P11        │
          │    supervision    │              │    supervision        │
          └───────────────────┘              └───────────────────────┘
```

**Worker mode changes nothing about supervision.** A worker is the same `App`
running the same `Orchestrator` with the same P0–P11 guarantees. Worker mode
only withdraws the four *machine-singleton* responsibilities (global heartbeat,
API port, Telegram receive, stop-file watching) and hands them to the daemon.
That containment is what keeps regression risk survivable.

### Process identity and locking

| Resource | Owner today | Owner after M1 |
| --- | --- | --- |
| `state/heartbeat.json` | the single orchestrator | **unchanged** — standalone `start` only |
| `state/daemon.json` (new) | — | the daemon |
| `state/workers/<project>.json` (new) | — | one mission worker each |
| `state/approvals/telegram.offset` | whichever orchestrator polls | the daemon, exclusively (standalone `start` keeps it when no daemon runs) |
| API port `:4711` | the single orchestrator | the daemon (standalone `start` keeps it when no daemon runs) |

Mutual exclusion is enforced at the **project** level, in both directions:

- The daemon refuses to start a worker for a project that a standalone
  orchestrator is currently supervising (checked via `state/heartbeat.json`).
- Standalone `start <project>` refuses when a live daemon worker holds that
  project (checked via the worker registry).

Both checks are additive: with no daemon and no workers, both registries are
empty and every code path is identical to `v2.7.0`.

---

## 4. Milestones

| Milestone | Version | Theme |
| --- | --- | --- |
| **M1** | `v2.8.0` | **Core Service** — daemon, worker supervision, exclusive Telegram ownership, Windows autostart, reboot recovery |
| **M2** | `v2.9.0` | **Telegram Operator Interface** — command router, project context, executive Mission Cards |
| **M3** | `v3.0.0` | **Operator Control Center** — multi-project desktop as a pure daemon client |
| **M4** | `v3.1.0` | **Launch Experience & Remote Project Creation** — launcher, Start Menu, `/new` with mandatory plan approval |

Each ships independently: implementation → tests → full regression → live
validation → docs → version bump → commit → annotated tag → completion report.

---

## 5. M1 — Core Service (`v2.8.0`), detailed

### 5.1 New modules

| Module | Responsibility |
| --- | --- |
| `src/daemon/daemonRecord.js` | Read/write/inspect `state/daemon.json` (pid, port, version, startedAt). Same shape of contract as `heartbeat.js` — `inspectPrevious()` returns `clean` / `already-running` / `unclean-shutdown`. |
| `src/daemon/workerRegistry.js` | Per-project worker records under `state/workers/`. Liveness by PID probe, stale reaping, `holderOf(project)`. |
| `src/daemon/workerSupervisor.js` | Spawn / track / stop mission workers. Enforces per-project exclusion, the parallel cap, crash detection, and re-adoption of surviving workers after a daemon restart. |
| `src/daemon/daemon.js` | Composition root for the service: config, logger, API, exclusive Telegram poll loop, scheduler tick, worker supervision, signal handling, graceful shutdown. |
| `src/daemon/daemonClient.js` | The client library the CLI (and later desktop/Telegram) use: discover the daemon, authenticate with the existing API token, call it, or report cleanly that it is not running. |

### 5.2 Modified modules (all additive)

| Module | Change |
| --- | --- |
| `src/approvals/approvalManager.js` | New `receiveDecisions` option (default `true`). When `false`, `pollProvidersOnce()` returns `[]` immediately — the E3 fix. Publishing is untouched. |
| `src/app.js` | New `worker` mode: skip global heartbeat ownership, skip dashboard start, skip stop-file watch, construct `ApprovalManager` with `receiveDecisions: false`, write a worker record instead. Standalone path unchanged. |
| `src/api/dashboardServer.js` | New daemon routes, gated on an optional `daemon` collaborator (503 cleanly when absent — the established Phase 10 pattern). |
| `src/config/defaults.js` | New `daemon` config block (`enabled`, `pollIntervalMs`, `maxWorkers`, `autoStart`, `schedulerTickMs`). |
| `src/infra/paths.js` | `daemonFile`, `workersDir`. |
| `src/cli/index.js` | `serve`, `daemon status|stop|install|uninstall`; `start`/`stop`/`status` become daemon-aware. |

### 5.3 API surface added

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /api/daemon` | none | Daemon status: pid, uptime, version, worker count, host resources |
| `GET /api/daemon/workers` | none | Every tracked worker with project, pid, state, uptime |
| `POST /api/daemon/missions/start` | token | Start a mission worker for a project |
| `POST /api/daemon/missions/stop` | token | Stop one worker gracefully (resumable) |

Read routes stay unauthenticated (as every GET has since P0); mutations require
the existing P7 token. No new auth mechanism is introduced.

### 5.4 Behaviours to prove in live validation

1. Daemon starts with **zero** missions running and stays alive.
2. Desktop and CLI both see the daemon and reconnect to it.
3. Daemon starts two workers on two different projects **simultaneously** —
   the capability E1 makes impossible today.
4. A Telegram `APPROVE` reply, received by the **daemon**, resolves an approval
   that a **worker** is waiting on (the E3/E4 path, end to end, on the real bot).
5. Killing a worker is detected and recorded; the daemon survives.
6. Killing the **daemon** leaves workers running; a restarted daemon re-adopts
   them.
7. Windows autostart brings the daemon back after a real reboot.
8. With the daemon stopped and daemon config absent, `start`/`stop`/`status`
   behave exactly as in `v2.7.0` (the Phase 12 Invariant, tested explicitly).

### 5.5 Explicitly out of scope for M1

- Telegram command routing beyond existing approval replies (that is M2).
- Any desktop UI change (that is M3). The desktop keeps working through its
  existing live/idle bridge; M1 only adds the daemon it will later prefer.
- Running missions *inside* the daemon process. Missions are always child
  processes — a mission crash must never take down the service.
- Cross-machine operation. The daemon binds `127.0.0.1` like every other
  surface in this project.

---

## 6. Security posture (applies to all four milestones)

Unchanged in M1, and stated here because M2/M4 will test it:

- Telegram remains **chat-id restricted** (`telegramProvider.js:108`).
- M1 adds **no new inbound command grammar** — the daemon polls with the exact
  parser workers used (`parseDecisionText`), so the set of accepted messages is
  identical to `v2.7.0`.
- Mutating API routes keep requiring the P7 token; the daemon binds local-only.
- When M2/M4 widen the inbound grammar: no free text may implicitly start work
  or create a project, project creation is confined to approved roots, write
  operations stay behind owner approval, and destructive commands require
  explicit confirmation.

---

## 7. Risk register

| Risk | Mitigation |
| --- | --- |
| Daemon regresses standalone `start` | The Phase 12 Invariant is a *tested* requirement (§5.4.8), not a stated intention |
| Telegram poll race (E3) | Exclusive ownership by construction; worker receiving is disabled at the `ApprovalManager` level and unit-tested |
| Two processes supervising one project | Bidirectional project-level exclusion (§3), tested from both directions |
| Daemon crash loses mission state | Files remain the source of truth (E6); IPC is advisory; workers survive and are re-adopted |
| Orphaned workers after daemon death | Worker records carry PIDs; the supervisor reaps stale records and re-adopts live ones on boot |
| Windows service complexity | Reuse the proven `schtasks` approach already shipped for auto-resume rather than introducing a service wrapper dependency |
