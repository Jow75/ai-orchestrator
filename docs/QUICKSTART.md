# Quick Start — from zero to your first completed mission

Ten minutes, in order. Assumes the repo is at
`C:\Users\Admin\Music\AI-Orchestrator` (adjust paths otherwise).

> **Fastest path:** run `node bin\ai-orchestrator.js init` — a guided setup
> that does steps 1–4 and the phone connection for you, without editing any
> JSON. See [DAY_ONE.md](DAY_ONE.md). The steps below are the by-hand route,
> useful when you want to understand or fine-tune each piece.

## 1. One-time install

```bat
cd C:\Users\Admin\Music\AI-Orchestrator
npm install
node bin\ai-orchestrator.js doctor
```

Everything `doctor` prints should be ✔ (the "Auto-resume scheduled task"
line is optional — see step 7).

## 2. Understand the three pieces

- **A project** = one JSON file in `config\projects\<name>.json`: *where*
  the agent works and *what* it should do.
- **The orchestrator** = `node bin\ai-orchestrator.js start <name>`: runs
  the agent, watches it, recovers it. One orchestrator process at a time.
- **Your windows into it** = `status`, the log files, and the desktop app.

## 3. Define a project

The guided way (creates the working dir + a starter prompt, validates,
and writes the file for you):

```bat
node bin\ai-orchestrator.js projects add --interactive
```

Or non-interactively:

```bat
node bin\ai-orchestrator.js projects add my-project ^
    --dir "C:\path\to\your\project" --prompt prompt.md
```

This creates `config\projects\my-project.json` with write permissions
already set (`"claude": { "permissionMode": "acceptEdits" }`) — an
unattended headless agent cannot answer permission prompts, so without
this it could not write a single file. Pass `--permission-mode <mode>`
to choose a different mode. (`doctor` also warns about any project that
is missing it.)

Then open the file and whitelist the shell commands your mission needs:

```json
{
  "driver": "claude",
  "workingDirectory": "C:\\path\\to\\your\\project",
  "promptFile": "prompt.md",
  "claude": {
    "permissionMode": "acceptEdits",
    "allowedTools": ["Bash(git:*)", "Bash(node:*)", "Bash(npm:*)"]
  }
}
```

`acceptEdits` lets the agent create/edit files; `allowedTools` whitelists
the shell commands your mission needs. For everything-allowed (trusted,
isolated workspaces only): `"dangerouslySkipPermissions": true`.

## 4. Write the mission prompt

Create `prompt.md` inside the working directory. Two mandatory ingredients:

1. **The work** — what to build/fix/finish, with concrete success criteria.
2. **The completion contract** — end with: *"When — and only when — the
   entire mission is finished, output the exact text `MISSION COMPLETE`."*

Without the marker the orchestrator keeps relaunching ("clean exit without
marker = unfinished") until the no-progress breaker stops it.

> Better than one big prompt: define `tasks` with per-task **verification**
> (file-exists / command / etc.) so completion is *checked*, never taken on
> the agent's word. See `config/projects/audit-demo.json` in this repo for
> a working example, and CONFIGURATION.md → "tasks".

## 5. Start it

```bat
node bin\ai-orchestrator.js start my-project
```

or double-click `START_AI.bat` (pass a project name, or set
`defaultProject` in `config\orchestrator.json`).

## 6. Watch it (all optional — it runs unattended)

```bat
node bin\ai-orchestrator.js status            :: live snapshot
node bin\ai-orchestrator.js timeline my-project
type logs\orchestrator-%DATE:~10,4%-%DATE:~4,2%-%DATE:~7,2%.log
```

Or the desktop app: `cd desktop && npm install && npm start`
([DESKTOP_GUIDE.md](DESKTOP_GUIDE.md)).

Silence is normal. The orchestrator NEVER interrupts a living agent
process — six quiet hours can be healthy work.

## 7. Make it survive reboots (recommended)

```bat
node bin\ai-orchestrator.js scheduler install
```

Registers a Windows Task Scheduler task that runs `resume` at logon —
a mid-mission power cut becomes "continues after you log back in."

## 8. Stop it safely

```bat
node bin\ai-orchestrator.js stop
```

Graceful, always: the session stays resumable and the next `start`
continues the same conversation. `--fresh` on a later start abandons it.

## 9. When something goes wrong

```bat
node bin\ai-orchestrator.js doctor
```

then [../TROUBLESHOOTING.md](../TROUBLESHOOTING.md). If a mission stopped
itself, read the report in `state\diagnostics\` — it names the cause.

## 10. Where to go next

- Phone control: [TELEGRAM_SETUP.md](TELEGRAM_SETUP.md) +
  [REMOTE_APPROVALS.md](REMOTE_APPROVALS.md)
- Scheduled nightly missions: CONFIGURATION.md → "Scheduled missions"
- Several projects at once: `start projA projB`
  (CONFIGURATION.md → "Coordination")
