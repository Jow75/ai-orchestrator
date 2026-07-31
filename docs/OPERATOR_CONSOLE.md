# The Operator Console

How to run your projects from your phone. Introduced in Phase 12 M2
(`v2.9.0`); this page is kept current with the full command surface, last
audited end-to-end in Phase 13 M8 (`v3.8.0`), which also grouped `/help`
itself into the same sections used below. `/import all` and `/safemode`
were added in the 2026-07-30 reconciliation pass (`v3.9.0`); `/mission` and
`/mission all` were added in Phase 14 M9 (`v3.10.0`); `/workspace` in Phase
14 M0 (`v3.11.0`); `/git`, `/git dirty`, and `/git clean` in Phase 14 M1
(`v3.12.0`); `/log` in Phase 14 M2 (`v3.13.0`) — which also freed the `log`
alias off `/events` (see the System section below), since the two commands
read genuinely different things and the name was needed for the real one;
`/notify` and `/approvals mode` were added in Phase 14 M8 (`v3.14.0`).

This is the guide to *operating* AI-Orchestrator remotely. For deciding
individual approvals, see [REMOTE_APPROVALS.md](REMOTE_APPROVALS.md); for
connecting a channel in the first place, see
[TELEGRAM_SETUP.md](TELEGRAM_SETUP.md).

---

## What changed

Before Phase 12 M2, your phone could answer one question: *do you approve
`A7`?* Now it can ask its own:

```text
/projects              what have I got, and what needs me?
/project Remote Work   work on this one until I say otherwise
/status                where is it, what branch, is it healthy?
Add CSV export to the payroll page.
                       ↳ a proposal you approve, which becomes a real mission
```

The Core Service (`ai-orchestrator serve`) is what makes this possible — it is
always there, so a message sent at 2am is read. Without it, nothing below
exists and the system behaves exactly as it did in `v2.7.0`.

---

## Getting there

1. Connect Telegram once, on the machine: `ai-orchestrator notify setup
   telegram` (or `ai-orchestrator init` for the full first-run wizard).
2. Start the service: `ai-orchestrator serve`. To have it come back after a
   reboot: `ai-orchestrator daemon install`.
3. Check it can hear you: `ai-orchestrator daemon status` should show

   ```text
   Operator interface
     Commands:   enabled
     Channels:   telegram
   ```

4. Message your bot: `/help`.

Only the chat id you configured is honoured. A stranger messaging the bot
reaches nothing — the restriction is applied before any parsing, so no command
added later can accidentally become reachable.

---

## The commands

35 commands today, grouped exactly the way `/help` groups them (Phase 13 M8)
— both read from the one `COMMANDS` array in `src/operator/commandGrammar.js`,
so this table and the bot's own `/help` cannot drift apart.

### General

| Command | What it does |
| --- | --- |
| `/help` | Every command, grouped, generated from the parser itself |
| `/whoami` | Which project this conversation is pointed at |

### Projects

Browsing and selecting what you already have.

| Command | What it does |
| --- | --- |
| `/projects [all\|classify]` | Every project: status, tasks, branch, health. `all` includes hidden; `classify` proposes classifications |
| `/project <name>` | Select the active project. Remembered until you change it |
| `/status [project]` | Phase, tasks, worker, branch, commit, last activity, health |
| `/workspace` | Portfolio rollup: mission-ready count, status breakdown, git clean/dirty, recently active, needs attention |
| `/git [project\|dirty\|clean]` | Branch, dirty/clean state, HEAD, recent commits, ahead/behind for one project; "dirty"/"clean" list every registered project in that state |

### Missions

Starting, watching, and stopping work.

| Command | What it does |
| --- | --- |
| `/start [project]` | Start supervising |
| `/stop [project]` ⚠️ | Stop a mission (the session stays resumable) |
| `/tasks [project]` | The real task queue and where it is |
| `/reset [project]` ⚠️ | Abandon an interrupted session so the next start is fresh |

### Decisions

What is waiting on you.

| Command | What it does |
| --- | --- |
| `/approvals [mode [mode]]` | Every decision waiting on you, across all projects. `mode` shows or sets the global approval mode (Phase 14 M8) |
| `/missions` | Mission requests you raised and have not answered |
| `/confirm <code>` · `/cancel [code]` | Answer a ⚠️ prompt |

### System

| Command | What it does |
| --- | --- |
| `/service` | Running / Starting / Stopped — and whether it survives a reboot |
| `/events [n]` | What the system actually did — the structured internal event log |
| `/log [project] [page]` | Tail the real orchestrator log file for a project — raw text, not the structured event log `/events` reads |
| `/shutdown` ⚠️ | Stop the Core Service itself |

### Registry

Which projects AI-Orchestrator knows about (`/scan`, `/import` — Phase 13
M2; `/archive`, `/restore`, `/hide`, `/unhide`, `/forget` — M3; `/roots` —
M4; `/import all` — reconciliation pass, 2026-07-30).

| Command | What it does |
| --- | --- |
| `/scan` | Find real, unregistered projects under your configured roots |
| `/import <path> [as <name>]` | Register a folder `/scan` found (registry only — never touches its files) |
| `/import all` | Register every current `/scan` candidate in one batch, after one confirmation |
| `/mission [project]` | Auto-detect a project's language/framework/build-test commands from files on disk and write it a starter `promptFile` (Phase 14 M9). Never overwrites an existing mission |
| `/mission all` | Do the above for every registered project still missing a mission, in one confirmed batch |
| `/archive [project]` | Demote a project's priority. Never deletes it |
| `/restore [project]` | Return an archived or hidden project to "development" |
| `/hide [project]` · `/unhide [project]` | Keep a project out of `/projects` without archiving or removing it |
| `/forget [project]` ⚠️ | Remove a project from the registry. Files on disk are NEVER touched |
| `/roots [add\|remove <path>]` | List, add, or remove a project root — where `/scan` looks |

### Configuration

The machine-wide default provider/model (Phase 13 M5), the global Safe Mode
override (reconciliation pass, 2026-07-30), and notification
channels/severity plus approval mode (Phase 14 M8) — the last of the
settings that used to require editing `config/local.json` by hand.

| Command | What it does |
| --- | --- |
| `/provider` | Current default provider/model, known drivers, and capabilities |
| `/model [name\|default]` | Show or set the default model. Never interrupts an active mission |
| `/safemode [on\|off]` | Global override: while on, every project runs headless-read-only regardless of its own `permissionMode`. Never interrupts an active mission |
| `/notify [status]` | Which notification channels (Telegram/email/Discord/webhook) are enabled, and the minimum severity |
| `/notify <channel> on\|off` | Enable or disable one channel: `telegram`, `email`, `discord`, or `webhook`. Credentials still live only in `config/local.json` |
| `/notify severity <info\|warning\|critical>` | Set the global minimum severity a notification must have to send at all |

### Files

Read-only remote inspection (Phase 13 M6).

| Command | What it does |
| --- | --- |
| `/files [path]` | List a directory inside the active project (default: its root) |
| `/file <path>` | Read one file — inline if small, as an attachment if not |
| `/download-project [project]` | ZIP the active (or named) project — source only, never `node_modules`/`.git`/build output |

Plus the decision grammar, unchanged since Phase 10:
`APPROVE A7` · `REJECT A7 [why]` · `MODIFY A7 <changes>` · `DONE A7`.

Aliases exist where they are natural — `/ls`, `/use`, `/cd`, `/queue`,
`/activity`, `/logs`, `/yes`, `/no`, `/rescan`, `/dir`, `/cat`, `/zip`. The leading `/` is optional
for a bare command (`projects`, `status calculator`), and prose that merely
*starts* with a command word ("status update: the importer is done…") is
treated as prose, not a command.

A few less-obvious ones in practice:

```text
/import C:\Users\Admin\Music\new-project as "New Project"
/import all
/roots add D:\Development
/model claude-sonnet-5           (or: /model default)
/safemode on                     (or: /safemode off)
/notify telegram off             (or: /notify telegram on)
/notify severity warning
/approvals mode autonomous
/download-project Remote Work
```

---

## Asking for work

Type what you want. It never starts anything:

```text
You:  Build a payroll dashboard with CSV export.

Bot:  📋 Mission M4 — Remote Work

      Build a payroll dashboard with CSV export.

      Before anything runs:
        Branch: main
        Path: C:/Users/Admin/Music/remote-work
        Already queued: 2 task(s)

      This project's recent history (not a prediction):
        Missions measured: 12
        Average run: 40m 0s
        Verifier pass rate: 96%

      If you approve, a planning run starts. It will come back with a
      real plan — tasks, files, duration, risks — for a second approval
      before any code is written.

      Reply: APPROVE M4 · REJECT M4 [why]
```

### Why there are two gates

**Gate 1 (`M4`) — do you want this at all?** Everything shown here is knowable
before any AI runs: the objective as you typed it, the project's branch and
path, what is already queued, and this project's own measured history. There is
deliberately **no estimate of how big *this* request is**, because nothing has
looked at the code yet, and a number produced at this point would be a
fabrication wearing a number's clothes.

**Gate 2 (`A9`) — do you accept *this* plan?** Approving `M4` starts a real
supervised mission whose first job is to plan. When it does, Phase 10's
implementation-review flow publishes the agent's own plan to you: objective,
tasks, files, estimated duration, estimated files changed, risks. *Those* are
the estimates — extracted from a plan written by something that read the
codebase.

```text
"Build a payroll dashboard."
      │
      ▼  APPROVE M4      gate 1: do you want this?
prompt file + queued task + supervised worker
      │
      ▼  APPROVE A9      gate 2: do you accept this plan?
implementation → verification → commit → Mission Card
```

### When a mission cannot start

Two situations are refused rather than silently swallowed, because in both the
work would be lost:

- **The project already has a mission running.** A live worker holds its task
  queue in memory and rewrites it, so anything appended from outside is
  overwritten. Wait, or `/stop` it first.
- **The current task is `blocked` or `failed`.** The next start cannot adopt
  the queue and reseeds it from static config, discarding the new task. The
  reply tells you the exact command to clear it (`tasks approve` or
  `tasks skip`).

Your approval is not wasted in the first case — the request stays approved, so
you do not have to decide twice.

---

## Watching it work

While a mission runs, real phase changes arrive:

```text
📋 Remote Work — Planning
⌨️ Remote Work — Coding
   Tasks: 1/3 done · now: T2
🧪 Remote Work — Testing
   Tasks: 2/3 done · now: T3
```

Two things about these are deliberate:

- **The counts are real.** "2/3 done" means two tasks finished verification and
  persisted a checkpoint. There is no percentage anywhere, because elapsed time
  is not progress.
- **They do not duplicate what the mission already tells you.** Approval
  requests, completion Mission Cards, and blocked reports come from the mission
  itself, exactly as they always have. The console announces only the phases
  nothing else covers, and rate-limits to one push per project per minute so a
  retry loop cannot become a notification storm.

Everything is recorded either way — `/events` shows the full record, including
phases that were never pushed.

---

## Destructive actions

`/stop`, `/reset`, and `/shutdown` never happen on one message:

```text
You:  /stop Remote Work

Bot:  ⚠️ Confirm this action

      Stop the mission running on Remote Work (pid 28644). The session
      stays resumable — /start Remote Work continues it.

      Reply: /confirm EWWM
      Or ignore this message — it expires on its own.

You:  /confirm EWWM

Bot:  ⏹️ Remote Work — stop requested. The session stays resumable.
```

The code is single-use, expires after five minutes, and is tied to the channel
it was issued on. A bare `/confirm` works when exactly one thing is pending; with
two, it is refused and both codes are listed — guessing which mission to stop is
precisely the mistake the gate exists to prevent.

---

## The same console, from a terminal

```console
$ ai-orchestrator operator "/projects"
$ ai-orchestrator operator "Add CSV export to the payroll page."
$ ai-orchestrator events --project "Remote Work" --limit 20
$ ai-orchestrator projects status
```

`operator` sends the message through the *same router* your phone talks to —
there is one implementation of the command logic, not two.

> **Operator recommendation: use PowerShell, not Git Bash, for CLI slash
> commands.** Git Bash on Windows rewrites a leading `/` into a filesystem
> path before the shell ever sees it, so `operator "/projects"` arrives at
> the router mangled — and because `resolveTarget()` treats unmatched input
> as free-form mission text, a mangled command can silently create a real
> mission request instead of failing loudly. This has recurred across
> Phase 13/14 development (see `docs/PHASE_13_M8_REPORT.md` and
> `docs/PHASE_13_RECONCILIATION_2026-07-30.md` for two disclosed incidents)
> — it is Windows/Git-Bash behavior, not a bug in this codebase, so there is
> no code fix, only this standing recommendation. If Git Bash is
> unavoidable, drop the leading
> slash: `operator "projects"` and `operator "status alpha"` both work in
> any shell.

---

## What the system records

Every real outcome becomes an event in `state/events/events.jsonl` — an
append-only log with monotonic sequence numbers that survive restarts. This is
the spine: the phone, the CLI, and (from M3) the desktop all *read* it rather
than each keeping their own idea of what happened.

```console
$ ai-orchestrator events --project Remote-Work --limit 6
#31 mission.created   {"id":"M4","objective":"Build a payroll dashboard…"}
#33 mission.approved  {"id":"M4"}
#34 worker.started    {"pid":29956}
#36 approval.required {"id":"A26","title":"Implementation review…"}
#43 approval.accepted {"id":"A26"}
#46 mission.completed {"tasksDone":2,"tasksTotal":2}
```

---

## Turning it down, or off

In `config/orchestrator.json` (see [CONFIGURATION.md](../CONFIGURATION.md) for
the full `operator` block):

- `"operator": { "enabled": false }` — leaves exactly the `v2.8.0` message set
  (`APPROVE`/`REJECT`/`MODIFY`/`DONE`). Approvals are never gated by this.
- `"acceptFreeText": false` — commands only; prose gets `/help`.
- `"progressUpdates": false` — record progress, push nothing.
- `"progressMinIntervalMs"` — how quiet the pushes should be.

---

## Not yet

- **Creating a project from your phone** (`/new`) is Phase 12 M4. The safety
  rule it depends on already exists: `operator.projectRoots` is a real,
  bounded allowlist (defaults to `C:\Users\Admin\Music`), and a path outside
  it is refused. Creation will never write outside an approved root.
- **Deleting, moving, or renaming a project's files on disk** does not exist
  anywhere in the product yet. `/forget` (Phase 13 M3) removes a project from
  the *registry* only — its files are never touched, so it is not the same
  capability. When M4 adds real file operations, they inherit the
  confirmation gate above.
- **A "Packaging" phase** is not reported, because the mission lifecycle has no
  such state. Reporting one would be simulating work.
