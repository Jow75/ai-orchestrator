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

## Quick start

```bat
:: 1. Install dependencies (once)
npm install

:: 2. Define a project (what the agent should work on)
node bin\ai-orchestrator.js projects add my-project ^
    --dir "C:\path\to\your\project" --prompt prompt.md

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

## Commands

| Command | Purpose |
| --- | --- |
| `start [project] [--fresh]` | Start or resume supervising a project |
| `resume [project]` | Resume only if something was interrupted (used at boot) |
| `stop` | Gracefully stop the running orchestrator (session stays resumable) |
| `status` | Live status snapshot |
| `sessions [project]` | Active sessions / per-project history |
| `projects list` / `projects add` | Manage project definitions |
| `drivers` | List available AI engine drivers |
| `scheduler install/uninstall/status` | Windows auto-resume task |
| `doctor` | Diagnose environment, config, and engine installation |

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
- **Dashboard**: a local read-only HTTP API (`http://127.0.0.1:4711/api/status`)
  is ready for a future web dashboard.

## Documentation

| File | Contents |
| --- | --- |
| [INSTALL.md](INSTALL.md) | Installation, auto-start setup |
| [CONFIGURATION.md](CONFIGURATION.md) | Every setting, with defaults |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Modules, design rules, data flow |
| [API.md](API.md) | HTTP API, plugin API, driver interface, library usage |
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
