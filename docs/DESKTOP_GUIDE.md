# Desktop App — user guide

The Electron operator console. It is a *window onto* the same engine the
CLI uses — anything you do here you can also do from the CLI, and both see
the same state on disk.

## Launch / quit

```bat
cd C:\Users\Admin\Music\AI-Orchestrator\desktop
npm install        :: first time only
npm start
```

Closing the window **never stops a running mission** — missions are
detached processes. Stop missions from the Missions view (or `stop`).

The sidebar's **Live / Idle badge** tells you whether an orchestrator
process is currently running (from `state/heartbeat.json`). Live → the app
talks to the HTTP API; Idle → it reads the same state files directly.

## The nine views

### Dashboard
The at-a-glance answer to "what is it doing?": orchestrator state, current
project, uptime, agent PID + child processes, current activity, run/resume/
crash/rate-limit counters, rate-limit countdown when waiting, and a project
grid. Start here every morning.

### Missions
Start / stop / resume missions. Pick a project, press Start — it spawns the
real `ai-orchestrator start` CLI as a detached process (survives closing
the app). The **lifecycle strip** on top shows the mission's current state
(received → planned → approval-pending → executing → verifying →
completed/blocked/…) with recent transitions. Also: create a new
(single-prompt) project entirely in-app. **After creating one, add the
`claude.permissionMode` block to its JSON before a real unattended run —
see [QUICKSTART.md](QUICKSTART.md) step 3.**

### Tasks
The task queue for mission-mode projects: every task with its state
(pending/active/done/failed/blocked), attempts, and verification results.
Add a task (id, prompt file, objective, verify JSON, role/agent), remove or
reorder PENDING tasks, and — for a blocked/failed current task — **Approve
retry** (clean-slate retry on next start) or **Skip** (mark done and move
on). Mutations need the API token when a mission is live; the Settings view
shows it.

### Agents (Phase 9)
The multi-agent roster: each agent's role, driver, capabilities, engine
install status, and task performance (done/failed/blocked, avg run time).
The agent handling the current task is highlighted. Empty roster = the
implicit single agent (normal until you create `config/agents.json`).

### Approvals (Phase 10)
Every pending approval request across all projects — the same requests
Telegram/email publish. One click: **Approve**, **Modify…** (with a note
the agent will read), **Reject** (with a reason), or **"Done — I did it"**
for human-action pauses. Below: the full per-project audit history.

### Timeline
The mission's story as sparse human events: started, progress, rate-limit
waits, resumes, approvals, task-done, blocked, complete. Read this to
understand what happened overnight.

### Memory
The project's long-term memory: operator **notes** (add durable facts the
agent should always know), the **failure catalog** (auto-recorded blocks —
mark them resolved once fixed so briefings stop mentioning them), and
**archived task history**.

### Logs
Tails `logs/*.log` live. **System/lifecycle events only** — launches, exit
classifications, waits, decisions — NOT the agent's conversation
transcript (a known limitation; the raw transcript isn't persisted
anywhere today).

### Settings
Shows/rotates the API token, shows every project's JSON location with an
"Open file" shortcut, and shows notification config read-only. Editing an
existing project or notification channels means opening the JSON file —
by design in this version.

## Limitations to know (from desktop/README.md, all deliberate v1 scope)

- No packaged installer — dev-mode `npm start` only.
- Settings is view-and-open-file, not a full config editor.
- Verify rules are entered as raw JSON.
- The desktop starts ONE mission at a time (parallel `start a b` is CLI-only).
- Logs view ≠ agent transcript.
