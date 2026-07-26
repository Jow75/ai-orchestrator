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
is done, and that `mission.completionMarker` matches it exactly. As of v1.1
this can no longer loop forever — see "Mission blocked" below.

### "Mission blocked" — supervision stopped itself

The progress circuit breaker (v1.1) stopped the mission because it detected
no real progress. Read the diagnostic report it wrote at
`state/diagnostics/<project>-<timestamp>.md` — it names the likely cause and
the fix. Two common cases:

- **Permission denied / blocked agent.** In headless mode the agent cannot
  ask for permission, so write tools are auto-denied and it accomplishes
  nothing. Set `claude.permissionMode` (e.g. `"acceptEdits"`) or
  `claude.allowedTools` in the project config. *(This was the cause of the
  overnight incident that motivated the feature.)*
- **Stagnation.** `maxConsecutiveNoProgress` runs changed nothing in the
  workspace. The mission may be unclear, already effectively done, or stuck.
  Inspect the recent runs in the report and `state/ledger/<project>.jsonl`.

The blocked session is archived to history (it is *not* auto-resumed, so a
restart cannot re-enter the loop). After fixing the cause, `ai-orchestrator
start <project>` begins a clean session. To tune sensitivity, adjust the
`progress` block (see [CONFIGURATION.md](CONFIGURATION.md)); to disable the
guard entirely, set `progress.enabled: false` (not recommended for
unattended runs).

### A legitimately slow mission got blocked

If a mission does real work that does not touch files for several runs
(long research/reading phases), raise `progress.maxConsecutiveNoProgress` or
increase `progress.interRunDelayMs` — either globally in
`config/orchestrator.json`, or scoped to just this project via a `progress`
block in its own `config/projects/<name>.json` (see CONFIGURATION.md).
Committing intermediate work (git) or writing scratch notes also registers
as progress — including inside a `.gitignore`d directory, which v2's
progress engine detects (v1.1 relied on `git status` alone and missed this).
Blocked sessions are always preserved, so nothing is lost.

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
warning in [CONFIGURATION.md](CONFIGURATION.md). `projects add` sets
`acceptEdits` by default (v2.3.1), and `doctor` warns about any claude
project still missing write permissions.

### A project is stuck `[active: waiting-retry]` from an old run

A previous session was interrupted and is still resumable, so `start`
would resume it rather than begin fresh. To discard it without launching
anything: `ai-orchestrator sessions <project> --abandon` (archives it as
stopped; the next `start` starts the mission over). It refuses if an
orchestrator is actively supervising that project — use `stop` there.

---

## Mission mode (Phase P2/P3/P4 — task-based projects)

### "Task X failed verification after N attempts" — blocked

A task's `maxRuns` was reached without its verifiers passing. Read the
diagnostic report (`state/diagnostics/<project>-<ts>.md`) — it lists exactly
which checks failed and why. Common causes:

- **The verifier checks the wrong thing.** A `file-exists` path or
  `command` typo, or an `output-contains` pattern that doesn't match what
  the agent actually prints. Fix the verifier in the project config.
- **The agent misunderstood the objective.** Reread the task's `prompt`
  file; make the objective and success criteria more explicit.
- **The task genuinely needs more attempts.** Raise that task's `maxRuns`
  in `config/projects/<name>.json`, or queue a fixed version with
  `ai-orchestrator tasks add`.

The session is archived (not auto-resumable) so a restart cannot re-enter
the same failing loop — and the blocked task's queue entry is never
silently re-run by a later `start` either (verified by a dedicated test),
regardless of session lineage. Fix the cause, then either edit the static
`tasks` array and `start` again (restarts from task 1 of the static plan),
or `ai-orchestrator tasks add <project> ...` a corrected replacement task
and `start` — whichever matches how the mission was built.

### `ai-orchestrator tasks list <project>` shows nothing / "No task queue"

Either the project hasn't been run yet, has no `tasks` array, and nothing
has been queued via `tasks add` (legacy single-prompt mode has no task
queue by design — use `sessions`/`timeline` instead).

### Unknown verifier type error at startup

`ai-orchestrator doctor` (or any command that loads the project) reports
this immediately, with the full list of known types — see "Verifier types"
in [CONFIGURATION.md](CONFIGURATION.md). Typo in `verify[].type` is the
usual cause. `tasks add --verify-file` reports the same error immediately
if its JSON references an unknown type.

### "Task plan changed mid-mission; restarting the task queue" (log warning)

The project's static `tasks` array was edited (ids added/removed/reordered)
while a session for it was still active. Reconciling an arbitrary edit
against in-progress work isn't attempted — the task queue reinitializes
under the existing session. Avoid editing the static `tasks` array while a
mission is running; use `tasks add/remove/reorder` instead, which mutate
the *running* queue safely (see below) rather than the file underneath it.

### `tasks remove`/`tasks reorder` says a task "is not pending"

Only a task that has **never been launched** can be removed or reordered —
this is deliberate: mutating an active, done, failed, or blocked task would
either corrupt in-flight supervision or discard real history. Check
`ai-orchestrator tasks list <project>` for the task's actual state; if it
already ran, there is nothing to remove/reorder.

### I queued tasks with `tasks add` but `start` doesn't seem to run them

Confirm with `ai-orchestrator tasks list <project>` that they were actually
added (a validation error from `tasks add` — bad prompt path, unknown
verifier type, duplicate id — exits non-zero and queues nothing). If the
project's **static** `tasks` array is also non-empty, the static plan and
the queue are the *same* queue — `tasks add` appends to whatever already
exists; it does not create a second, competing plan. If a *previous*
mission on this project ended `blocked`/`failed`, note the "never silently
re-adopted" rule above: a fresh `start` after that falls back to the
static plan or legacy `promptFile`, not to whatever was queued against the
old, now-abandoned attempt — queue new tasks first, then `start`.

### A task with no `verify` never seems to finish

A task with an empty (or omitted) `verify` list falls back to
`mission.completionMarker` as its completion signal — the agent must print
that exact marker for the task (not just the whole mission) to be
considered done. Either add real verifiers or ensure the task's prompt
instructs the agent to print the marker when that task specifically is
finished.

### The retry prompt looks different from what `continuePrompt` says (Phase P4)

Expected: by default (`briefing.enabled: true`), a resume or retry sends a
generated **Continuation Builder** briefing — completed/remaining tasks,
and on a verification-failed retry, exactly which check failed and why —
instead of the static `continuePrompt`/`mission.continuePrompt` string. If
you need the old byte-for-byte static-string behaviour (e.g. a custom
`continuePrompt` your prompt engineering depends on verbatim), set
`"briefing": { "enabled": false }` in `config/orchestrator.json`. See the
`briefing` section in [CONFIGURATION.md](CONFIGURATION.md).

### A retry's briefing doesn't mention "Recent activity"

That section only appears when the progress ledger has entries to
summarize (`briefing.recentRunCount`, default `3`) — it's omitted rather
than shown empty on a task's very first retry, when there's nothing yet
to report from previous runs on this specific task/mission combination.

## Memory (Phase P5)

### I added a note but it's not showing up in the briefing

Check it was actually recorded: `ai-orchestrator memory list <project>`.
Notes only render in a **generated** briefing (`briefing.enabled: true`,
the default) — if you've disabled briefing entirely (see above), nothing
in memory reaches the agent either, since the static `continuePrompt`
string is used verbatim.

### A resolved problem keeps reappearing in every briefing

Failures are never auto-resolved, even once the task that hit them later
succeeds — this is deliberate (an operator should confirm the underlying
*cause* was fixed, not infer it from one later success). Run
`ai-orchestrator memory list <project>` to find the failure's id, then
`ai-orchestrator memory resolve <project> <id>`.

### I edited the static `tasks` array and now old task history seems gone from `tasks list`

That's expected — `tasks list` only shows the **current** queue, and a
plan-shape edit reinitializes it fresh. The old queue's finished tasks
(DONE/FAILED/BLOCKED) aren't discarded, though: they're archived to
memory first. Check `ai-orchestrator memory list <project>` — if a task
id from the new plan matches one from the old, its prior outcome will
also surface automatically in that task's next retry briefing.

### `memory resolve` says "No failure with id N"

Ids are per-project and assigned in insertion order starting at 1 — run
`ai-orchestrator memory list <project>` to see the actual ids currently
recorded (a resolved failure keeps its id; ids are never reused or
renumbered).

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

### A mutating API call returns 401 (Phase P7)

Every mutating endpoint (`POST /api/control/stop`, `/api/tasks/:project/*`,
`/api/memory/:project/*`) requires the local API token. Get it with
`ai-orchestrator api-token`; send it as `Authorization: Bearer <token>`
(or `X-API-Token: <token>`). A 401 with no token sent, a stale/wrong
token, or no token file existing yet (it's generated on first use — run
`ai-orchestrator api-token` once to force creation) all look identical:
the endpoint intentionally never distinguishes "wrong token" from "no
token configured," so an attacker can't use the error message to probe
whether auth is set up at all.

### Clicking a desktop (toast) notification does nothing

Confirmed during Phase 11 M2 live validation, not a bug: on Windows, the
`desktop` channel uses `node-notifier`'s `WindowsToaster` (SnoreToast under
the hood), and that integration's own option set
(`title`/`message`/`icon`/`sound`/`id`/`appID`/`remove`/`install`) has no
click-to-open/click-handler support at all — that capability exists in
`node-notifier` only for macOS's `NotificationCenter`. A toast click
dismissing with no action is the platform integration's real ceiling, not
something this code is failing to wire up. Use the desktop **app**
(`desktop/README.md`) or Telegram (which does support real document
attachments) when you want to act on a notification, not the OS toast.

### `tasks approve`/`tasks skip` says a task "is not the current task" or "not blocked/failed"

Both operator overrides (Phase P7) only ever act on the queue's
**current** task, and only when it's `blocked` or `failed`. Check
`ai-orchestrator tasks list <project>` — if the task you meant isn't
first in the list (marked with `→`), it isn't current; if it's `pending`,
`active`, or `done`, there's nothing to approve or skip. A queue can only
have one BLOCKED/FAILED task at a time (the one supervision stopped on).

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
