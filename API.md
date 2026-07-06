# API Reference

Integration surfaces: the HTTP dashboard API, the plugin API, the driver
interface, and the verifier interface. (Programmatic library usage is
covered last.)

---

## 1. Dashboard HTTP API

JSON, served on `http://127.0.0.1:4711` by default (see `api` in
[CONFIGURATION.md](CONFIGURATION.md)). Built for the future desktop app,
equally useful for curl, scripts, and monitoring. Read-only endpoints
need no authentication (unchanged since P0); mutating endpoints (Phase
P7) require the local API token — see section 1b below.

| Endpoint | Returns |
| --- | --- |
| `GET /api/health` | `{ ok, pid, uptimeMs }` — liveness probe |
| `GET /api/status` | Live status (same data as `status.json`) |
| `GET /api/sessions` | All active session records |
| `GET /api/sessions/:project/history` | Finished sessions for a project |
| `GET /api/timeline/:project` | Mission timeline — key events over time |
| `GET /api/tasks/:project` | Phase P2: task queue (`null` for legacy/not-yet-run projects) |
| `GET /api/memory/:project` | Phase P5: notes/failures/task history (`null` if nothing recorded) |
| `GET /api/projects` | Defined projects + `hasActiveSession` flag |

### `/api/status` shape

```jsonc
{
  "orchestrator": { "state": "supervising", "pid": 22072, "uptimeMs": 3204, ... },
  "project": "my-project",
  "session": { "id": "…", "engineSessionId": "…", "state": "running", ... },
  "agent":   { "driver": "claude", "pid": 18324, "childPids": [22610], "state": "running" },
  "activity": {
    "currentTask": "Using tool: Bash",
    "lastOutputAt": "2026-07-04T14:27:50.183Z",
    "lastRestartAt": "…", "lastResumeAt": "…"
  },
  "counters":  { "runs": 6, "resumes": 5, "crashes": 0, "rateLimits": 4 },
  "rateLimit": { "waiting": false, "resumeAt": null, "estimatedWaitMs": null },
  "updatedAt": "…"
}
```

### `/api/timeline/:project` shape

An array of sparse, human-readable events (not every run — see
`state/ledger/<project>.jsonl` for the complete per-run audit trail, which
is not yet exposed over the API):

```jsonc
[
  { "at": "…", "event": "mission-started", "label": "Mission started" },
  { "at": "…", "event": "progress", "label": "Progress made (confidence: high)" },
  { "at": "…", "event": "rate-limit", "label": "Rate limit — waiting until …" },
  { "at": "…", "event": "resumed", "label": "Usage limit reset; resuming" },
  { "at": "…", "event": "complete", "label": "Mission complete" }
]
```

### `/api/tasks/:project` shape (Phase P2 — mission mode)

`null` for a legacy (single-prompt) project or one that hasn't run yet;
otherwise the persisted task queue. Each task's `lastVerifyResult`
(Phase P4) is the latest verification outcome — set on *every* attempt,
not just terminal ones — and is what the Continuation Builder reads to
tell the agent exactly which check failed on a retry:

```jsonc
{
  "project": "my-project", "sessionId": "…", "currentIndex": 1,
  "tasks": [
    { "id": "T1", "state": "done", "attempts": 1, "checkpoint": { "taskId": "T1", "outcome": "done", "filesTouched": ["src/index.js"], "verify": { "passed": true, "results": [...] }, "summary": "…" }, "lastVerifyResult": { "passed": true, "results": [...] } },
    { "id": "T2", "state": "active", "attempts": 1, "checkpoint": null, "lastVerifyResult": { "passed": false, "results": [{ "type": "file-exists", "passed": false, "detail": "Not found: out.txt" }] } }
  ]
}
```

### `/api/memory/:project` shape (Phase P5 — cross-session memory)

`null` for a project with nothing recorded yet; otherwise the persisted
memory record — see `src/memory/memoryStore.js`:

```jsonc
{
  "project": "my-project",
  "notes": [
    { "id": 1, "category": "architecture", "text": "always run npm run build first", "at": "…" }
  ],
  "failures": [
    { "id": 1, "category": "verification-failed", "reason": "…", "hint": "…", "taskId": "T2", "at": "…", "resolved": false }
  ],
  "taskHistory": [
    { "taskId": "T1", "outcome": "done", "attempts": 1, "summary": "…", "at": "…" }
  ]
}
```

### Progress ledger record shape (`state/ledger/<project>.jsonl`)

One line per run, the complete audit trail behind the timeline:

```jsonc
{
  "at": "…", "project": "…", "sessionId": "…", "run": 3,
  "cause": "completed", "exitReason": "progress",
  "progressed": true, "confidence": "high", "confidenceScore": 0.85,
  "confidenceSignals": ["git", "workspace-changed", "files-created"],
  "changes": { "created": 2, "modified": 1, "deleted": 0 },
  "changedFiles": { "created": ["a.txt", "b.txt"], "modified": ["c.txt"], "deleted": [] },
  "signature": "…", "signatureMethod": "git+scan",
  "consecutiveNoProgress": 0, "resultText": "…"
}
```

---

## 1b. Mutating endpoints (Phase P7)

Every endpoint here requires the local API token: `Authorization: Bearer
<token>`, or the `X-API-Token: <token>` header. Get the current token
with `ai-orchestrator api-token` (generated on first use, persisted at
`state/api-token.txt`); `--rotate` invalidates it and issues a new one.
A missing or wrong token — or no token configured at all — always
returns `401`.

| Endpoint | Body | Effect |
| --- | --- | --- |
| `POST /api/control/stop` | `{ reason? }` | Gracefully stops the live orchestrator (same mechanism as the CLI's `stop`) |
| `POST /api/tasks/:project/add` | `{ id, prompt, objective?, maxRuns?, verify? }` | Enqueues a validated task (mirrors `tasks add`) — `400` with `{ ok: false, problems: [...] }` on validation failure |
| `POST /api/tasks/:project/remove` | `{ taskId }` | Removes a PENDING task (mirrors `tasks remove`) |
| `POST /api/tasks/:project/reorder` | `{ taskId, direction: "up"\|"down" }` | Reorders a PENDING task (mirrors `tasks reorder`) |
| `POST /api/tasks/:project/approve` | `{ taskId }` | Resets a BLOCKED/FAILED current task to PENDING for the next `start` to retry |
| `POST /api/tasks/:project/skip` | `{ taskId, reason? }` | Marks a BLOCKED/FAILED current task DONE and advances past it |
| `POST /api/memory/:project/notes` | `{ category?, text }` | Records an operator note (mirrors `memory add`) |
| `POST /api/memory/:project/failures/:id/resolve` | *(none)* | Marks a recorded failure resolved (mirrors `memory resolve`) |

All except `/api/control/stop` return `{ ok: boolean, reason?: string }`
(or `{ ok: false, problems: [...] }` for `add`'s validation errors) with
HTTP status `200` on success, `400`/`404` on a rejected mutation — the
exact same result shape `TaskQueue`/`MemoryStore`'s own methods return,
since these routes call them directly. `/api/control/stop` returns
`{ ok: true }` on success, `503` if no live orchestrator is attached
(e.g. a `DashboardServer` built standalone for testing).

---

## 2. Plugin API

A plugin is a module at `plugins/<name>.js` or `plugins/<name>/index.js`:

```js
export default {
  name: 'my-plugin',
  version: '1.0.0',

  async initialize({ orchestrator, driverRegistry, config, logger }) {
    orchestrator.on('mission:complete', ({ project, summary }) => {
      logger.info(`(plugin) ${project} finished: ${summary}`);
    });
    // Optionally register a new AI engine:
    // driverRegistry.registerDriver('my-engine', MyEngineDriver);
  },

  async shutdown() { /* optional cleanup */ },
};
```

Plugins that throw during load or initialize are skipped and logged — they
can never take the supervisor down.

### Orchestrator events

| Event | Payload highlights |
| --- | --- |
| `session:launched` | `{ project, session, pid, resumed }` |
| `session:exit` | `{ project, session, verdict: {cause, detail}, exitInfo, exitReason }` |
| `session:progress` | `{ project, session, progressed, method, confidence, changes, exitReason }` |
| `mission:blocked` | `{ project, session, reason, category, reportPath }` |
| `session:rate-limited` | `{ project, session, resumeAt, waitMs }` |
| `session:network-error` | `{ project, session, retryInMs }` |
| `session:crashed` | `{ project, session, consecutiveCrashes, restartInMs }` |
| `session:resumed` | `{ project, session, note }` |
| `session:gave-up` | `{ project, session, reason }` |
| `session:recovered` | `{ project, session, after }` |
| `mission:complete` | `{ project, session, summary }` |
| `task:done` | Phase P2: `{ project, session, taskId, checkpoint }` |
| `orchestrator:recovered-after-reboot` | `{ project }` |

---

## 3. Driver interface

Implement `AIDriver` (`src/drivers/aiDriver.js`) to support a new engine:

```js
import { AIDriver, AgentRun } from '../src/drivers/aiDriver.js';

class MyEngineDriver extends AIDriver {
  constructor({ logger }) {
    super({ logger });
    this.id = 'my-engine';
    this.name = 'My Engine CLI';
    this.exitPatterns = {
      usageLimit: [/quota exhausted/i],   // engine's limit messages
      network:    [/connection lost/i],   // engine's network failures
    };
    // Optional: engine-specific "the agent is blocked" phrasings, checked
    // before the built-in generic patterns (src/core/blockedPatterns.js).
    this.blockedPatterns = [
      { category: 'permission-denied', pattern: /my-engine: permission refused/i,
        hint: 'Grant the permission this engine needs.' },
    ];
  }

  async checkInstallation(executable) { /* → {ok, version?|error?} */ }

  async launch({ project, prompt, engineSessionId }) {
    // Spawn the engine; return an AgentRun that:
    //  - emits 'engine-session-id' as soon as the conversation id is known
    //  - emits 'activity' with short "doing X" strings
    //  - emits 'output' for every chunk
    //  - calls run.finish({code, signal, outputTail, resultText?}) on exit
  }

  extractLimitResetTime(outputTail) { /* → Date | null */ }
}
```

Contract rules:

- `launch` must **never** kill or restart the engine on its own — lifecycle
  policy belongs to the orchestrator core.
- `AgentRun.requestStop(reason)` is the only sanctioned termination path,
  invoked solely for operator stops and shutdown.
- When resuming (`engineSessionId` set), the driver must continue that
  conversation (`claude --resume <id>` for Claude Code) and report the
  (possibly new) conversation id via `engine-session-id`.

---

## 4. Verifier interface (Phase P2 core; extended in P6)

Not plugin-extensible today — a task's `verify` entries must use one of
the built-in types (`file-exists`, `command`, `output-contains`,
`files-changed`, `json-schema`, `lint`, `dependency`; see
[CONFIGURATION.md](CONFIGURATION.md)). Documented here because P6 extended
this exact registry rather than replacing it — the interface below did
not change shape when the three new verifiers were added:

```js
// src/verify/verifiers/*.js — the shape every verifier implements
export const type = 'my-check';
export function run(config, context) {
  // config:  the verifier's own JSON config, e.g. { type: 'my-check', ... }
  // context: { workingDirectory, resultText, outputTail, changes }
  //          `changes` is the progress engine's full (untruncated) change
  //          facts for this run, or null on a mission's first run.
  return { passed: true, detail: 'Human-readable explanation' };
}
```

Registered in `src/verify/verifierRegistry.js`. A verifier that throws
fails only itself (`passed: false`, the thrown message as `detail`) —
never the orchestrator.

---

## 5. Library usage

```js
import { App } from 'ai-orchestrator';

const app = new App();
const result = await app.start({ projectName: 'my-project' });
// result: { complete: boolean, session, reason }
```

Lower-level building blocks (`Orchestrator`, `ClaudeDriver`,
`SessionManager`, `classifyExit`, …) are exported from `src/index.js` and
are all constructor-injected — see `test/orchestrator.test.js` for a
complete example of composing them with fakes. Phase P2's mission engine
is exported the same way: `TaskQueue`, `TaskState`, `isLegacyMission`,
`normalizeAndValidateTasks`, `validateSingleTask`, `buildCheckpoint`,
`runVerifiers` — see `test/orchestrator.p2.test.js` for a full mission-mode
composition example.

### `TaskQueue` runtime mutation (Phase P3)

The same methods the `tasks add/remove/reorder` CLI commands call:

```js
import { TaskQueue, validateSingleTask } from 'ai-orchestrator';

const taskQueue = new TaskQueue({ tasksDir, logger });
const queue = taskQueue.ensure('my-project'); // loads or creates empty

const { task, problems } = validateSingleTask(
  { id: 'T3', prompt: 'tasks/03-cleanup.md' },
  { label: 'task "T3"', workingDirectory, seenIds: new Set(queue.tasks.map(t => t.id)) }
);
if (problems.length === 0) taskQueue.enqueue(queue, task);

taskQueue.removeTask(queue, 'T3');       // -> { ok, reason? } — PENDING only
taskQueue.reorderTask(queue, 'T3', 'up'); // -> { ok, reason? } — PENDING only
```

See `test/orchestrator.p3.test.js` for a full example driving a real
mission purely from queued tasks (no static `tasks` in the project config).

### Continuation Builder (Phase P4)

Pure functions — given already-loaded state, they return a prompt string
and perform no I/O. The orchestrator calls these internally via
`buildContinuationPrompt()`; they're exported for anyone building tooling
around mission state (e.g. previewing what the next retry prompt will say):

```js
import { buildTaskContinuation } from 'ai-orchestrator';

const prompt = buildTaskContinuation({
  project, queue, task: queue.tasks[queue.currentIndex],
  reason: 'retrying task', recentRuns: progressLedger.recent(project.name, 3),
});
```

See `test/continuationBuilder.test.js` for the full behavior (including
the headline case: a failed verifier's specific detail message appears
in the next prompt) and `test/orchestrator.p4.test.js` for the real
supervision loop feeding a briefing into an actual driver launch.

### Memory (Phase P5)

```js
import { MemoryStore } from 'ai-orchestrator';

const memoryStore = new MemoryStore({ memoryDir, logger });

memoryStore.addNote('my-project', { category: 'architecture', text: 'build via npm run build' });
memoryStore.recordFailure('my-project', { category: 'x', reason: '…', hint: '…', taskId: 'T2' });
memoryStore.resolveFailure('my-project', 1); // -> { ok, reason? }

memoryStore.recentNotes('my-project');      // most-recent-first, capped
memoryStore.activeFailures('my-project');   // unresolved only, most-recent-first
memoryStore.taskHistoryFor('my-project', 'T2'); // archived prior attempts, oldest first
```

`Orchestrator` constructs its own `MemoryStore` from `paths.memoryDir` and
wires it into both the task queue (to archive history before a plan-shape
reinitialization) and `buildContinuationPrompt()` (to fold notes/failures/
history into every briefing) — nothing further to configure. See
`test/memoryStore.test.js` for the full unit-test surface and
`test/orchestrator.p5.test.js` for `block()` recording a failure and a
real continuation prompt carrying operator notes end-to-end.

### API auth (Phase P7)

```js
import { loadOrCreateToken, requireAuth } from 'ai-orchestrator';

const token = loadOrCreateToken(paths.apiTokenFile); // generates on first use
const token2 = loadOrCreateToken(paths.apiTokenFile, { rotate: true }); // invalidates the old one

app.post('/my-mutating-route', requireAuth(token), (req, res) => { /* ... */ });
```

`App` calls `loadOrCreateToken()` once at startup and passes the result
to `DashboardServer` as `apiToken`; `DashboardServer` applies
`requireAuth()` to every mutating route itself (see section 1b) — a
library consumer building their own server only needs these two
functions if they want the exact same token/middleware behavior
elsewhere. See `test/apiAuth.test.js` for the full behavior, including
the "no token configured always 401s" safe default, and
`test/dashboardServer.test.js` for real HTTP requests against every
mutating endpoint.
