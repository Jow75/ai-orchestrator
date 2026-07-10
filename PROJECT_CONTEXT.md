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

**Last updated:** 2026-07-10, after completing Phase 9 (multi-agent
intelligence) — verified live with a two-agent mock mission (each task
routed to its role's agent, per-agent health tallied) and the desktop Agents
view — ahead of committing/tagging `v2.2.0`.

## Where things stand: P0–P7 (backend), Phase 8 (desktop), Phase 9 (multi-agent) all complete

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

**Test suite:** 334/334 passing (`node --test` at repo root: 291 pre-Phase-9
+ 39 new agent/cliDriver/p9 + 4 desktop-bridge agent tests). `cd desktop &&
npm test` (or `npm run test:desktop`) runs the desktop-bridge tests alone.

The user's master prompt (2026-07-07) laid out Phases 8/9/10 as the next
evolution: desktop app → multi-agent intelligence → autonomous project
management, explicitly "do not skip directly to advanced autonomy." Phases 8
and 9 are now complete; **Phase 10 (true autonomy) has not been started.**

## What Phase 9 shipped (see CHANGELOG.md for full detail)

- **`src/agents/`**: an agent layer on top of the existing driver system.
  `agentProfile.js` (roles + validation), `agentRegistry.js` (loads
  `config/agents.json` + a project's `agents` block; **implicit default
  agent = `project.driver` when none configured**), `agentRouter.js` (pure
  task→agent routing: `agent` id > `role` > `capabilities` > default),
  `agentHealth.js` (install status + per-agent performance at
  `state/agents/health.json`).
- **`src/drivers/cliDriver.js`** (id `cli`): one generic config-driven driver
  for any CLI engine (Gemini/Codex/OpenCode/local) — no class per engine.
- **Orchestrator**: resolves the driver **per task** from the routed agent
  (was one driver per project); agent switch mid-mission → fresh engine
  conversation; per-agent outcomes recorded; `agent:assigned` event;
  `status.json` gains `mission.currentAgent`/`currentAgentRole`.
- **Surfaces**: `agents list|health` CLI, `GET /api/agents[/health]`, desktop
  **Agents** view + role/agent shown & settable in the Tasks view.
- **THE INVARIANT (tested at unit + integration level)**: an agent-less
  project runs byte-for-byte as before Phase 9. Backend changes outside
  `src/agents/` were confined to per-task driver resolution in
  `orchestrator.js`, three optional task fields, one `status.json` field,
  `paths.js` (agentsFile/agentHealthFile), and version bumps.
- **Deliberately deferred** (honest scope): sequential execution only
  (concurrency = Phase 10); inter-agent comms = handoff via task queue + P5
  memory + P4 briefing; the Gemini/Codex/OpenCode/local `cli` presets are
  real config but unverified against those actual CLIs (not installed here).

## What Phase 8 shipped (see CHANGELOG.md for full detail)

- **`desktop/`**: a sibling Electron subproject — own `package.json`
  (Electron as the only new dependency), CommonJS main process, plain
  HTML/CSS/JS renderer (no framework/bundler). Root project untouched
  except two cosmetic version-string bumps (`src/cli/index.js`,
  `src/state/statusManager.js`) and this doc set.
- **`desktop/main/orchestratorBridge.js`**: the integration layer — HTTP
  dashboard API when an orchestrator is live, the same library classes the
  CLI's read-only commands use when idle (there's no HTTP server to reach
  then). Starting a mission spawns the real `bin/ai-orchestrator.js start
  <project>` as a detached child process; stopping prefers `POST
  /api/control/stop`, falling back to the CLI's own `stop.requested` file.
- Seven views: Dashboard, Missions, Tasks, Timeline, Memory Center, Logs,
  Settings.
- 14 new tests, plus a live Playwright-driven verification pass (not
  committed — a throwaway driver script) that: screenshotted every view
  error-free, ran a full start → stop → resume → complete mission cycle
  against the `mock` driver, and force-killed the spawned process
  mid-mission to verify genuine crash recovery (Timeline correctly logged
  "Recovered interrupted session (reboot-or-power-loss)").
- **A real bug found and fixed during the live pass** (not by unit tests):
  every tab originally rendered into one shared `#view-root`; a delayed
  self-refresh in `missions.js` (after Start/Stop) could fire after the
  user had already switched tabs and clobber whatever tab they'd moved to.
  Fixed with one persistent container div per tab (`.view-panel`).

## What's next (per the master prompt's own phase order)

1. **Phase 9 — Multi-agent intelligence system**: agent registry/profiles,
   role-based task assignment (planner/coding/testing/docs/research/review
   agents), engine-agnostic (Claude/Gemini/Codex/OpenCode/local LLMs)
   without redesigning the core. Not started.
2. **Phase 10 — Autonomous project management**: goal → plan → execute →
   monitor, scheduled/overnight missions, self-improvement from history,
   automated git workflow, more notification channels. Not started.
3. Smaller, non-owed items carried over from ROADMAP.md's bottom section:
   more engine drivers + a conformance test-kit, concurrent multi-project
   supervision, cross-machine status aggregation, a packaged desktop
   installer (`electron-builder`), a real per-session transcript file (see
   desktop's Logs-view limitation).

## Conventions worth continuing if more work resumes here

- Version-snapshot-per-phase, each with its own git tag.
- Every phase: implementation → tests → full suite rerun (must stay green)
  → live smoke test (a real running process/app, not just unit tests) →
  docs → version bump → commit → tag.
- Never hide unfinished work or known limitations — state them plainly
  (see every phase's CHANGELOG entry and, for the desktop app,
  `desktop/README.md`'s "Known limitations").
- When something feels off, investigate and fix it in the same pass rather
  than deferring — this is how the Phase 8 tab-clobbering bug was caught
  (a live Playwright screenshot showing the wrong content under the right
  header), not by reading the code a second time.
- For a GUI phase specifically: unit tests cannot cover the renderer
  (no Chromium in `node --test`) — a live, driven smoke test (screenshots,
  real clicks, a real mission) is the acceptance gate, not optional polish.
