# API Reference

Three integration surfaces: the HTTP dashboard API, the plugin API, and the
driver interface. (Programmatic library usage is a fourth — see the bottom.)

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

## 4. Library usage

```js
import { App } from 'ai-orchestrator';

const app = new App();
const result = await app.start({ projectName: 'my-project' });
// result: { complete: boolean, session, reason }
```

Lower-level building blocks (`Orchestrator`, `ClaudeDriver`,
`SessionManager`, `classifyExit`, …) are exported from `src/index.js` and
are all constructor-injected — see `test/orchestrator.test.js` for a
complete example of composing them with fakes.
