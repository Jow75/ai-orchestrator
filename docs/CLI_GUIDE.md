# CLI Guide — every command, grouped by what you're trying to do

All commands: `node bin\ai-orchestrator.js <command>` (or plain
`ai-orchestrator <command>` after `npm link`). `--help` works everywhere.

## First run

| Command | What it does |
| --- | --- |
| `init` | Guided first-run setup: probes Node/`claude`, offers to create a project, connect your phone (Telegram/email), install the auto-resume task, and start a mission — see [DAY_ONE.md](DAY_ONE.md) |

## Run missions

| Command | What it does |
| --- | --- |
| `start <project>` | Start, or resume if interrupted. THE main command |
| `start <a> <b> [<c>]` | Several missions in parallel, one process (Phase 10H) |
| `start <project> --fresh` | Abandon the interrupted session, start over |
| `start <project> --worker` | Run as a supervised worker of the Core Service. The service passes this; you rarely type it |
| `resume [project]` | Resume ONLY if something was interrupted (safe no-op otherwise; what the boot task runs) |
| `stop [project]` | Graceful stop; session stays resumable. With the Core Service running, stops that mission (or all of them); without it, stops the standalone orchestrator |

## The Core Service (Phase 12 M1)

The always-on process. It owns the API, remote approvals, the scheduler, and
mission workers — and stays alive with **no missions running**, which is what
lets you check status or approve from your phone at any time. Without it,
everything below still works exactly as before; `serve` is additive.

| Command | What it does |
| --- | --- |
| `serve` | Run the Core Service in this terminal (Ctrl+C stops it; missions keep running) |
| `serve --stop-missions-on-exit` | Stop supervised missions when the service stops, instead of leaving them for the next service to adopt |
| `daemon status` | Is it running, what is it supervising, what is waiting on you |
| `daemon start <project>` | Start a mission through the service — **runs alongside other projects** |
| `daemon stop` | Stop the service gracefully (missions keep running) |
| `daemon stop --stop-missions` | Stop every mission first, then the service |
| `daemon install` | Start the service automatically when you log in to Windows |
| `daemon uninstall` | Stop starting it automatically |

Notes worth knowing:

- **Several projects at once.** `daemon start a` then `daemon start b` runs
  both independently. (Plain `start a b` is still the Phase 10H single-process
  form; the service supervises each as its own process instead.)
- **Missions outlive the service.** Stopping, upgrading, or crashing the
  service leaves running missions alone; the next `serve` re-adopts them.
- **The service and a standalone `start` never run together.** Each refuses
  while the other supervises the same project, with a message saying which
  command to use.
- `daemon install` is separate from `scheduler install` (auto-resume). They
  answer different questions; install either, both, or neither.

## The operator console (Phase 12 M2)

With the service running, the same console your phone talks to is available
from a terminal.

| Command | What it does |
| --- | --- |
| `operator "<message>"` | Run one operator command — exactly what you would type on your phone |
| `events` | Recent events from the durable log (`--project`, `--limit`, `--type`) |
| `projects status [project]` | The full registry: status, worker, branch, latest commit, health |

```console
$ ai-orchestrator operator "/projects"
Projects (2)

▸ ⏸️ Remote Work
   Waiting for you · 1/2 tasks · main · healthy
• 💤 Calculator
   Idle · master · healthy

Active: Remote Work

$ ai-orchestrator operator "Add CSV export to the payroll page."
📋 Mission M4 — Remote Work
…
Reply: APPROVE M4 · REJECT M4 [why]
```

`operator "/help"` lists the whole grammar; it is generated from the parser, so
it can never drift from what is actually accepted.

Notes worth knowing:

- **Typing never starts work.** A sentence raises a proposal (`M4`). Approving
  it starts a planning run, which comes back with a real plan for a second
  approval before any code is written.
- **Destructive commands ask first.** `/stop`, `/reset`, and `/shutdown` return
  a short code; only `/confirm <code>` performs the action. Codes are per
  channel, single-use, and expire — a code issued to your phone is not
  redeemable from the CLI.
- **`events` and `projects status` work with the service stopped.** They read
  the log and the state files directly, because a diagnostic surface that only
  works when everything is working is not a diagnostic surface.
- **Git Bash users:** it rewrites a leading `/` into a Windows path, so
  `operator "/projects"` arrives mangled. Use PowerShell, or drop the slash —
  `operator "projects"` works in any shell, as does `operator "status alpha"`.

## See what's happening

| Command | What it shows |
| --- | --- |
| `status` | Live snapshot: state, project, task, PID, counters, waits |
| `sessions [project]` | Active sessions / one project's history |
| `timeline <project>` | The mission's story (key events) |
| `lifecycle <project>` | Phase 10 mission state machine + transitions |
| `coordination <project>` | Locks held, ready tasks, dependency stalls, agent messages |
| `intel <project>` | Health score, next work item, recommendations |
| `improve [project]` | Patterns mined from history (recurring failures, slow agents…) |

## Manage the plan (mission mode)

| Command | Notes |
| --- | --- |
| `tasks list <project>` | Task states + attempts |
| `tasks add <project> --id T3 --prompt file.md [--objective ...] [--verify-file v.json] [--max-runs N]` | Append a task at runtime — no JSON editing |
| `tasks remove <project> <id>` / `tasks reorder <project> <id> up\|down` | PENDING (never-launched) tasks only |
| `tasks approve <project> <id>` | Blocked/failed current task → clean retry on next start |
| `tasks skip <project> <id> [--reason ...]` | Blocked/failed current task → mark done, move on |

## Approvals & remote control (Phase 10)

| Command | Notes |
| --- | --- |
| `approvals list [project]` | Pending everywhere, or one project's audit history |
| `approvals approve\|reject\|modify\|done <id> [note]` | Decide request `A7` from any terminal |
| `approvals mode [project]` / `--set <mode>` | conservative / balanced / autonomous |

## Schedules (Phase 10G)

| Command | Notes |
| --- | --- |
| `schedules list` | With last-run + next-due |
| `schedules add <project> --id X --type daily --time 02:00` | Also `weekly` (`--day`), `once` (`--date`), `cron` (`--cron "0 * * * *"`); `--fresh`, `--no-recover-missed` |
| `schedules remove\|enable\|disable <id>` | |
| `schedules run-due` | Fire everything due now (for your own automation) |
| `schedules watch` | Foreground watcher loop (pair with `scheduler install`) |

## Notifications

| Command | Notes |
| --- | --- |
| `notify test` | Send a test message through every enabled channel (✔/✘ per channel) |
| `notify setup telegram\|email` | Guided setup: validate credentials, send a live test, save to `config/local.json` (Phase 11 M1) |
| `notify tune` | Interactively set a channel's minimum severity (`info`/`warning`/`critical`) so it only buzzes on what matters (Phase 11 M4) |
| `notify resend <project> <id>` | Force-resend a pending approval notification, bypassing dedup |

## Projects, agents, memory, releases

| Command | Notes |
| --- | --- |
| `projects list` / `projects add <name> --dir <path> --prompt <file> [--driver id]` | Writes `claude.permissionMode: "acceptEdits"` automatically |
| `projects add --interactive` | Guided project creation — prompts for directory, prompt file, engine, permission mode; same file shape as the flags above (Phase 11 M1) |
| `drivers` | claude / cli / mock |
| `agents list\|health [project]` | Roster + per-agent install/performance |
| `agents message <project> --from a --to b --text "..."` | Cross-agent note, lands in next briefing |
| `memory list <project>` | Notes, failures, task history |
| `memory add <project> --note "..." [--category architecture]` | Durable fact for every future briefing |
| `memory resolve <project> <id>` | Failure fixed — stop surfacing it |
| `release prepare <project> <version>` | Draft notes + verification report from mission data |
| `release apply <project> <version>` | Version bump + CHANGELOG + git commit/tag (approval-aware; never pushes) |

## Environment & recovery

| Command | Notes |
| --- | --- |
| `doctor` | Full environment/config/engine diagnosis — first stop for any problem |
| `doctor --fix` | Explains and, on confirmation, repairs what it found — safe direct fixes apply themselves; anything needing real input (a token, a project) launches the matching wizard (Phase 11 M3) |
| `scheduler install\|uninstall\|status` | Windows auto-resume-at-logon task |
| `api-token [--rotate]` | Token for the API's mutating endpoints |

## Exit-code conventions

Commands exit non-zero on error, so all of this is scriptable. The HTTP
API mirrors nearly every read and mutation — see API.md.
