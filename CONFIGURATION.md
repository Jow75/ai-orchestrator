# Configuration

Everything is driven by JSON files — normal operation never requires a code
edit. Three kinds of files:

```text
config/orchestrator.json        global settings (all optional, git-tracked)
config/local.json               machine-local overrides + credentials (git-IGNORED)
config/projects/<name>.json     one file per supervised project
```

Any key you omit falls back to the documented default (defined in
`src/config/defaults.js`).

## `config/local.json` — where credentials belong

`config/local.json` is loaded after `config/orchestrator.json` and
deep-merged over it, so any key set here wins. It is listed in
`.gitignore`, so **put every secret here** — SMTP passwords, Telegram bot
tokens — and they can never be committed by accident. The tracked
`orchestrator.json` holds only non-secret defaults. Example:

```json
{
  "notifications": {
    "telegram": { "enabled": true, "botToken": "<token>", "chatId": "<id>" },
    "email": { "enabled": true, "smtp": { "host": "smtp.gmail.com", "port": 587,
      "starttls": true, "user": "me@gmail.com", "pass": "<app password>" },
      "from": "me@gmail.com", "to": "me@gmail.com" }
  },
  "approvals": { "providers": { "telegram": { "enabled": true }, "email": { "enabled": true } } }
}
```

Verify any channel end-to-end at any time with
`ai-orchestrator notify test` (sends a real message through every enabled
channel and prints ✔/✘ per channel). `ai-orchestrator doctor` also lists
the enabled channels and warns when only the local desktop toast is on.

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
| `enabled` | `true` | Serve the dashboard API |
| `host` | `"127.0.0.1"` | Bind address (local-only by default) |
| `port` | `4711` | Port |

Read-only endpoints (`/api/status`, `/api/tasks/:project`, `/api/memory/:project`,
...) need no authentication — unchanged since P0. Mutating endpoints
(Phase P7 — stopping a mission, editing a task queue, approving/skipping
a blocked task, resolving a memory failure) require the local API token:
run `ai-orchestrator api-token` to print it (a fresh one is generated on
first use and stored at `state/api-token.txt`), or `--rotate` to
invalidate it and generate a new one. See API.md for the full endpoint
list and request/response shapes.

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

How progress is measured: after each run the orchestrator scans the working
directory (ignoring `node_modules`, `.git`, build/state/log dirs) and records
each file's size and modification time, plus the git HEAD when the directory
is a repo. Comparing this scan to the previous run's produces structured
change facts — files created, modified, deleted, and whether a git commit
was made — persisted at `state/progress/<project>.snapshot.json`. Any change
= progress. Unlike relying on `git status` alone, this also catches work
done inside a **git-ignored** directory (build output, scratch files) — it
is not fooled by `.gitignore`. If the workspace genuinely cannot be measured
(missing directory, permission error), the run is counted as **no progress**
(fail closed), so environment problems pause for review rather than loop.
A tripped breaker archives the session as `blocked` (a terminal,
non-resumable state) and writes `state/diagnostics/<project>-<ts>.md`.

Per-project override: set a `progress` block in a project's own
`config/projects/<name>.json` (e.g. `{"progress": {"maxConsecutiveNoProgress": 6}}`)
to raise the threshold for a project whose agent legitimately goes several
runs between observable file changes (long research/reading phases). Any
key you omit falls back to the global setting above.

### briefing (Phase P4 — Continuation Builder)

Controls whether a resume/retry gets a structured briefing generated from
live orchestrator state, or the old static `continuePrompt` string.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. `false` reverts to the static `continuePrompt` string, byte-for-byte |
| `recentRunCount` | `3` | How many recent progress-ledger entries to summarize in the briefing's "Recent activity" section |

When enabled, every resume/retry prompt is built by
`src/briefing/continuationBuilder.js` instead of reusing a fixed string:
completed tasks (so they're never redone), remaining tasks, and — on a
retry after a failed verification — **exactly which check failed and
why** (e.g. `file-exists failed: Not found: out.txt`), read from
`TaskQueue.recordVerifyResult()`'s stored outcome. Legacy (single-prompt)
missions get an equivalent briefing scoped to the whole mission rather
than one task. See ARCHITECTURE.md's "Continuation Builder" section for
the full briefing shape.

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
| `email` | `enabled`, `smtp` (`host`, `port`, `starttls`/`secure`, `user`, `pass`), `from`, `to` | Real SMTP since Phase 10C — see "Notifications — Phase 10F additions" below and docs/EMAIL_SETUP.md |

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
| `promptFile` | conditional | — | Mission prompt (relative to `workingDirectory` or absolute). **Required unless `tasks` is defined** (see below) — used for the FIRST launch; resumed runs get a Continuation Builder briefing (Phase P4), or `mission.continuePrompt` if `briefing.enabled` is `false` |
| `tasks` | no | `[]` | Phase P2: an ordered task plan instead of one prompt — see "tasks" below |
| `enabled` | no | `true` | Reserved for multi-project scheduling |
| `description` | no | `""` | Phase 12 M2: one line describing what this project is, shown by `/projects` on your phone and by `projects status`. Purely descriptive — nothing reads it to make a decision, and an empty one simply renders nothing |

### mission

| Key | Default | Meaning |
| --- | --- | --- |
| `completionMarker` | `"MISSION COMPLETE"` | Text whose appearance in the agent's final output ends the mission. **Instruct the agent in your prompt to print it only when everything is done.** Set `""` to disable (then supervision runs until `maxRuns` or manual stop) |
| `continuePrompt` | *"Continue from where you left off…"* | Fallback prompt for resumed/continued runs, used only when `briefing.enabled` is `false` (see the `briefing` section above) |
| `maxRuns` | `0` | Safety valve: max launches per mission (0 = unlimited) |

### progress (optional, per-project override)

Empty by default (`{}`) — every key you omit falls back to the global
`progress` block (see above). Same keys: `enabled`, `maxConsecutiveNoProgress`,
`interRunDelayMs`, `blockedDetection`. Example — a project whose agent does
long research phases between file writes:

```json
"progress": { "maxConsecutiveNoProgress": 8 }
```

### tasks (Phase P2 — mission mode)

A project with no `tasks` (or an empty array) runs in **legacy mode**:
one prompt, marker-based completion — exactly as v1/P0/P1. Defining a
non-empty `tasks` array switches the project to **mission mode**: an
ordered plan of tasks, each with its own prompt and (crucially) its own
**verification** — a task is done only when its verifiers pass, never
merely because the agent said so.

```json
{
  "driver": "claude",
  "workingDirectory": "C:/Users/Admin/Music/MyProject",
  "tasks": [
    {
      "id": "T1",
      "objective": "Scaffold the project skeleton",
      "prompt": "tasks/01-scaffold.md",
      "verify": [
        { "type": "file-exists", "path": "src/index.js" },
        { "type": "command", "run": "npm install", "expectExit": 0 }
      ],
      "maxRuns": 5
    },
    {
      "id": "T2",
      "objective": "Implement the core feature and pass its tests",
      "prompt": "tasks/02-feature.md",
      "verify": [
        { "type": "command", "run": "npm test", "expectExit": 0 }
      ]
    }
  ]
}
```

Note `promptFile` is omitted entirely — mission mode does not use a
single top-level prompt.

Per-task fields:

| Key | Required | Default | Meaning |
| --- | --- | --- | --- |
| `id` | **yes** | — | Short, unique string (e.g. `"T1"`). Used in logs, checkpoints, the `tasks` CLI command, and diagnostic reports |
| `prompt` | **yes** | — | This task's prompt file (relative to `workingDirectory` or absolute) |
| `objective` | no | `id` | Human-readable description, shown in logs/CLI |
| `verify` | no | `[]` | List of verifier configs (see below). **Empty means the task falls back to `mission.completionMarker`** as a lightweight per-task signal |
| `continuePrompt` | no | `mission.continuePrompt` | Fallback prompt sent on a retry of this task, used only when `briefing.enabled` is `false`. When briefing is on (the default), the Continuation Builder generates a structured retry prompt instead — see the `briefing` section above |
| `maxRuns` | no | `5` | Launches allowed on this task before it is marked failed and supervision **blocks** (never silently skips unverified work) |
| `role` | no | — | Phase 9: route this task to an agent filling this role (`planner`/`coding`/`testing`/`documentation`/`research`/`review`). See the `agents` section |
| `agent` | no | — | Phase 9: route this task to a specific agent id (overrides `role`) |
| `capabilities` | no | `[]` | Phase 9: route to any agent advertising all of these capability tags (used only if `agent`/`role` don't match) |

How a mission-mode run proceeds: the current task's prompt is sent on its
first launch; if the run exits cleanly, its verifiers run against the
result. Passing advances to the next task (same engine conversation — no
new session, just a new prompt) or, on the last task, completes the
mission exactly like a legacy marker hit. Failing retries the *same* task
— with a Continuation Builder briefing naming exactly which check failed
(or, if `briefing.enabled` is `false`, the static `continuePrompt`) —
until `maxRuns` is reached, at which point supervision stops with a
diagnostic report explaining which check failed
and why (`state/diagnostics/<project>-<ts>.md`). Usage limits, crashes, and
network errors are handled identically to legacy mode — they resume the
task that was running, not the mission from the start.

Inspect a mission's progress: `ai-orchestrator tasks list <project>` (task
states/attempts) and `ai-orchestrator timeline <project>` (task-done
events alongside the rest of the mission's story). `ai-orchestrator
status` also shows the current task and its position (e.g. `T2 [2/3]`).

#### Verifier types

| Type | Config keys | Passes when |
| --- | --- | --- |
| `file-exists` | `path` | The file (or directory) exists |
| `command` | `run`, `expectExit` (default `0`), `timeoutMs` (default `60000`) | The shell command exits with the expected code. The command is trusted config — same trust model as the mission prompt |
| `output-contains` | `pattern`, `regex` (bool), `flags` | The agent's final output contains the substring, or matches the regex when `regex: true` |
| `files-changed` | `paths` (array; entries ending in `/` match any file under that directory) | Every listed path was created or modified **this run** — reuses the same change facts the progress engine already computed, so it never re-invokes git |
| `json-schema` (Phase P6) | `path`, `schema` (inline) or `schemaFile` | The JSON file at `path` conforms to the schema — a small built-in validator (`type`, `required`, `properties`, `items`, `enum`, `minimum`/`maximum`, `minLength`/`maxLength`, `pattern`); NOT a full JSON Schema draft implementation (no `$ref`, `oneOf`/`anyOf`/`allOf`, `additionalProperties`) |
| `lint` (Phase P6) | `run`, `expectExit` (default `0`), `timeoutMs` | The lint command exits with the expected code. If its output parses as ESLint's `-f json` shape, the failure detail names the specific file/line/rule/message instead of raw output |
| `dependency` (Phase P6) | `name`, `where` (optional: `dependencies`/`devDependencies`/`peerDependencies`), `installed` (default `true`), `packageFile` (default `package.json`) | `name` is declared in the project's `package.json` and — unless `installed: false` — actually present in `node_modules` |

A task can list multiple verifiers; **all** must pass. An unknown verifier
`type` is caught at config-load time (`ai-orchestrator doctor` / any
command that loads the project) with the list of known types in the error.

#### Runtime task queue (Phase P3) — no JSON editing required

The static `tasks` array above is one way to define a mission's plan. The
`tasks add/remove/reorder` CLI commands are another — they operate on the
same persisted queue (`state/tasks/<project>.json`) at runtime, without
touching the project's JSON file at all. This is what "queue multiple
prompts before execution" means in practice: build up (or adjust) a
project's plan interactively instead of hand-writing a `tasks` array.

```bat
:: Queue two tasks on ANY existing project (even one with no static tasks —
:: its promptFile/driver/workingDirectory still need to be valid).
node bin\ai-orchestrator.js tasks add my-project ^
    --id T1 --prompt tasks\01-scaffold.md --objective "Scaffold the project"

node bin\ai-orchestrator.js tasks add my-project ^
    --id T2 --prompt tasks\02-feature.md --verify-file tasks\02-verify.json

:: Inspect, reorder, or remove before it runs
node bin\ai-orchestrator.js tasks list my-project
node bin\ai-orchestrator.js tasks reorder my-project T2 up
node bin\ai-orchestrator.js tasks remove my-project T2

:: Then run it
node bin\ai-orchestrator.js start my-project
```

`tasks add` options:

| Option | Required | Meaning |
| --- | --- | --- |
| `--id <id>` | yes | Unique task id |
| `--prompt <file>` | yes | This task's prompt file (relative to the project's `workingDirectory`, or absolute) |
| `--objective <text>` | no | Human-readable description (defaults to the id) |
| `--max-runs <n>` | no | Launches allowed before this task blocks (default `5`) |
| `--verify-file <file>` | no | Path to a JSON file containing this task's `verify` array (see the verifier types table above). Omit for marker-fallback completion |

Rules worth knowing:

- **`tasks remove`/`tasks reorder`** only operate on a task that has never
  been launched (`PENDING`) — a task that is running, done, failed, or
  blocked cannot be removed or moved, by design (removing in-flight or
  historical work would corrupt supervision state or discard real history).
- **Queuing more tasks after a mission already completed** picks them up
  automatically on the next `start` — the orchestrator adopts any persisted
  queue whose current task is still idle, regardless of which session last
  touched it.
- **A `blocked` or `failed` task is never silently re-run.** If the whole
  queue's current task ended in one of those states, the next `start`
  falls back to the project's static plan (or legacy `promptFile`) instead
  of re-adopting the stuck task — fix the cause first (see
  TROUBLESHOOTING.md), then either queue fresh tasks/edit the static
  config, **or** use `tasks approve`/`tasks skip` (Phase P7, below) if the
  existing task itself should simply be retried or bypassed.
- Static `tasks` (JSON) and the runtime queue are the **same underlying
  queue** — the JSON array only seeds it the first time a session runs;
  after that, `tasks add/remove/reorder` is the way to adjust the plan.

#### Operator overrides (Phase P7) — approve or skip a blocked task

```bat
:: Fixed the underlying cause? Retry the SAME task on the next start:
node bin\ai-orchestrator.js tasks approve my-project T2

:: Or confirm the work is fine (or should be abandoned) and move on:
node bin\ai-orchestrator.js tasks skip my-project T2 --reason "verified manually"
```

Both act only on the **current** task, and only when it is `blocked` or
`failed` — refused otherwise (e.g. a `pending` or `active` task, or any
task id that isn't the current one). `tasks approve` clears the task's
attempts/checkpoint and resets it to `pending`, so the next `start`
retries it with a clean slate. `tasks skip` marks it `done` (with an
`operator-skipped` checkpoint recording the reason) and advances to the
next task — if it was the last task, the mission is now complete; no
further `start` is needed (running one anyway would restart the whole
mission from scratch, the same as re-running any already-completed
mission-mode project). The same two actions are available over HTTP as
`POST /api/tasks/:project/approve` and `.../skip` — see API.md.

#### Memory (Phase P5) — durable, cross-session project knowledge

`state/memory/<project>.json`, managed via the `memory` CLI command
group — not project JSON config, since it's runtime knowledge that
accumulates over a project's life rather than a setting you declare
upfront.

```bat
:: Record a durable fact — surfaced in every future resume/retry briefing
node bin\ai-orchestrator.js memory add my-project ^
    --note "always run npm run build before tests" --category architecture

:: Inspect notes, the failure catalog, and archived task history
node bin\ai-orchestrator.js memory list my-project

:: Mark a recorded failure resolved once its cause is actually fixed
node bin\ai-orchestrator.js memory resolve my-project 1
```

| Command | Meaning |
| --- | --- |
| `memory add <project> --note <text> [--category project\|architecture]` | Record an operator-authored durable fact (default category `project`) |
| `memory list <project>` | Show notes, the failure catalog (resolved/unresolved), and archived task history |
| `memory resolve <project> <failureId>` | Mark a failure resolved — it stops appearing in future briefings |

Two categories fill themselves in automatically, with no CLI action
needed:

- **Failures** are recorded whenever supervision blocks (a BLOCKED or
  FAILED terminal outcome) — independent of the session or task queue
  that hit them, so they outlive both. Only *unresolved* failures are
  surfaced in future briefings.
- **Task history** is archived just before a plan-shape change (editing
  the static `tasks` array mid-mission) would otherwise discard a
  finished task's outcome — so a later plan reusing the same task id
  can still see what happened last time.

All of this feeds the Phase P4 Continuation Builder automatically: every
resume/retry briefing folds in relevant notes, unresolved failures, and
(for the current task) any archived prior attempts on that same task id.
No configuration is needed to enable this — it activates the moment
anything has been recorded.

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
"works"). Launches beyond the script replay the last entry. To simulate the
agent actually doing work (exercising the progress engine and verifiers),
add `writeFile: { path, content }` (creates/overwrites a file, creating
parent directories as needed — just like a real agent's write tool) or
`appendFile: { path, content }` (grows a file across runs).

---

## Agents (Phase 9) — `config/agents.json`

By default every project runs on a single agent: the engine named by its
`driver`. Defining agents turns that into a **team**: each task routes to
the best-fit specialized agent. **This file is optional** — with no
`config/agents.json`, behavior is byte-for-byte the same as before Phase 9.

Copy `config/agents.example.json` to `config/agents.json`. Each agent:

| Key | Required | Default | Meaning |
| --- | --- | --- | --- |
| `id` | **yes** | — | Short unique id (e.g. `"coder"`). Tasks route by this id |
| `role` | no | `"general"` | One of `planner`/`coding`/`testing`/`documentation`/`research`/`review`/`general` |
| `driver` | **yes** | — | A registered driver id (`claude`, `cli`, `mock`, or a plugin driver) |
| `capabilities` | no | `[]` | Free capability tags a task can route on |
| `config` | no | `{}` | Engine-settings override deep-merged over the project at launch (e.g. `{ "claude": { "model": "..." } }` or a `cli` block) |
| `enabled` | no | `true` | `false` keeps the definition but removes it from routing |

A task picks its agent by, in order: explicit `agent` id → `role` → all
`capabilities` matched → the project's default agent. A project may also
declare a project-scoped `agents` array (same schema) that overrides global
agents of the same id.

### The generic `cli` driver

The `cli` driver runs **any** command-line engine, configured entirely from
an agent's `config.cli` block — no code per engine:

| Key | Default | Meaning |
| --- | --- | --- |
| `command` | — (**required**) | The executable to run |
| `args` | `[]` | Static arguments before the prompt |
| `promptArg` | — | Flag the prompt follows (e.g. `"-p"`); absent → prompt via stdin |
| `promptViaStdin` | auto | Force stdin even with `promptArg` |
| `usageLimitPatterns` | sensible defaults | Regex sources that mean "usage limit" |
| `networkPatterns` | sensible defaults | Regex sources that mean "network problem" |
| `launchTimeoutMs` | `120000` | Warn (never kill) after this much initial silence |

The `cli` driver does not implement engine-specific *resume* (most CLIs have
no conversation id) — every launch is fresh and the orchestrator's
continuation prompt + the shared workspace carry context across runs.

Inspect the roster and performance: `ai-orchestrator agents list [project]`
and `ai-orchestrator agents health [project]`, or `GET /api/agents` /
`GET /api/agents/health`, or the desktop app's **Agents** view.

---

## Approvals & operating modes (Phase 10A/10B) — `approvals` block

```json
"approvals": {
  "enabled": true,
  "mode": "balanced",
  "planMarker": "IMPLEMENTATION PLAN READY",
  "decisionPollMs": 15000,
  "decisionTimeoutMs": 0,
  "automaticCategories": ["documentation", "tests", "lint", "formatting", "retry",
    "refactoring", "implementation-continuation", "report", "commit", "changelog"],
  "ownerGateCategories": ["production-deployment", "data-deletion", "repository-deletion",
    "credentials", "financial", "production-configuration", "security", "secrets", "dangerous"],
  "humanActionCategories": ["browser-permission", "desktop-confirmation", "authentication",
    "captcha", "physical-interaction", "external-login"],
  "providers": {
    "telegram": { "enabled": false, "botToken": "", "chatId": "" },
    "email": { "enabled": false, "smtp": {}, "from": "", "to": "" }
  }
}
```

- **`mode`** — `conservative` (everything requires approval), `balanced`
  (default: routine work proceeds; implementation reviews and owner gates
  pause), `autonomous` (only owner gates and human actions pause). A
  project may override just the mode: `"approvals": { "mode": "autonomous" }`
  in its project JSON — or use `ai-orchestrator approvals mode --set <mode>
  [project]`.
- **Categories** are free-form strings; a category in NO list is treated as
  an owner gate (fail closed). Tasks opt in with `"approval": "<category>"`.
- **`planMarker`** — when a run's final output contains this text, the run
  is treated as presenting an implementation plan: a summary is published
  for APPROVE / REJECT / MODIFY instead of continuing. Instruct planning
  agents to print it when (and only when) presenting a plan.
- **`decisionTimeoutMs: 0`** waits forever — a paused mission is resumable
  and abortable at any time, exactly like a rate-limit wait.
- **Provider fallbacks**: an enabled provider with blank credentials uses
  the matching `notifications` channel's settings, so one Telegram bot (or
  SMTP mailbox) serves both systems.
- **Responding**: Telegram reply `APPROVE A7` / `REJECT A7 reason` /
  `MODIFY A7 changes` / `DONE A7`; or `ai-orchestrator approvals
  approve|reject|modify|done <id>`; or the desktop Approvals view; or
  `POST /api/approvals/:project/:id/decide`.

## Notifications — Phase 10F additions

- New events available in `notifications.events`: `approval:required`,
  `human-action:required`, `approval:resolved`, `task:verification-failed`,
  `task:done`, `release:created`, `summary:daily`, `summary:weekly`.
- **Severity**: every event has a default severity (info/warning/critical;
  override via `notifications.eventSeverity`). `notifications.minSeverity`
  is the global floor; each channel may set its own `minSeverity` — e.g.
  keep the desktop chatty but only page Telegram on `critical`. Set it
  interactively with `ai-orchestrator notify tune` (Phase 11 M4) instead of
  hand-editing this key.
- **Email is real now** (dependency-free SMTP):

```json
"email": {
  "enabled": true,
  "smtp": { "host": "smtp.gmail.com", "port": 587, "starttls": true,
            "user": "me@gmail.com", "pass": "<app password>" },
  "from": "me@gmail.com",
  "to": "me@gmail.com"
}
```

  Use `"secure": true` with port 465 for implicit TLS instead of STARTTLS.
- **Summary digests** (sent by `schedules watch`):

```json
"summaries": {
  "daily":  { "enabled": true, "time": "20:00" },
  "weekly": { "enabled": true, "day": "sunday", "time": "18:00" }
}
```

## Notifications — Phase 11 M2 additions

- **Idempotency.** Notifications with a stable identity (approval/human-
  action requests) are never resent just because a poll loop or a resumed
  process notices the request still exists. State lives at
  `state/notifications/<project>.json` (machine-owned, never hand-edit).
  `notifications.reminderMs` (default `0` = never remind automatically) —
  set it to periodically re-notify about a request that's still pending
  after that many milliseconds. To force one resend right now:
  `ai-orchestrator notify resend <project> <id>`.
- **`excludeEvents` (per channel).** Skip specific events on one channel.
  Auto-populated for `telegram`/`email` with
  `approval:required`/`human-action:required`/`approval:resolved` whenever
  that channel's matching `approvals.providers.<name>` is ALSO enabled —
  otherwise one approval sends two near-identical messages (the provider's
  two-way message AND the channel's copy). Add your own on top:

```json
"telegram": { "enabled": true, "botToken": "...", "chatId": "...",
              "excludeEvents": ["task:done"] }
```

- **Safe Telegram formatting.** Every Telegram send now uses
  `parse_mode: 'HTML'`; a filename mentioned in text (`README.md`,
  `report.pdf`) renders as inline code, never a clickable/dead link — real
  `http(s)://` URLs are untouched. When a real file is available (a
  diagnostic report, release notes), it's attached directly via
  `sendDocument` instead of just being named; the text never prints the
  raw filesystem path either way.
- **Executive Mission Cards.** `mission:complete`/`mission:blocked`
  payloads carry a `card` (duration, tasks, files changed, tests,
  confidence, real git commit, and — when blocked — the operator's exact
  next command), rendered as the notification body wherever a card is
  present.
- **`mission:complete` is summary-only by design — it does NOT attach the
  mission's changed source files.** `EVENT_ATTACHMENT` only covers
  `mission:blocked` (`reportPath`) and `release:created` (`notesPath`) —
  both are a SINGLE generated report document. `mission:complete` has no
  equivalent structured "here is one report" field; attaching every file a
  mission touched would mean anywhere from zero to dozens of attachments
  per completion, which is noise, not signal. If you want a document
  attached on completion, generate one (e.g. `release prepare`, which
  writes notes + a verification report you can review or reference) rather
  than expecting the raw source files to arrive as Telegram documents.

## Scheduled missions (Phase 10G) — `config/schedules.json`

```json
{
  "schedules": [
    { "id": "nightly", "project": "my-project", "type": "daily",  "time": "02:00" },
    { "id": "weekly-refactor", "project": "my-project", "type": "weekly",
      "day": "sunday", "time": "03:00", "fresh": true },
    { "id": "one-shot", "project": "other", "type": "once", "date": "2026-08-01T05:00:00" },
    { "id": "hourly-check", "project": "other", "type": "cron", "cron": "0 * * * *",
      "recoverMissed": false }
  ]
}
```

- Types: `daily` (`time` "HH:MM"), `weekly` (`day` + `time`), `once`
  (`date`), `cron` (5-field: minute hour day-of-month month weekday, with
  `*`, lists, ranges, steps, and month/day names).
- `recoverMissed` (default `true`): an occurrence missed while the machine
  was off runs when the watcher next checks. `false` limits firing to a
  10-minute grace window (`missedGraceMs` overrides).
- `fresh` (default `false`): start over instead of resuming.
- Run `ai-orchestrator schedules watch` (e.g. at logon via `scheduler
  install`) or `schedules run-due` from your own automation. A schedule due
  while an orchestrator is already running is deferred, not skipped.
- Manage with `schedules list|add|remove|enable|disable` — run state lives
  in `state/schedules.json` (machine-owned).

## Coordination (Phase 10H) — `coordination` block + task fields

```json
"coordination": { "maxParallelMissions": 3, "lockPollMs": 10000, "staleLockMs": 3600000 }
```

- **Parallel missions**: `ai-orchestrator start projA projB` supervises
  both in one process (capped by `maxParallelMissions`). The first project
  owns `status.json`; the others write `state/status/<name>.json`.
- **Per-task coordination fields** (all optional):
  - `"resources": ["database", "shared-lib"]` — opaque lock names; the task
    waits until every one is free (cross-mission), locks them, and releases
    on completion. Stale locks (dead process / older than `staleLockMs`)
    are reclaimed automatically.
  - `"dependsOn": ["T1"]` — must name EARLIER tasks in the plan (validated;
    this also makes dependency cycles impossible).
  - `"approval": "<category>"` — approval gate before the task's first
    launch (see the approvals block above).
- **Cross-agent messages**: `ai-orchestrator agents message <project>
  --from coder --to tester --text "..."` (also `role:<role>` or `all`);
  unread messages appear in the recipient agent's next briefing. Handoffs
  between different agents post a note automatically.
- Inspect everything with `ai-orchestrator coordination <project>`.

## Release automation (Phase 10J) — `release` block

```json
"release": { "tagPrefix": "v", "approvalCategory": "commit" }
```

- `ai-orchestrator release prepare <project> <version>` writes
  RELEASE_NOTES.md, VERIFICATION_REPORT.md, and release.json under
  `state/releases/<project>/<version>/` from mission data. Edit them freely.
- `ai-orchestrator release apply <project> <version>` bumps the target's
  package.json, prepends the CHANGELOG entry, and creates a git commit +
  tag in the TARGET project. It never pushes.
- `approvalCategory` decides the gate: the default `commit` is automatic in
  balanced mode; set an owner-gate category (e.g. `production-deployment`)
  to require an explicit decision. An approval is consumed by exactly one
  apply.

## Core Service (Phase 12 M1) — `daemon` block

The Core Service (`ai-orchestrator serve`) is the always-running process that
owns the HTTP API, the inbound Telegram poll, the scheduler tick, and mission
worker lifecycle. **Nothing in this block affects `ai-orchestrator start`** —
a standalone mission never reads it.

```json
"daemon": {
  "enabled": true,
  "pollIntervalMs": 10000,
  "schedulerTickMs": 60000,
  "maxWorkers": 3,
  "workerScanMs": 10000,
  "restartFailedWorkers": false
}
```

- `enabled` — master switch. `false` makes `serve` refuse to start.
- `pollIntervalMs` — how often the service checks Telegram for owner replies.
  This runs whether or not a mission is waiting, which is the entire point of
  the service; it is deliberately slower than `approvals.decisionPollMs`
  (used *inside* a mission already parked on a decision).
- `schedulerTickMs` — how often due scheduled missions (Phase 10G) are
  checked. Due missions now start as supervised workers.
- `maxWorkers` — how many missions the service supervises at once.
- `workerScanMs` — how often worker liveness is re-probed and dead records
  reaped.
- `restartFailedWorkers` — off by default. The orchestrator already owns
  crash recovery *inside* a mission (`src/core/crashRecoveryEngine.js`), so
  daemon-level restarts would stack two recovery policies on one failure.

### Runtime state the service owns

| File | Meaning |
| --- | --- |
| `state/daemon.json` | The service's own record: pid, bound port, version. Separate from `state/heartbeat.json` **by design** — that file remains the standalone orchestrator's machine-wide lock, so a machine with no service behaves exactly as before Phase 12. |
| `state/workers/<project>.json` | One record per supervised mission. This is what makes several projects runnable at once. |
| `state/workers/<project>.stop` | A graceful stop request for one mission. A file rather than a signal because on Windows a cross-process `SIGTERM` is `TerminateProcess` — it would kill the mission instead of letting it archive a resumable session. |
| `state/daemon.stop` | The same mechanism for stopping the service itself. |

### Exclusive inbound polling

Only one process on a machine may consume Telegram updates: `getUpdates` is
offset-acknowledged, so a second poller permanently destroys the first one's
messages. When the service runs, it is that owner, and mission workers are
constructed with `receiveDecisions: false`. They still *publish* their own
approval requests (outbound is stateless) and still see decisions, because
`waitForDecision()` re-reads the shared approval store — the same
cross-process path the CLI and desktop have always used.

## Operator interface (Phase 12 M2) — `operator` block

The remote console the Core Service exposes on whichever channel it owns
(Telegram today). **Nothing in this block affects `ai-orchestrator start`** —
only `serve` reads it, and only for the channel it exclusively owns.

```json
"operator": {
  "enabled": true,
  "acceptFreeText": true,
  "minObjectiveChars": 12,
  "confirmationTtlMs": 300000,
  "requestTtlMs": 86400000,
  "progressIntervalMs": 15000,
  "progressUpdates": true,
  "progressMinIntervalMs": 60000,
  "projectRoots": []
}
```

- `enabled` — master switch for the widened command grammar. `false` leaves
  exactly the `v2.8.0` message set (`APPROVE` / `REJECT` / `MODIFY` / `DONE`
  and nothing else). Approvals are **never** gated by this: they predate the
  operator interface and are orthogonal to it.
- `acceptFreeText` — whether a plain sentence may raise a mission request.
  Free text never starts work under any setting; it can only ever produce a
  proposal you must explicitly approve. `false` answers prose with `/help`.
- `minObjectiveChars` — shortest message treated as an objective rather than a
  typo.
- `confirmationTtlMs` — how long a destructive-action code stays valid. A
  confirmation you forgot about must expire rather than sit there waiting to be
  triggered by an unrelated "yes" days later.
- `requestTtlMs` — how long a mission proposal stays approvable. A request
  approved a week late would run against a workspace that has moved on.
- `progressIntervalMs` — how often mission progress is re-derived from disk.
- `progressUpdates` — push real phase changes (Planning → Coding → Testing →
  Fixing) to the channel. Phases the mission itself already notifies about
  (approval required, complete, blocked) are recorded but never re-announced.
- `progressMinIntervalMs` — never more than one push per project per window,
  however fast the underlying state churns. A retry loop must not become a
  notification storm on a phone.
- `projectRoots` — roots under which a remotely-created project may live
  (Phase 12 M4). **Empty means remote creation is refused outright**, which is
  the default. Declared here now because the security posture is decided in the
  milestone that widened the inbound grammar, not in the one that uses it.

### The two gates between a message and a commit

Typing an objective raises a **mission request** (`M3`). It is inert: nothing
is queued, no worker starts, no file is written into your project.

Approving it writes a prompt under `state/operator/prompts/` (never inside your
repository), appends one task to the project's queue — the same mechanism
`tasks add` has used since P3 — and starts a supervised worker. That worker
plans first and stops at the existing Phase 10 **implementation review** (`A9`),
which carries the agent's real objective, duration, files, tasks, and risks.

Two approvals, two different questions: *do you want this at all?* and *do you
accept this plan?* Nothing estimates the size of a request before something has
actually read the code.

A mission is **refused** rather than silently lost when the project already has
a mission running (a live worker rewrites the queue) or when its current task is
`blocked`/`failed` (the next start cannot adopt the queue and would reseed it
from static config). Both cases say exactly how to clear them.

### Runtime state the operator interface owns

| File | Meaning |
| --- | --- |
| `state/events/events.jsonl` | The append-only event log — the record every interface reads. Rotated at 5 MB; archives kept beside it. |
| `state/operator/context.json` | Which project each channel currently has selected. Keyed by channel, so the phone and (later) the desktop keep their own cursor. |
| `state/operator/missions.json` | Mission requests and their decisions. |
| `state/operator/prompts/` | The prompt file each approved request became. |

Destructive-action confirmations are deliberately **in memory only**: a
five-minute conversational state, not a fact about the system. A service
restart should forget them, because your intent has not survived either.

## Environment notes

- Paths in JSON may use forward slashes (`C:/Users/...`) — recommended, as
  backslashes must be escaped (`\\`) in JSON.
- Config is read at startup. Restart the orchestrator (stop → start; the
  session resumes automatically) to apply changes.
- Validation runs before anything launches; errors name the file, the key,
  and the fix (`ai-orchestrator doctor` checks everything at once).
