# AI-Orchestrator

**An autonomous supervisor for AI coding agents.**

AI-Orchestrator launches an AI coding agent (Claude Code today; more engines
via drivers), watches over it while it works — for hours, days, or weeks —
and handles everything that would normally require a human at the keyboard:

- 🔋 **Usage limits** — detects when the agent hits its usage limit, computes
  the reset time, waits, and **resumes the exact same conversation**. No
  progress lost, no restarts from scratch.
- 💥 **Crashes** — classifies unexpected exits, restarts with exponential
  backoff, and gives up gracefully (session preserved) instead of thrashing.
- 🔌 **Reboots & power loss** — a heartbeat file plus a Windows Task
  Scheduler task means a mid-mission reboot turns into "the mission simply
  continues at next logon".
- 🧘 **Patience** — the prime directive: **while the agent process is alive,
  the orchestrator does nothing.** Six silent hours waiting on a training
  run is healthy work, not failure. Recovery logic only ever runs after the
  process has actually exited.
- 🛑 **Loop prevention** — measures real progress after every run (files
  created/modified, git commits) and **stops with a diagnostic report** if
  the agent spins without accomplishing anything or reports it is blocked
  (e.g. a permission it lacks). No more overnight quota burn on a stuck
  mission.
- 🧩 **Multi-task missions** — a project can define an ordered plan of
  **tasks** instead of one prompt, each with its own objective and
  **verification** (file/command/output/JSON-schema/lint/dependency
  checks) — a task is done when its checks pass, never merely because the
  agent said so. Usage limits and crashes mid-task resume that exact
  task, not the mission from scratch.
- 📋 **Runtime prompt queue** — build up or adjust that task plan on the
  fly with `tasks add/remove/reorder`, no JSON editing required. Queue a
  follow-up task after a mission finishes and it runs on the next `start`.
- 🧠 **Intelligent resumes** — every resume or retry gets a generated
  briefing instead of a bare "Continue.": completed tasks, remaining
  tasks, and — on a verification-failed retry — **exactly which check
  failed and why**, so the agent never wastes a turn rediscovering what
  the orchestrator already knows.
- 🗂️ **Long-term memory** — record durable facts (`memory add`) that
  every future resume/retry briefing includes; blocked/failed outcomes
  are auto-cataloged and stay visible until you mark them resolved; a
  task's history survives even a plan edit that would otherwise erase it.
- 🖥️ **Desktop operator app** — an Electron console (`desktop/`) for
  everything above: live dashboard, mission start/stop/resume, a visual
  task queue, mission timeline, memory center, logs, and settings. A pure
  client of the same HTTP API/library the CLI uses — see
  [desktop/README.md](desktop/README.md).
- 🤝 **Multi-agent teams** (Phase 9) — define specialized agents (coding,
  testing, docs, research, review) in `config/agents.json` and each task
  routes to the best-fit agent; a generic `cli` driver plugs in Gemini,
  Codex, OpenCode, or a local LLM by config alone. Per-agent health and
  performance are tracked (`agents list`/`agents health`, the Agents view).
  **No agents configured = one implicit agent = exactly the old behavior.**

## Quick start

New here? One guided command sets up a project and your phone without
editing any JSON — see **[docs/DAY_ONE.md](docs/DAY_ONE.md)**:

```bat
npm install
node bin\ai-orchestrator.js init
```

Or do it by hand:

```bat
:: 1. Install dependencies (once)
npm install

:: 2. Define a project (guided; or use --dir/--prompt non-interactively)
node bin\ai-orchestrator.js projects add --interactive

:: 3. Check your environment
node bin\ai-orchestrator.js doctor

:: 4. Start supervising
node bin\ai-orchestrator.js start my-project
```

Or just double-click **START_AI.bat**.

While it runs, `status.json` (and `ai-orchestrator status`) always shows what
is happening — current task, agent PID, child processes, counters for
runs/resumes/crashes/rate-limits, and the estimated wait when a usage limit
is being slept out.

```text
ai-orchestrator status

  State:        supervising
  Project:      my-project
  Uptime:       17h 42m
  Agent PID:    18324 (children: 22610)
  Current task: Using tool: Bash
  Counters:     runs 6 · resumes 5 · crashes 0 · rate limits 4
  Waiting:      usage limit — resuming at 2026-07-05T03:00:00 (~2h 14m)
```

## How it works

```text
launch agent ──► agent works (orchestrator only observes)
                      │
                      ▼ agent process exits
              classify WHY it exited
                      │
    ┌─────────────────┼───────────────┬──────────────┬───────────────┐
    ▼                 ▼               ▼              ▼               ▼
mission          usage limit       crash         network        operator
complete         → wait until     → backoff      → short         stop
→ done             reset            restart        delay retry   → session
                 → resume         → give up                        preserved,
                   same session     after N                        resumes on
                                    (preserved)                    next start
```

The mission is defined by a prompt file. The agent signals completion by
printing a **completion marker** (default `MISSION COMPLETE`) — until it
appears, every clean-but-unfinished exit is automatically continued with a
resume prompt against the same engine conversation.

For more structured work, define `tasks` instead of one prompt: an ordered
plan where each task has its own prompt and verification, and the "mission
complete" box above becomes "current task's checks pass → next task's own
prompt (same conversation) → … → mission complete." See
[CONFIGURATION.md](CONFIGURATION.md).

## Commands

| Command | Purpose |
| --- | --- |
| `init` | Guided first-run setup: project + phone, no JSON editing (see [docs/DAY_ONE.md](docs/DAY_ONE.md)) |
| `start [project] [--fresh]` | Start or resume supervising a project |
| `resume [project]` | Resume only if something was interrupted (used at boot) |
| `stop` | Gracefully stop the running orchestrator (session stays resumable) |
| `status` | Live status snapshot |
| `sessions [project] [--abandon]` | Active sessions / per-project history; `--abandon` clears a stale session |
| `notify test/setup/tune/resend` | Test channels, guided setup, tune per-channel severity, force a resend |
| `approvals list/approve/reject/modify/done` | Decide requests from any terminal (Phase 10) |
| `timeline <project>` | Key events over the mission's lifetime |
| `lifecycle <project>` | Standardized mission state machine + history (Phase 10) |
| `tasks list <project>` | Task queue for a multi-task mission |
| `tasks add/remove/reorder` | Build or adjust a project's task queue at runtime |
| `tasks approve/skip <project> <taskId>` | Retry or bypass a blocked/failed task |
| `memory list/add/resolve <project>` | Durable notes, failure catalog, task history |
| `agents list/health [project]` | Inspect the multi-agent roster and per-agent performance (Phase 9) |
| `schedules list/add/remove/watch` | Scheduled missions incl. missed-run recovery (Phase 10) |
| `api-token [--rotate]` | Show/rotate the dashboard API's mutating-endpoint token |
| `projects list` / `projects add [--interactive]` | Manage project definitions |
| `drivers` | List available AI engine drivers (`claude`, `cli`, `mock`) |
| `scheduler install/uninstall/status` | Windows auto-resume task |
| `doctor [--fix]` | Diagnose environment, config, and engine installation — `--fix` offers to repair what it finds |

See [docs/CLI_GUIDE.md](docs/CLI_GUIDE.md) for every command and flag.

## Multiple projects

Each project is one JSON file in `config/projects/` — working directory,
prompt file, engine settings. The orchestrator is fully reusable: point it at
a trading bot today and a website tomorrow without touching code. See
[CONFIGURATION.md](CONFIGURATION.md).

## Extending

- **New AI engines** (Codex, Gemini CLI, Aider, …): implement one driver
  interface — nothing else changes. See [ARCHITECTURE.md](ARCHITECTURE.md).
- **Plugins**: drop a JS module in `plugins/` to subscribe to orchestrator
  events or register drivers. See [API.md](API.md).
- **Notifications**: desktop toasts by default; webhook, Discord, and
  Telegram channels are config-only switches.
- **Dashboard**: a local HTTP API (`http://127.0.0.1:4711/api/status`) backs
  both scripts/curl and the desktop app (read-only endpoints always open;
  mutating endpoints behind `ai-orchestrator api-token`).
- **Desktop app**: `cd desktop && npm install && npm start` — see
  [desktop/README.md](desktop/README.md).

## Documentation

| File | Contents |
| --- | --- |
| [docs/DAY_ONE.md](docs/DAY_ONE.md) | The shortest path in: one guided command, project + phone, no JSON editing |
| [docs/QUICKSTART.md](docs/QUICKSTART.md) | The by-hand route, step by step — useful to understand or fine-tune each piece |
| [docs/CLI_GUIDE.md](docs/CLI_GUIDE.md) | Every command and flag, grouped by what you're trying to do |
| [docs/](docs/) | More guides: Telegram setup, email setup, remote approvals, desktop, FAQ |
| [INSTALL.md](INSTALL.md) | Installation, auto-start setup |
| [CONFIGURATION.md](CONFIGURATION.md) | Every setting, with defaults |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Modules, design rules, data flow |
| [API.md](API.md) | HTTP API, plugin API, driver interface, library usage |
| [desktop/README.md](desktop/README.md) | Desktop app architecture, setup, backend integration contract |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Diagnosing common problems |
| [ROADMAP.md](ROADMAP.md) | Planned features |
| [CHANGELOG.md](CHANGELOG.md) | Version history |

## Requirements

- Node.js ≥ 18 (developed on v26)
- Windows 10/11 for Task Scheduler integration (supervision core is
  cross-platform)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI on PATH
  for the `claude` driver

## Safety rules (non-negotiable)

1. Never interrupt a healthy agent process.
2. Never confuse silence with failure.
3. Only act after the process has exited, and only after classifying why.
4. Every decision is logged; every state transition is persisted atomically.
5. Giving up never abandons a mission — sessions are always preserved.

MIT licensed. Built to run for months.
