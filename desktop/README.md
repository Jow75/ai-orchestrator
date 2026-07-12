# AI-Orchestrator Desktop (Phase 8)

An Electron operator console for AI-Orchestrator. This is a **pure client**
of the existing backend (`../src/`) — it never re-implements supervision,
verification, or progress logic. It only reads/mutates through the same
two integration surfaces the backend already exposes:

- the **dashboard HTTP API** (`src/api/dashboardServer.js`, documented in
  `../API.md`) whenever an orchestrator process is currently running, and
- the same **library classes the CLI uses** (`ConfigManager`, `TaskQueue`,
  `MemoryStore`, `MissionTimeline`, `SessionManager` — all exported from
  `../src/index.js`) whenever nothing is running and there is no HTTP
  server to reach.

See `main/orchestratorBridge.js` for the dispatch logic and the table below
for which path each feature uses.

Only one orchestrator process runs at a time, system-wide (gated by
`state/heartbeat.json`) — this app doesn't change that constraint, it just
makes it visible (the sidebar's Live/Idle badge, and a clear error if you
try to start a second mission while one is running). (Parallel MISSIONS
inside that one process are a Phase 10 CLI feature — `start a b`; the
desktop starts single missions.)

**Phase 10 additions**: an **Approvals** view (every pending approval
request across projects, decidable in one click — Approve / Modify… /
Reject, or "Done — I did it" for human-action requests) and a mission
**lifecycle strip** at the top of the Missions view (current state +
recent transitions, from `state/lifecycle/`). Both are dual-mode like
everything else: live → the Phase 10 API endpoints; idle → the same
`ApprovalStore`/`MissionLifecycle` library classes the CLI uses.

## Setup

```bash
cd desktop
npm install     # pulls Electron only — no other new dependencies
npm start       # launches the app (electron .)
```

Requires the root project's dependencies to already be installed
(`npm install` at the repo root) — the bridge imports backend modules
directly from `../src/`.

## Architecture

```
main/
  main.js                BrowserWindow + IPC route table (thin — every
                          handler delegates straight to the bridge/logTail)
  preload.js              contextBridge — the ONLY surface the renderer gets
                          (contextIsolation on, nodeIntegration off, sandboxed)
  orchestratorBridge.js    dual-mode dispatch: live HTTP API vs. idle library
  logTail.js               tails logs/*.log for the Logs view
renderer/
  index.html, styles.css, app.js   tab router; one persistent container div
                                    per tab (see "a bug worth knowing about")
  views/*.js               one file per tab, plain functions on
                            window.Views.<tab> = { mount(root, ctx), tick? }
```

No frontend framework, no bundler — Electron loads the static files
directly, matching the backend's dependency-light style. IPC channels are
listed in `preload.js`; every one maps 1:1 to an `OrchestratorBridge` method.

### Backend integration contract

| View | Idle (nothing running) | Live (orchestrator running) |
| --- | --- | --- |
| Dashboard | `ConfigManager.listProjects()` + `SessionManager` | `GET /api/status`, `/api/health` |
| Missions | spawns `bin/ai-orchestrator.js start <project>`; `ConfigManager.saveProject()` to create | `POST /api/control/stop` |
| Tasks | `TaskQueue` methods directly | `/api/tasks/:project/*` (token-gated mutations) |
| Agents (P9) | `AgentRegistry`/`AgentHealth` directly | `GET /api/agents[/health]` |
| Timeline | `MissionTimeline.read()` | `GET /api/timeline/:project` |
| Memory | `MemoryStore` methods directly | `/api/memory/:project` + mutations (token-gated) |
| Logs | tails `logs/*.log` | same — log files, not the live process |
| Settings | `loadOrCreateToken()`, `configManager.getPaths()` | same |

The **Agents** view (Phase 9) shows the multi-agent roster — per-agent role,
engine install status, capabilities, and task performance — with the agent
handling the current task highlighted. The Tasks view shows each task's
routed agent/role and its Add-task form offers role + agent selectors.

Starting a mission spawns the real `bin/ai-orchestrator.js start <project>`
CLI entry point as a detached child process (using Electron's bundled Node
via `ELECTRON_RUN_AS_NODE`, so no system Node install is required) — exactly
what a human typing the command would do. It survives the desktop window
closing (overnight missions), and stdio is deliberately **not** piped: a
detached process with nothing draining its stdio pipe can have its writes
block once the OS pipe buffer fills, which would stall the orchestrator
itself. Stopping prefers `POST /api/control/stop`; if that's unreachable it
falls back to writing the same `stop.requested` file the CLI's `stop`
command writes.

## Known limitations (real, not hidden)

- **Logs Viewer shows system/lifecycle events, not the agent's raw
  conversation.** Confirmed against `src/drivers/claudeDriver.js` and
  `src/core/processSupervisor.js`: only lifecycle events go to the winston
  log files, never output chunks. A full transcript would need a small
  backend addition (a per-session transcript file) — worth doing later,
  not built here.
- **Settings is view-and-create, not a full editor.** Project locations and
  notification config are shown read-only with an "Open" button to the
  actual JSON file; creating a new (legacy single-prompt) project is fully
  in-app, but editing an existing project's fields, or every notification
  channel (webhook/discord/telegram/email), is not — deliberately, to keep
  v1 scoped to the read/monitor/control surface the master prompt cared
  about most.
- **No packaged installer yet.** `npm start` runs the app in dev mode.
  Packaging via `electron-builder` is a reasonable fast-follow, not done here.
- **Task "verify" rules** are entered as raw JSON (mirrors `tasks add
  --verify-file`), not a visual condition builder.

## A bug worth knowing about (fixed, but instructive)

Early versions of `app.js` rendered every tab into one shared `#view-root`
element. `missions.js` schedules a `setTimeout(() => render(...), 800)`
after Start/Stop to refresh its own "is it live yet" state — but if the
user switched to a different tab before that timeout fired, it would
overwrite whatever tab was now showing with stale Missions HTML (confirmed
live via a Playwright-driven screenshot: the header said "Dashboard" while
the body showed the Missions form). Fixed by giving each tab its own
persistent container div (`index.html`'s `.view-panel[data-view=...]`);
a late callback from a tab you've left now only ever writes into that tab's
own (hidden) container, never the one you're looking at.

## Manual smoke test

Automated coverage (`node --test` in this directory) only exercises
`orchestratorBridge.js` — it never loads Electron/Chromium. The following
was run against a real Electron window (via a throwaway Playwright
`_electron` driver script) before calling Phase 8 done, and should be
re-run after any change that touches mission lifecycle or IPC:

1. Launch (`npm start`); every tab renders without a console error.
2. Create a project (Missions → Create a new project) or point at an
   existing one; Dashboard's project grid shows it.
3. Start a mission; Dashboard reflects live state (pid, session, activity)
   within a couple of poll cycles; Timeline records "Mission started".
4. Stop mid-mission; Dashboard/Missions show idle again; the session stays
   resumable (`ai-orchestrator sessions <project>` or the Timeline still
   shows the session as unfinished).
5. Start again; the SAME session resumes (run/resume counters continue,
   not reset) through to "Mission complete".
6. Crash recovery: while a mission is running, kill the spawned process
   directly (not via the app's Stop button) to simulate a real crash; start
   the mission again from the app — Timeline should record "Recovered
   interrupted session (reboot-or-power-loss)", not a duplicate/broken run.
7. Restart the whole desktop app while idle and while a mission is live;
   the Live/Idle badge and Dashboard should reflect reality immediately in
   both cases (no stale "live" reading once the process is actually gone).
8. Multiple projects: defining a second project and trying to start it
   while another is live should surface "already running", not crash the
   app or the mutation.

All eight passed as of this writing, including a real crash-recovery run
(force-killed the spawned process mid-mission; the next Start correctly
logged "Recovered interrupted session (reboot-or-power-loss)" and completed
the mission).
