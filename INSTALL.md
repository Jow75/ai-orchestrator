# Installation

## Requirements

| Component | Version | Check |
| --- | --- | --- |
| Node.js | ≥ 18 (v26 recommended) | `node --version` |
| Claude Code CLI | any recent | `claude --version` |
| Windows | 10/11 for Task Scheduler integration | — |

The supervision core is cross-platform; only the auto-start scripts and
child-process scanning use Windows-specific tooling (with POSIX fallbacks).

## Install

```bat
cd C:\Users\Admin\Music\AI-Orchestrator
npm install
node bin\ai-orchestrator.js doctor
```

`doctor` verifies Node, configuration, project definitions, engine
installation, and write permissions — fix anything it flags before starting.

Optionally make the CLI available everywhere:

```bat
npm link
:: now "ai-orchestrator <command>" works from any directory
```

## Define your first project

```bat
node bin\ai-orchestrator.js projects add my-project ^
    --dir "C:\path\to\your\project" --prompt prompt.md
```

Then write the mission prompt at `C:\path\to\your\project\prompt.md`. Two
things every mission prompt should include:

1. The work itself (what to build/fix/finish).
2. The completion contract: *"When — and only when — the entire mission is
   finished, output the exact text `MISSION COMPLETE`."*

See `examples/demo-project/prompt.md` for a template and
[CONFIGURATION.md](CONFIGURATION.md) for permission settings needed for
fully unattended operation.

## Start

```bat
node bin\ai-orchestrator.js start my-project
:: or double-click START_AI.bat
```

## Auto-start after reboot (recommended)

Install the Task Scheduler task so interrupted missions continue
automatically after any reboot or power failure:

```bat
node bin\ai-orchestrator.js scheduler install
node bin\ai-orchestrator.js scheduler status
```

What it does: registers **"AI-Orchestrator Auto-Resume"**, which runs
`ai-orchestrator resume` 30 seconds after you log on. `resume` is a no-op
when nothing was interrupted, so the task is always safe. Remove it any time
with `scheduler uninstall`.

> To resume without logging in, Windows must be set to log on
> automatically, or convert the task to run whether the user is logged on or
> not (`taskschd.msc` → task properties → security options; requires storing
> credentials).

## Verify the pipeline without spending tokens

The mock driver exercises the entire supervision pipeline (launch, limit
wait, resume, completion, status.json, notifications) with a fake engine —
see the `mock` section in [CONFIGURATION.md](CONFIGURATION.md).

## Update

```bat
git pull
npm install
npm test
```

Runtime state (`state/`, `logs/`, `status.json`) is untouched by updates and
is safe to delete whenever no mission is active.

## Uninstall

```bat
node bin\ai-orchestrator.js scheduler uninstall
:: then simply delete the AI-Orchestrator folder
```
