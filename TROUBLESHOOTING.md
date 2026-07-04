# Troubleshooting

First stop for any problem:

```bat
node bin\ai-orchestrator.js doctor
```

It checks Node, configuration, every project, engine installation, state-dir
permissions, and the scheduled task. Second stop: `logs/orchestrator-*.log` —
every launch, exit classification, wait, resume, and decision is recorded
there with its reasoning.

---

## Startup problems

### "Another AI-Orchestrator instance is already running (pid N)"

An orchestrator with that PID is alive. Inspect with `status`; stop it with
`stop`. If the PID is actually dead (very rare), delete
`state/heartbeat.json` and start again.

### "Project X not found" / config validation errors

The message names the file and key to fix. Project files live in
`config/projects/<name>.json`; `workingDirectory` and `promptFile` must
exist on disk.

### "Cannot run claude --version"

Claude Code is not installed or not on PATH:
`npm install -g @anthropic-ai/claude-code`, then verify `claude --version`
in a *new* terminal. If it lives somewhere unusual, set the full path in the
project's `claude.executable`.

---

## Supervision behaviour

### The agent has been silent for hours — is something wrong?

Usually no, and the orchestrator will not touch it — silence is not failure
(training runs, builds, big downloads are normal). Check `status`:
`Last output` shows when it last spoke and `Agent PID … (children: …)` shows
live child processes — a `python`/`git` child means healthy work. If you are
convinced it is truly stuck, `ai-orchestrator stop` ends it gracefully and
the next `start` resumes the conversation.

### It keeps relaunching after every clean run

That is the design: a clean exit **without** the completion marker means
"unfinished mission — continue". Ensure your prompt instructs the agent to
print the exact marker (`MISSION COMPLETE` by default) only when everything
is done, and that `mission.completionMarker` matches it exactly.

### It declared mission complete too early

The agent printed the marker prematurely. Strengthen the prompt ("only when
every task is verified") or choose a more distinctive marker string.

### Usage limit: the wait looks wrong

The reset time is parsed from the engine's message when possible (source
`parsed` in the "Usage limit wait computed" log line), otherwise
`rateLimit.defaultWaitMs` applies (source `default`). Waits are clamped to
`[minWaitMs, maxWaitMs]` — if the announced reset is 9 h away and
`maxWaitMs` is 6 h, the orchestrator wakes at 6 h, the engine reports the
limit again, and it waits the remainder. Tune the `rateLimit` block.

### "Giving up after repeated crashes"

`recovery.maxConsecutiveCrashes` consecutive crashes tripped the
anti-thrash guard. The session is preserved — the log's exit classifications
tell you what kept failing; fix the underlying cause and `start` again to
resume the same conversation.

### It resumed with a fresh conversation instead of continuing

The engine session id was never captured (first run died before the engine
reported it). Check `state/sessions/<project>.json` → `engineSessionId`. If
it is `null` after a crash on the very first launch, the next run starts
from the mission prompt again — by design, since there is nothing to resume.

### Claude sits waiting for permission approvals

Unattended missions must not require interactive approvals. Set
`claude.permissionMode` (e.g. `acceptEdits`) or
`claude.dangerouslySkipPermissions: true` in the project config — see the
warning in [CONFIGURATION.md](CONFIGURATION.md).

---

## Reboot recovery

### Nothing resumed after a reboot

1. Is the task installed? `ai-orchestrator scheduler status`
2. Did you log on? The default task fires **at logon**, 30 s delayed.
3. Was anything resumable? `ai-orchestrator sessions` — only sessions in
   `running` / `waiting-*` / `gave-up` states resume.
4. Check Task Scheduler history (`taskschd.msc`) for the task's last result.

### It resumed but I wanted it stopped

`ai-orchestrator stop` then `scheduler uninstall` (or archive the session:
`start --fresh` next time).

---

## Observability

### status.json seems stale

It refreshes every `supervision.statusUpdateIntervalMs` (5 s) while an
orchestrator runs. A stale `updatedAt` with no running process is just the
final snapshot of the last run.

### API not reachable

`api.enabled` must be true; the default bind is `127.0.0.1` (local only).
If port 4711 is taken the orchestrator logs a warning and continues without
the API — change `api.port`.

### Logs growing / missing

Rotation is automatic (`logging.maxSize`, `logging.maxFiles`). For deep
debugging set `logging.level` to `"debug"` — this includes child-process
scans and stream events.

### Corrupt state warnings

`*.corrupt-<timestamp>` files in `state/` are quarantined copies of files
damaged by power loss mid-write. The orchestrator already fell back safely;
the copies exist only for forensics and can be deleted.

---

## Still stuck?

Collect these before filing an issue:

1. `logs/orchestrator-<today>.log` (and `error-<today>.log`)
2. `status.json` and `state/sessions/<project>.json`
3. Output of `ai-orchestrator doctor`
4. Your `config/orchestrator.json` and the project file (redact secrets)
