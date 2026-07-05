# Configuration

Everything is driven by JSON files — normal operation never requires a code
edit. Two kinds of files:

```text
config/orchestrator.json        global settings (all optional)
config/projects/<name>.json     one file per supervised project
```

Any key you omit falls back to the documented default (defined in
`src/config/defaults.js`).

---

## Global settings — `config/orchestrator.json`

### logging

| Key | Default | Meaning |
| --- | --- | --- |
| `level` | `"info"` | `debug` \| `info` \| `warn` \| `error` |
| `console` | `true` | Mirror logs to the console |
| `file` | `true` | Write rotated files to `logs/` |
| `maxFiles` | `"14d"` | Retention (duration like `14d`, or a count) |
| `maxSize` | `"10m"` | Rotate a file when it reaches this size |

Files: `logs/orchestrator-YYYY-MM-DD.log` (everything) and
`logs/error-YYYY-MM-DD.log` (errors only).

### api

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Serve the read-only dashboard API |
| `host` | `"127.0.0.1"` | Bind address (local-only by default) |
| `port` | `4711` | Port |

### supervision

| Key | Default | Meaning |
| --- | --- | --- |
| `statusUpdateIntervalMs` | `5000` | status.json refresh cadence |
| `heartbeatIntervalMs` | `15000` | Heartbeat stamp cadence (reboot detection) |
| `childProcessScanIntervalMs` | `60000` | Child-PID enumeration cadence (0 = off) |

### recovery

| Key | Default | Meaning |
| --- | --- | --- |
| `maxConsecutiveCrashes` | `5` | Give up after this many crashes in a row |
| `crashBackoffBaseMs` | `15000` | First restart delay; doubles per crash |
| `crashBackoffMaxMs` | `900000` | Backoff ceiling (15 min) |
| `networkRetryDelayMs` | `60000` | Delay before retrying a network failure |

### progress

Loop prevention and progress awareness — the safeguard that makes an
unbounded no-progress relaunch loop impossible. This is what stops a
write-blocked or stuck agent from silently burning your usage overnight.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. `false` reverts to v1 marker-only completion (not recommended for unattended runs) |
| `maxConsecutiveNoProgress` | `3` | Completed-but-unfinished runs that change **nothing** in the workspace before the circuit breaker trips, stops, and writes a diagnostic report |
| `interRunDelayMs` | `15000` | Pause between continue-relaunches (abortable by stop); paces quota spend |
| `blockedDetection` | `true` | Treat an explicit "agent is blocked" message (e.g. permission denied) plus no progress as an immediate stop |

How progress is measured: after each run the orchestrator computes a
signature of the working directory — git HEAD + `git status` + the contents
of changed files when the workspace is a git repo, otherwise a scan of file
paths/sizes/mtimes (ignoring `node_modules`, `.git`, build/state/log dirs).
The signature changing = progress. If it genuinely cannot be measured, the
run is counted as **no progress** (fail closed), so problems pause for review
rather than loop. A tripped breaker archives the session as `blocked` (a
terminal, non-resumable state) and writes `state/diagnostics/<project>-<ts>.md`.

### rateLimit

| Key | Default | Meaning |
| --- | --- | --- |
| `minWaitMs` | `5000` | Floor for any wait (hot-loop guard) |
| `defaultWaitMs` | `3600000` | Wait when the reset time can't be parsed (1 h) |
| `maxWaitMs` | `21600000` | Never sleep longer than this in one stretch (6 h) |
| `resumeGraceMs` | `60000` | Margin added past the announced reset time |

### notifications

`events` — which orchestrator events notify. Default:
`session:rate-limited`, `session:crashed`, `session:gave-up`,
`mission:complete`, `orchestrator:recovered-after-reboot`. You may add
`session:launched`, `session:resumed`, `session:recovered`,
`session:network-error`.

| Channel | Keys | Notes |
| --- | --- | --- |
| `desktop` | `enabled` (default `true`) | Native toast, zero config |
| `webhook` | `enabled`, `url`, `headers` | POSTs JSON; universal integration |
| `discord` | `enabled`, `webhookUrl` | Discord channel webhook |
| `telegram` | `enabled`, `botToken`, `chatId` | Telegram bot |
| `email` | `enabled` | Placeholder — see ROADMAP.md |

### Other

| Key | Default | Meaning |
| --- | --- | --- |
| `defaultProject` | `""` | Project used when `start` is run with no name |
| `plugins.enabled` | `true` | Load plugins from `plugins/` |
| `paths` | `{}` | Relocate `logsDir`, `stateDir`, `statusFile`, … |

---

## Project settings — `config/projects/<name>.json`

Minimal working example:

```json
{
  "driver": "claude",
  "workingDirectory": "C:/Users/Admin/Music/The-Finisher",
  "promptFile": "prompt.md"
}
```

| Key | Required | Default | Meaning |
| --- | --- | --- | --- |
| `driver` | no | `"claude"` | Which engine driver runs this project |
| `workingDirectory` | **yes** | — | Folder the agent works in |
| `promptFile` | **yes** | — | Mission prompt (relative to `workingDirectory` or absolute). Used for the FIRST launch; resumed runs use `mission.continuePrompt` |
| `enabled` | no | `true` | Reserved for multi-project scheduling |

### mission

| Key | Default | Meaning |
| --- | --- | --- |
| `completionMarker` | `"MISSION COMPLETE"` | Text whose appearance in the agent's final output ends the mission. **Instruct the agent in your prompt to print it only when everything is done.** Set `""` to disable (then supervision runs until `maxRuns` or manual stop) |
| `continuePrompt` | *"Continue from where you left off…"* | Prompt for resumed/continued runs |
| `maxRuns` | `0` | Safety valve: max launches per mission (0 = unlimited) |

### claude (used when `driver` is `"claude"`)

| Key | Default | Meaning |
| --- | --- | --- |
| `executable` | `"claude"` | Path/name of the Claude Code CLI |
| `model` | `""` | `--model` override (empty = CLI default) |
| `permissionMode` | `""` | `--permission-mode` (e.g. `acceptEdits`, `bypassPermissions`) |
| `dangerouslySkipPermissions` | `false` | `--dangerously-skip-permissions`. Required for fully unattended runs — understand the risk before enabling |
| `allowedTools` | `[]` | `--allowedTools` list |
| `disallowedTools` | `[]` | `--disallowedTools` list |
| `maxTurns` | `0` | `--max-turns` per run (0 = engine default) |
| `extraArgs` | `[]` | Any additional CLI arguments |
| `launchTimeoutMs` | `120000` | Warn (never kill) if zero output this long after launch |

> **Unattended tip:** for multi-day autonomous missions you generally want
> `"permissionMode": "acceptEdits"` or `"dangerouslySkipPermissions": true`,
> otherwise Claude will sit waiting for permission approvals that nobody is
> there to give. The orchestrator will faithfully wait forever — that is its
> job — so grant the permissions the mission actually needs.

### mock (used when `driver` is `"mock"`)

Scriptable fake engine for testing your setup end-to-end:

```json
{
  "driver": "mock",
  "workingDirectory": "C:/anywhere",
  "promptFile": "prompt.md",
  "mock": {
    "runs": [
      { "output": "usage limit reached|1", "exitCode": 1, "delayMs": 2000 },
      { "output": "MISSION COMPLETE", "result": "MISSION COMPLETE", "exitCode": 0 }
    ]
  }
}
```

Each entry is one launch: `output` (emitted text), `result` (final result
payload), `exitCode`, optional `signal`, `delayMs` (how long the fake run
"works"). Launches beyond the script replay the last entry.

---

## Environment notes

- Paths in JSON may use forward slashes (`C:/Users/...`) — recommended, as
  backslashes must be escaped (`\\`) in JSON.
- Config is read at startup. Restart the orchestrator (stop → start; the
  session resumes automatically) to apply changes.
- Validation runs before anything launches; errors name the file, the key,
  and the fix (`ai-orchestrator doctor` checks everything at once).
