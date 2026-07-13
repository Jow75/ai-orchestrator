# CLI Guide — every command, grouped by what you're trying to do

All commands: `node bin\ai-orchestrator.js <command>` (or plain
`ai-orchestrator <command>` after `npm link`). `--help` works everywhere.

## Run missions

| Command | What it does |
| --- | --- |
| `start <project>` | Start, or resume if interrupted. THE main command |
| `start <a> <b> [<c>]` | Several missions in parallel, one process (Phase 10H) |
| `start <project> --fresh` | Abandon the interrupted session, start over |
| `resume [project]` | Resume ONLY if something was interrupted (safe no-op otherwise; what the boot task runs) |
| `stop` | Graceful stop; session stays resumable |

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

## Projects, agents, memory, releases

| Command | Notes |
| --- | --- |
| `projects list` / `projects add <name> --dir <path> --prompt <file> [--driver id]` | **After `add`, set `claude.permissionMode` in the JSON** — see QUICKSTART step 3 |
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
| `scheduler install\|uninstall\|status` | Windows auto-resume-at-logon task |
| `api-token [--rotate]` | Token for the API's mutating endpoints |

## Exit-code conventions

Commands exit non-zero on error, so all of this is scriptable. The HTTP
API mirrors nearly every read and mutation — see API.md.
