# API Reference

Integration surfaces: the HTTP dashboard API, the plugin API, the driver
interface, and the verifier interface. (Programmatic library usage is
covered last.)

---

## 1. Dashboard HTTP API

Read-only, JSON, served on `http://127.0.0.1:4711` by default (see
`api` in [CONFIGURATION.md](CONFIGURATION.md)). Built for the future web
dashboard, equally useful for curl and monitoring.

| Endpoint | Returns |
| --- | --- |
| `GET /api/health` | `{ ok, pid, uptimeMs }` — liveness probe |
| `GET /api/status` | Live status (same data as `status.json`) |
| `GET /api/sessions` | All active session records |
| `GET /api/sessions/:project/history` | Finished sessions for a project |
| `GET /api/timeline/:project` | Mission timeline — key events over time |
| `GET /api/tasks/:project` | Phase P2: task queue (`null` for legacy/not-yet-run projects) |
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
otherwise the persisted task queue:

```jsonc
{
  "project": "my-project", "sessionId": "…", "currentIndex": 1,
  "tasks": [
    { "id": "T1", "state": "done", "attempts": 1, "checkpoint": { "taskId": "T1", "outcome": "done", "filesTouched": ["src/index.js"], "verify": { "passed": true, "results": [...] }, "summary": "…" } },
    { "id": "T2", "state": "active", "attempts": 1, "checkpoint": null }
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
`files-changed`; see [CONFIGURATION.md](CONFIGURATION.md)). Documented here
because P6 extends this exact registry rather than replacing it:

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
`normalizeAndValidateTasks`, `buildCheckpoint`, `runVerifiers` — see
`test/orchestrator.p2.test.js` for a full mission-mode composition example.
