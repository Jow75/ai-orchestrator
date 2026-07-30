# Phase 13 M9 — Engineering Acceptance Review

**Date:** 2026-07-30
**Trigger:** Owner-directed final engineering checkpoint before Phase 13 M9 (Public Release Prep), requested as a full acceptance review of Phases 12–13: repository state, architecture, capability matrix, live registry/workflow validation, Telegram UX, gap reconciliation, and release readiness — evidence-driven, nothing assumed.
**Method disclosure (read this before the rest of the document):** this review was run non-interactively, with no access to a real Telegram client. All "live" validation below used `node bin\ai-orchestrator.js operator "<message>"` — the CLI bridge documented in `src/cli/index.js:724-751` as running "the same path a phone message takes" through the real, currently-running Core Service (pid 3852, `v3.9.0`, started 2026-07-30T02:38:07 local). This exercises the real daemon, command router, event store, project registry, mission lifecycle, and file-access guard end to end. It does **not** exercise the Telegram transport layer itself (bot polling, Telegram's own message rendering, the physical phone UI). Where this document says "live-verified," that is the scope. Where it relies on prior sessions' actual Telegram round-trips, it cites the specific report making that claim rather than re-asserting it as this session's own finding.

**Incidental finding, disclosed immediately when found (not held for this report):** a diagnostic command run during this review printed the real Gmail SMTP app password from `config/local.json` to this session's output in plaintext (a redaction regex covered `token/key/secret/chatId` but missed the `pass` key). The file itself is git-ignored and was never committed (confirmed below), so this is not a repository exposure — but the value is now in this session's transcript. **Recommend rotating that Gmail app password.** This finding is carried into Part 8's risk register and is not repeated elsewhere in this document.

---

## Part 1 — Repository State

| Fact | Value |
| --- | --- |
| Current branch | `main` |
| Working tree | Clean (verified before and after all live testing in this session) |
| Latest commit | `dcd28a4` — "Reconciliation pass: classification migration, `/import all`, Safe Mode (v3.9.0)" |
| Local commits ahead of origin | 5 (`c2428f9..dcd28a4`, i.e. everything since the last push, which landed `v2.8.0`→`v3.7.0`) |
| Local tags | `v2.0.0-alpha.1` … `v3.9.0` (30 tags total; full Phase 0–13 history) |
| Pushed tags (on `origin`) | Up to `v3.7.0`. **`v3.8.0` and `v3.9.0` are tagged locally, not pushed.** |
| `package.json` version | `3.9.0` |
| `CHANGELOG.md` head entry | `## [3.9.0] — 2026-07-30 — Reconciliation pass...` — matches |
| `v3.9.0` tag target | `dcd28a4...` — matches `HEAD` exactly (verified via `git rev-list -n1 v3.9.0` vs `git rev-parse HEAD`) |
| `v3.8.0` tag target | `633f6c5` — matches its own commit ("Phase 13 M8...") |
| Untracked secrets check | `config/local.json` (holds the live Telegram bot token, chat id, and SMTP credentials) is **not tracked by git**; `ai-orchestrator---credentilas.txt` is also untracked and matched by `.gitignore` (`*credentilas*.txt`, `*credentials*.txt`) |

**Repository integrity: intact.** The reconciliation pass's own claims (5 commits ahead, `v3.9.0` == HEAD, working tree clean before it started) were independently re-verified in this session, not just re-read from its report — `git status`, `git log`, `git tag`, `git rev-list`, and `git ls-remote --tags origin` were all run fresh.

---

## Part 2 — Architecture State

Grounded in a direct source read of every subsystem below (not inferred from directory names), with file:line citations. `npx madge --circular` over `src/` found **zero circular dependencies** across 114 files. A grep for `TODO|FIXME|HACK|XXX` across `src/` found **zero hits** — this codebase documents known limitations as prose in the code, not marker comments (cited per-subsystem below).

| Subsystem | Files | What it actually does |
| --- | --- | --- |
| **Core Service / daemon lifecycle** | `src/daemon/daemon.js` (828 lines) | Composition root for the always-on process: owns the HTTP API, the *exclusive* Telegram inbound poll, the scheduler tick, worker lifecycle. Deliberately never runs a mission in-process — "an uncaught error inside a mission would take down the phone, the desktop and the scheduler at once" (`daemon.js:34-42`). `Orchestrator` (`src/core/orchestrator.js`, the per-mission launch/observe/recover loop) is a separate thing that only ever runs inside a forked worker, never the daemon itself. |
| **Worker supervision** | `src/daemon/workerSupervisor.js`, `workerRegistry.js` | Forks workers **detached** (`workerSupervisor.js:149-172` — an attached fork was found in live validation to die with the daemon on Windows). Stop prefers IPC, falls back to a stop-request **file**, never a cross-process signal (Windows maps `SIGTERM` to a hard `TerminateProcess` — this was caught live killing a mission mid-archive). `adoptExisting()` re-derives live workers from disk at boot so a daemon restart never orphans a mission. One-supervisor-per-project is checked in *both* the supervisor and the worker itself, "because a check that only exists in the caller is a check that a crash can skip." |
| **Project Registry** | `src/operator/projectRegistry.js` | Not a data store — a live aggregator. Identity/definition lives in `config/projects/*.json`; holder/pid tracking lives in `state/workers/*.json`; `describe()` stitches both together fresh on every call (plus lifecycle, task queue, approvals, a 30s-cached live `git` shell-out). Distinguishes `misconfigured` (bad config) from `missing` (folder vanished) on purpose — "a registry that reports 'unknown' is more useful than one that reports a confident fiction." |
| **Project Roots & discovery/scan** | `src/operator/projectDiscovery.js`, `src/config/defaults.js:370` | Walks configured roots one level deep, marker-probing to `maxDepth: 2`, treating `.git` as a hard boundary so it never recurses into a nested repo. Always excludes AI-Orchestrator's own install dir and every already-registered project path. Never cached — re-reads disk every call. **Finding:** the shared default (`defaults.js:370`) hardcodes `['C:\\Users\\Admin\\Music']` — this machine's actual path, not derived via `os.homedir()` — a leaked personal-environment value in code presented as general-purpose (fails soft if missing, but worth cleaning up before wider distribution). |
| **Provider (driver) abstraction** | `src/drivers/{aiDriver,driverRegistry,claudeDriver,cliDriver,mockDriver,simulation,capabilities}.js` | `AIDriver` is a genuine interface (`checkInstallation`, `launch`, an `AgentRun` event contract). `DriverRegistry` lazily builds one of `claude`/`mock`/`cli` per project, forwarding two closures (`defaultModelProvider`, `safeModeProvider`) to each. `simulation.js` exists specifically because of a real 2026-07-28 incident — a mock-driver project reported "Mission complete — verified" while writing nothing — and is now consumed consistently by the registry, mission cards, and the command router so that can't recur silently. |
| **Model abstraction** | `src/drivers/capabilities.js`, `claudeDriver.js:111-135`, `commandRouter.js:909-985` | No dedicated model registry class — a thin, consistent convention. An explicit per-project `claude.model` always wins over the machine-wide `/model` default. `capabilities.js` is **inert reference data only** — "nothing in this file gates or changes behaviour" — consulted just to validate `/model`/`/provider` input and render info. `/model` can only choose a *model*, not a *provider*; `defaultProvider` is effectively frozen at `claude` by design (undocumented as a limitation nowhere else, confirmed here). |
| **Mission workflow** | `src/mission/{missionLifecycle,missionPlan,taskQueue,checkpoint}.js`, `src/operator/missionRequests.js` | Two independent, chained gates for a remote mission: Gate 1 (typing something) only raises a proposal — "typing never starts work" — Gate 2 is Phase 10's pre-existing implementation-review flow (plan first, then code). An approved request becomes a real prompt file plus one task on the *same* `tasks add` mechanism the CLI has used since Phase P3 — explicitly "no worker code changes; no new execution path exists." `MissionLifecycle` tracks a 13-state machine end to end. |
| **Event Store** | `src/events/eventStore.js`, `eventTypes.js` | Append-only JSONL, refuses any event `type` outside a closed vocabulary — "a misspelled event that silently disappears... is a bug you find months later, if ever." Sequence numbers recover from the log's last line on restart. Rotates at 5MB; reads deliberately exclude archives so `/events` stays cheap. **Single-writer invariant:** only the daemon ever appends; workers write to disk and the daemon derives events from that — this is what keeps the sequence real. |
| **Telegram Operator Console** | `src/operator/commandRouter.js` (1533 lines), `commandGrammar.js`, `operatorGateway.js` | `OperatorGateway` is the single consuming reader of Telegram's offset-acknowledged inbound feed — a second reader would destroy the first's messages (enforced structurally, not by convention). `CommandRouter` is transport-agnostic by design ("it has never heard of Telegram") and wraps every command in try/catch, since an unhandled error here would take down the service's only remote surface over one malformed message. Destructive commands never execute on one message — routed through a `ConfirmationStore` requiring `/confirm <code>`. |
| **Remote File System** | `src/operator/fileAccess.js` | The single, centralized path-traversal guard in the codebase, reused by `/files`, `/file`, and `/download-project` — no second implementation exists anywhere. Two layers: textual containment (catches `../..`, absolute paths, Windows drive-relative paths, UNC paths) plus a real-path/symlink check (catches a symlink inside the project pointing outside it). Explicitly built *stronger* than the older, narrower-scope prompt-path resolution used for local task prompts (which only checks existence, not containment, because that input is trusted local config). |
| **Configuration system** | `src/config/{configManager,defaults,liveConfig}.js` | Deep-merges defaults ← `orchestrator.json` ← `local.json` (git-ignored, secrets), deep-cloning every branch specifically to stop a later live mutation from corrupting the shared defaults singleton in place — a real bug class this design defends against. `LiveConfigLayer.applyPatch()` is disk-first, all-or-nothing, and mutates the same in-memory object every subsystem already holds a reference to, so nothing needs telling to "reload." `LIVE_MUTABLE_PATHS` is a closed allowlist (roots, default model/provider, Safe Mode, notification min-severity, approval mode). **Finding:** `writeLocalConfig()` does an unlocked read-merge-write — two concurrent live-config mutations (e.g. a Telegram command racing a dashboard-API one) could race and lose a write. No file lock exists anywhere in the state layer; low real-world risk on a single-owner, serialized-poll system, but real. |
| **Notification pipeline** | `src/notifications/notificationEngine.js`, `channels/*.js` | Fans events out to every enabled channel via a static render table; two-tier severity filtering (global floor, per-channel may only raise it); idempotent (won't re-notify a still-pending approval just because a poll re-observed it); auto-excludes a channel from double-notifying when that same channel is also the active approval provider. Telegram sends split at the real 4096-char limit rather than truncating; real files are attached, never a Windows path a phone can't open. |
| **Checkpoint system** | `src/mission/checkpoint.js` (57 lines) | Narrower than it sounds — a pure function snapshotting *one task's* outcome (files created/modified/deleted, verification result, a truncated summary) onto that task's queue entry. Turning this into an agent-facing continuation prompt is explicitly a separate module's job (`continuationBuilder.js`) by the code's own design note. |
| **Mission persistence** | `sessionManager.js`, `taskQueue.js`, `workerRegistry.js`, `statePersistence.js` | Everything is atomic-write JSON (write-temp-then-rename, with orphaned-temp cleanup for a Windows `EPERM` rename race) or append-only JSONL. Three-case resume policy on restart: same-session-same-plan resumes as-is; same-session-different-plan restarts (archiving old history); no-session-but-idle-task adopts it. Repeated verbatim design mantra across modules: "files are the source of truth; IPC/memory is advisory." |
| **Operator permissions / approval gating** | `src/approvals/{approvalManager,approvalPolicy,approvalStore}.js`, `providers/telegramProvider.js` | Unrecognized approval categories **fail closed** to owner-gate, never open. Reuses an existing pending request for the same (project, task, category) rather than re-notifying on every stop/resume — a real duplicate-notification bug this fixed. Exactly one process may poll Telegram for inbound decisions (daemon only; workers always pass `false`) — same offset-destruction reason as the operator console. `TelegramApprovalProvider` hard-filters to the configured `chatId` before parsing anything — a stranger messaging the bot is dropped, unauthenticated by any other means. |
| **Safe Mode** | `defaults.js:393`, `liveConfig.js:30`, `claudeDriver.js:121-135`, `driverRegistry.js:35-44`, `app.js:117-121` | `ClaudeDriver.buildArgs()` is the actual enforcement point — when Safe Mode is on, it simply omits forwarding the permission flags, regardless of the project's own settings; explicitly "not a new safety mechanism, just a machine-wide way to force the one that already exists." Threaded as a closure read fresh per launch, but each worker snapshots config once at construction — an in-flight mission is provably unaffected by a later toggle, only the *next* worker observes it. This session's own live test (Part 4) independently confirmed this by filesystem mtime, not just by reading the code. Enforcement exists only for `ClaudeDriver`; `cli`-driver projects have no Safe-Mode-equivalent lever at all. |

### How these interact

The daemon is the composition root that owns every other subsystem and is the sole event-store writer; workers are separate OS processes that read config once and never talk to each other directly — they signal the daemon and each other only through files (worker registry, task queue, stop-request files) and, once forked, an IPC channel the daemon also treats as advisory, not authoritative. The Telegram console, the file-access guard, the approval gate, and Safe Mode are four independent trust-boundary mechanisms that compose rather than overlap: the console decides *what command was sent*, approvals decide *whether a write may happen*, the file guard decides *whether a path is reachable*, and Safe Mode decides *whether the underlying engine process itself is even capable of writing*, regardless of what the other three would otherwise allow.

### Remaining architectural weaknesses (newly surfaced by this pass, not previously tracked)

- **`defaults.js:370`** hardcodes this specific machine's `C:\Users\Admin\Music` path into the shared, version-controlled defaults rather than deriving it — a portability/cleanliness gap, not a functional bug (discovery fails soft on a missing root).
- **`configManager.js:310-318`**'s unlocked read-merge-write of `config/local.json` — a real, if narrow, race between two concurrent live-config mutations.
- **`src/api/apiAuth.js:44-55`** compares the dashboard API's bearer token with `!==`, not a constant-time comparison — a textbook timing side-channel, low real-world severity only because the API defaults to a `127.0.0.1`-only bind.
- **`commandRouter.js:426-427`** — a command present in the grammar table but not wired into the dispatch `switch` replies "recognized but not implemented. This is a bug" at runtime rather than failing at startup; the coupling between the grammar table and the handler switch isn't compiler-enforced.
- **Systemic swallow-and-log pattern** across every observability store (events, lifecycle, task queue, approvals, notifications) — a deliberate, repeatedly-stated tradeoff ("an observability failure must not disturb supervision"), but there is no alerting layer above the resulting `logger.warn` calls, so a failing disk degrades multiple stores silently, one log line at a time.

None of these are Critical or release-blocking (carried into Part 8's risk register with severity), and none contradict the 2026-07-29 consolidation review's "no design change required" verdict — every item above is a hardening/cleanup item on an already-sound structure, not a structural defect.

---

## Part 3 — Complete Capability Matrix

30 operator commands exist today (confirmed via live `/help`, cross-checked against `src/operator/commandGrammar.js`), plus the CLI-only surface (`projects`, `daemon`, `agents`, `schedules`, `release`, etc. — not remotely reachable, by design, except through `operator`). Evidence column key: **L** = live-verified this session via the operator CLI bridge, **P** = live-verified in a prior, cited milestone report (Telegram-verified), **T** = automated test coverage only (not live-exercised this session), **D** = documented/designed but not exercised either way this session.

| Capability | Implemented | Validated live | Regression tested | Notes / limitations |
| --- | --- | --- | --- | --- |
| Project discovery (`/scan`) | Yes | P (reconciliation pass, 17/17 real candidates, 0 false pos/neg) | Yes (`projectDiscovery.test.js`) | Depth-bounded (2 levels), not entry-count-bounded — untested past ~20 real folders (disclosed gap, not a defect at current scale) |
| Project import (`/import`, `/import all`) | Yes | P (reconciliation pass: 6→23 projects, one batch confirm) | Yes (`commandRouter.test.js` +3 for `/import all`) | Registry-only, never touches files (verified by design and by this session's own `/import`-adjacent file-mtime check on `calculator-proof`) |
| Project archive/restore/hide/unhide/forget | Yes | Not live-exercised this session | Yes (`projectLifecycleOps.test.js`) | — |
| Project classification | Yes | P (reconciliation pass: 6/6 projects, table matched `v3.3.0`'s exactly) | Yes | Never auto-applied — proposal + one batch confirmation |
| `/project` (select active) | Yes | **L** — selected `THE FINISHER`, `Youtube Downloader`, `Invisble Highlighting_SNAPSHOT_...`, `Parakeet - AI`, `calculator-proof` this session | Yes | Per-channel context, persists across commands |
| `/status` | Yes | **L** — all 5 named projects above | Yes | Correctly distinguishes Idle / Misconfigured / Running / Waiting-for-you |
| `/files` | Yes | **L** — `THE FINISHER` (82 entries, paginated 3 pages) and `calculator-proof` (9 entries, 1 page) | Yes (`fileAccess.test.js`) | Lists dotfiles including `.env` — see Part 8 risk register |
| `/file <path>` | Yes | **L** — `README.md` (683 B, inline) and `B8_GRADING_FIX_DESIGN.md` (5.9 KB, sent as attachment) on real projects | Yes | Inline/attachment threshold confirmed to actually switch behavior, not just documented |
| `/download-project` / `/download_project` | Yes | **L** — `calculator-proof`, 129.9 KB / 13 files, real zip written to `state/operator/downloads/` | Yes (+ P: M6 report, zip verified by actual extraction) | Excludes `node_modules`/`.git`/build output |
| `/provider`, `/model` | Yes | Not live-exercised this session (no provider/model switch attempted — out of scope for this pass, no reason to believe it regressed) | Yes (`driverRegistry.test.js`, capabilities tests) | Isolated from in-flight missions by construction (worker reads config once, at fork) |
| `/safemode on\|off` | Yes | **L** — toggled on before mission testing, confirmed forced headless-read-only via a real mission + direct filesystem mtime check, toggled back off after | Yes (`claudeDriver.test.js` +4, `commandRouter.test.js` +6) | Scoped to `ClaudeDriver` only, by design |
| Mission request (typed text → proposal) | Yes | **L** — `M10` created on `calculator-proof`, "typing never starts work" confirmed (proposal-only until `APPROVE`) | Yes (`missionRequests.test.js`) | Gate 1 shows only measured history, never invents an estimate |
| Mission approval (two-gate: request + implementation review) | Yes | **L** — `APPROVE M10` (started planning) then `APPROVE A30` (implementation review) both round-tripped for real | Yes (`missionLifecycle.test.js`, `approvalManager.test.js`) | Second gate (`A30`) is the pre-existing Phase 10 review flow, unchanged |
| Mission execution | Yes | **L** — real worker forked (pid 20736), real `mission.progress` events, `Phase: Coding` observed mid-run | Yes | Safe Mode correctly prevented any real write — confirmed by direct filesystem `mtime` check on `calculator-proof`, not just by trusting the reply text |
| Mission completion | Yes | **L** — `mission.completed`/`worker.completed` events fired, status returned to Idle, 2/2 tasks done | Yes (`missionCard.test.js`) | Real side effect: this session's completion likely fired a real Telegram + email notification (both channels are live-enabled) — disclosed above |
| Mission cancellation | Yes | Not exercised this session (would have interrupted the one live mission run) | Yes (`missionRequests.test.js`) | — |
| Artifact reporting (created/modified/deleted, footer commands) | Yes | Not independently re-verified this session's own run produced a card (Safe Mode means "no files changed" was the correct, if less illustrative, outcome) | Yes + P (M7 report: real `filesCreated`/`filesModified`, footer commands tapped live against a real mission) | — |
| Project switching mid-session | Yes | **L** — switched active project 5 times across this session (`calculator-proof` → `THE FINISHER` → `Youtube Downloader` → `Invisble Highlighting...` → `Parakeet - AI` → `calculator-proof`) | Yes | Context correctly persisted and updated each time |
| Telegram command menu (`setMyCommands`) | Yes | P (M8 report: real daemon restart, real `/help` round trip) | Yes (`commandMenu.test.js`) | Not re-exercised this session (no daemon restart performed) |
| Long message splitting | Yes | Not exercised this session (no output long enough to trigger it) | Yes (`telegramSplit.test.js` — adversarial boundary/tag/entity tests) + P (M1 report: real 7,091-char message) | — |
| Startup persistence / reboot survival | Yes | Not exercised this session (would require a real reboot) | Yes | P (PROJECT_CONTEXT: real Windows Restart, 11/11 script checks passing) |
| Crash recovery | Yes | Not exercised this session | Yes (`workerExit.test.js`, `crashRecoveryEngine.test.js`) | — |
| Safe Mode | Yes | **L** — see mission execution row; this is this session's own primary live-validation vehicle | Yes | Deliberately scoped to `ClaudeDriver` only |
| Event store (`/events`) | Yes | **L** — read repeatedly throughout this session as the audit trail for every other live test | Yes (`eventStore.test.js`) | — |
| `doctor` | Yes | **L** — full run, correctly flagged all 19 misconfigured projects with the same reason each time | Yes | — |

**Full automated regression suite, run fresh in this session:** `1194/1194` backend (`npm test`) + `41/41` desktop (`npm run test:desktop`) = **1235/1235**, zero failures, zero skips.

---

## Part 4 — Registry Validation

The registry reports **23 projects** — independently confirmed three ways this session: `ls config/projects/*.json` (23 files), the live `/projects all` command, and `doctor` (which enumerated the same 23 names). This is not a single unverified assertion.

**Named projects requested for spot-check, real-project mapping:**

| Requested name | Actual registry entry | Result |
| --- | --- | --- |
| THE FINISHER | `THE FINISHER` | **Fully functional.** Real git repo at `C:\Users\Admin\Music\The Finisher`, branch `master` (uncommitted changes), real commit shown, `/files` paginated correctly (82 entries / 3 pages), `/file` correctly sent a 5.9 KB file as an attachment |
| Invisible Highlight | `Invisble Highlighting_SNAPSHOT_2026-06-01_01-27-44` (note: real registry name has a typo, "Invisble") | **Misconfigured — reproducibly.** `/project`, `/status`, and `/files` all returned the identical, correct error: `"promptFile" is required` |
| AI Orchestrator | *(does not exist in the registry — see below)* | **N/A, correctly so** |
| Calculator Pro | `calculator-proof` | **Fully functional**, and used as this session's full mission-cycle test subject (see Part 5) |
| YouTube Downloader | `Youtube Downloader` | **Misconfigured — reproducibly**, same missing-`promptFile` error as above |
| Parakeet AI | `Parakeet - AI` | **Misconfigured — reproducibly**, same missing-`promptFile` error as above |

**On "AI Orchestrator" as a project:** it does not appear in the registry, and it should not — `/scan`'s own discovery correctly self-excludes AI-Orchestrator's own checkout (confirmed in the M2 report and re-confirmed by its absence from all 23 `config/projects/*.json` files). Asking it to manage itself as a supervised project is outside the tool's design; flagging this rather than fabricating a result.

**Why three of the five behave differently, with evidence, not assumption:** a direct count — `grep -lc promptFile config/projects/*.json` — shows only **4 of 23** registered projects have a `promptFile` set (`calculator-proof`, `THE FINISHER`, `example`, `phone-demo`). The other 19, including three of the five names requested here, are the projects the reconciliation pass's `/import all` registered in a single batch on 2026-07-30 — `/import` (single or batch) has only ever written `{driver, workingDirectory}` to the registry; it deliberately never invents a mission. This is documented, expected behavior (`/import`'s own reply text says so: *"It has no mission yet — add a promptFile... before starting it"*), not a defect. It does mean: **"23 projects registered" and "23 projects ready to run a mission" are different claims** — worth stating plainly for release messaging (see Part 8).

**Full-cycle mission validation (per the owner's scoped decision — one project, not all six):** run against `calculator-proof`, with Safe Mode forced on first. Mission request → two-gate approval → real worker execution → completion → event trail, all live and all verified by more than the tool's own reply text:

1. `Summarize what is in this project. Do not modify any files.` → **M10** created (`mission.created` event); reply confirmed "typing never starts work."
2. `APPROVE M10` → real worker forked (pid 20736); `mission.started`, `mission.progress` events followed.
3. Implementation-review gate **A30** appeared mid-run (`approval.required`); `APPROVE A30` → `mission.progress` → `mission.completed` → `worker.completed`.
4. Status returned to `💤 Idle`, `Phase: ✅ Finished`, `2/2 tasks done`.
5. **Independent proof, not just trusting the reply:** every file under `C:\Users\Admin\Music\calculator-proof` was checked with `find ... -newer package.json` — zero files modified since before this session started. Safe Mode's guarantee (headless-read-only regardless of the project's own `acceptEdits` permission mode) held under a real, non-mock mission.

---

## Part 5 — Remote Engineering Workflow

Walked the requested arc directly, live, this session: `/projects` → `/project calculator-proof` → mission request → `APPROVE` (gate 1) → execution → `APPROVE` (gate 2) → completion → `/events` inspection → `/download-project` → `/project <other>` (repeated across 5 different real projects) → `/safemode` toggle around the whole thing.

**The workflow is coherent end to end.** Every step's reply text correctly set up the next step (mission request told me the exact `APPROVE M10` string to send; the implementation-review gate told me `APPROVE A30`; completion returned to a normal `/status`-able idle state). No step required out-of-band knowledge not given by the previous step's own output.

**Friction points actually observed (not redesigned, just identified, per instruction):**

1. **Two-gate approval has no visible "why."** `M10`'s first-gate reply shows only measured history (average run time, task count) — by design, per the project's own "no invented estimates" rule (`PROJECT_CONTEXT.md`'s "THE HONESTY CONSTRAINT" section). This is a deliberate, disclosed trade-off, not an oversight, but it does mean an operator approving Gate 1 is approving "let it look," not "let it do X" — the actual plan only appears at Gate 2.
2. **`/status` and `/files` on a misconfigured project return the same one-line error with no next action beyond a stack-trace-free message.** It correctly tells you *what's* wrong (`"promptFile" is required`) but not *how* to fix it remotely — there is no `/set promptFile <path>` or equivalent; fixing it requires hand-editing `config/projects/<name>.json` outside the operator interface entirely, which is a real gap for a "fully remote" workflow given 19 of 23 real projects are in this state today.
3. **Project names with spaces and punctuation** (`Parakeet - AI`, `Invisble Highlighting_SNAPSHOT_2026-06-01_01-27-44`) are correctly handled by the command parser (verified live — no quoting or escaping was needed), but they are long enough that a phone-typed `/project Invisble Highlighting_SNAPSHOT_2026-06-01_01-27-44` is real, tedious typing on a touchscreen. No fuzzy-match or numbered-list-selection alternative exists today.
4. **No visible progress percentage or ETA during execution**, only phase labels (`⌨️ Coding`) and elapsed time — this is a documented, deliberate design choice (`PROJECT_CONTEXT.md`: "no percentages anywhere"), not a gap, but worth naming since it's the kind of thing a new operator might expect and not find.

---

## Part 6 — Telegram UX Review

*(Grounded in this session's live command output plus the 2026-07-29 consolidation review's dedicated six-surface UX pass, re-checked rather than re-derived from scratch where it already answered the question.)*

- **Discoverability:** `/help` (live-verified this session) groups all 30 commands into 7 labeled categories with one-line descriptions each — a real improvement over a flat list, per M8. No command exists that isn't in `/help`.
- **Navigation:** `/project <name>` sets durable per-channel context; every subsequent command implicitly targets it. Confirmed live across 5 project switches this session with no state leakage between them.
- **Command consistency:** verb-first, consistent shape (`/verb [project]`) across the whole surface; the one deliberate asymmetry (`APPROVE`/`REJECT`/`MODIFY`/`DONE` use a bare decision grammar, not a `/` prefix) is documented in `/help`'s own footer ("Decision grammar: APPROVE A7 · REJECT A7...").
- **Confirmation flow:** destructive/batch actions (`/import all`, `/safemode`, archive/forget) use a `ConfirmationStore` code (`/confirm <code>`) — live-verified in the reconciliation pass, not re-tested this session to avoid a redundant registry mutation.
- **Error messages:** consistently plain-language, no stack traces surfaced to the operator in any test this session (misconfigured-project errors, out-of-scope file-access refusals per the M6 report).
- **Pagination:** `/files` on an 82-entry real directory correctly paginated (3 pages, "Page 1/3 · 82 entries total") rather than dumping or truncating — live-verified this session.
- **Large file handling:** confirmed live this session — a 683 B file inline, a 5.9 KB file as a document attachment; per the M6 report the ceiling is Telegram's real 50 MB document limit, with size pre-estimated and a refusal (not a silent failure) above a configurable cap.
- **Multi-project workflow:** switching between 5 real, differently-configured projects in sequence this session produced zero cross-contamination or stale-state carryover.

**Real, material improvement not yet built** (carried forward from the consolidation review, re-confirmed still true by this session's own `doctor` output): **no remote way to fix a misconfigured project.** Given 19 of 23 real projects are missing `promptFile` today, the single highest-value UX addition for actual daily use is not a new read-only command — it's *something* that closes the loop on the state this review found most projects sitting in. Everything else recommended below is smaller than this.

**Recommendations meeting the "materially improves engineering productivity" bar (documented, not built):**
1. A remote way to attach a `promptFile` to an already-imported project (closing the gap directly above).
2. `/git [project]` and `/log [project] [n]` — both already scoped and risk-assessed in the 2026-07-29 consolidation review, still not built as of this session.

Not recommended: fuzzy project-name matching or a numbered picker (friction point #3 above) — real but minor next to the two items above, and not requested by the owner's UX questions.

---

## Part 7 — Remaining Gaps

Reconciled against the 12 numbered owner directives from 2026-07-28 (gating Phase 12 M4) and the Phase 13 plan.

### Completed
1. Repo audit before public push (2026-07-28 audit; PII/secrets sweep repeated 2026-07-29 for all Phase 13 commits through `v3.7.0`)
2. Configurable Project Roots (M2, `v3.2.0`)
3. Project lifecycle states + classification (M3, `v3.3.0`; migration executed 2026-07-30)
4. Remote model management, isolated from in-flight missions (M5, `v3.5.0`)
5. Provider abstraction (M5, `v3.5.0`)
6. Remote file inspection — `/files`, `/file` (M6, `v3.6.0`)
7. Whole-project export — `/download-project` (M6, `v3.6.0`)
8. Richer mission-completion messages (M7, `v3.7.0`)
9. Root-caused message truncation (M1, `v3.1.0` — shipped first despite being directive #9)
10. Bot command discoverability (M8, `v3.8.0`)

### Partially completed
11. **Remote configuration** — roots, provider, model, and Safe Mode are all remotely configurable (`/roots`, `/provider`, `/model`, `/safemode`, all live-verified across this project's history and, for Safe Mode, in this session). **Notification preferences and approval mode are not** — both remain CLI/config-file-only (`notify tune`, `notify setup`, hand-edited `config/local.json`); no equivalent operator-channel command exists. Confirmed by the full 30-command grammar list containing no `notify`-family or `approval-mode`-family entry.
    - *Where it belongs:* Phase 14, as a small additive command pair, matching the pattern `/safemode` already established for turning a config-file/CLI-only knob into a live Telegram one.
    - *Blocks release:* No — this is a capability gap in an already-shipped directive, not a defect, and the underlying settings are still fully configurable (just not from a phone).

### Deferred
- **Phase 12 M4 (Launch Experience & Remote Project Creation)** — deferred by the owner's own 2026-07-28 direction to do Phase 13's architecture pass first; re-confirmed still deferred in the 2026-07-30 reconciliation pass. *Belongs in:* Phase 14 planning (per the owner's own instruction, folded in rather than resumed standalone). *Blocks release:* No — it was never promised for this release; deferral is itself the owner's decision, not a slip.
- **`/git [project]`** (branch/dirty/recent commits) — identified as a real, concrete gap in the 2026-07-29 consolidation review; still not built. *Belongs in:* Phase 14 (already scoped there per that review's own recommendation). *Blocks release:* No — `/status` already shows branch and dirty state; only commit history is missing.
- **`/log [project] [n]`** (tail the real log file) — same review, same status. *Belongs in:* Phase 14. *Blocks release:* No — `/events` covers structured events; only raw log-file tailing is absent.
- **A remote way to set a missing `promptFile`** — newly identified in *this* review (Part 6), not previously tracked. *Belongs in:* Phase 14, and arguably the highest-value item in it given 19/23 real projects need it today. *Blocks release:* No — the CLI path (`projects add`, hand-editing the JSON) still works; this is a remote-completeness gap, not a broken feature.
- **Per-test failure detail in mission completion** — flagged as a nice-to-have in the 2026-07-29 review, unchanged. *Belongs in:* a future milestone, low priority. *Blocks release:* No.
- **A daemon-level watchdog beyond OS `RestartCount`** — flagged 2026-07-29, unchanged. *Belongs in:* future, low priority, "belt-and-suspenders." *Blocks release:* No.
- **Project-discovery caching/entry-count bound** — flagged 2026-07-29 as a watch-item at current scale (~20 real folders), unchanged. *Belongs in:* only if `Music` grows to hundreds of entries. *Blocks release:* No.

---

## Part 8 — Release Readiness

**Can AI-Orchestrator be used as a real remote engineering platform today?** Yes, for its actual, current scope: supervising Claude Code missions on projects that already have a defined mission (`promptFile`), with full remote visibility (status, files, events, artifacts) and a mandatory two-gate approval discipline before any write. That scope was exercised live, for real, in this session — not asserted from documentation.

**Would I personally trust it to manage projects remotely?** For the 4 projects that are actually mission-ready today (`calculator-proof`, `THE FINISHER`, `example`, `phone-demo`) — yes, with Safe Mode as the on-ramp for anything unfamiliar, exactly as it's designed to be used. For the other 19 — not yet, simply because there's no mission defined for them yet, which is a data-completeness state, not a trust question.

### Risk register

| Risk | Severity | Blocks release? |
| --- | --- | --- |
| Plaintext secrets at rest in `config/local.json` (Telegram bot token, chat id, Gmail app password) — confirmed never committed to git, but readable by anything with local filesystem access, and this session's own diagnostic command accidentally echoed the SMTP password to its output | **High** (operational, not a code defect) | No — pre-existing, disclosed, git-ignored; but **the owner should rotate the Gmail app password now**, since this session's transcript now contains it |
| `/files` lists dotfiles including `.env` by name/size (contents require a separate `/file .env` call, still guarded by the same path-traversal check, but the *existence and size* of secrets files is visible to anyone with operator access) | Medium | No — by design, matches "list everything under the project root" scope; worth an explicit product decision on whether sensitive-filename patterns should be scrubbed from `/files` output specifically (not `/file`, which already requires an explicit, logged read) |
| 19/23 registered projects are not mission-ready (no remote fix path) | Medium | No — documented, expected state; becomes a real UX debt item as the registry grows |
| No git commit-log/diff visibility (`/git`), no raw log tailing (`/log`) | Low | No — `/status` and `/events` cover the adjacent ground |
| No daemon watchdog beyond OS-native restart limits | Low | No — real gap, narrow edge case (3 consecutive crash-loop restarts within Task Scheduler's window) |
| Project-discovery has no cache/entry-count bound | Low | No — untested past current real scale (~20 folders), not a defect at that scale |
| Remote config gap: notification prefs / approval mode not Telegram-settable | Low | No — CLI path fully functional |
| `src/api/apiAuth.js:44-55` compares the dashboard API bearer token with `!==`, not constant-time | Low | No — API defaults to a `127.0.0.1`-only bind; a real risk only if that default is ever changed |
| `configManager.js:310-318` unlocked read-merge-write of `config/local.json` — two concurrent live-config mutations could race and lose one write | Low | No — single-owner system, Telegram poll is already serialized; narrow window |
| `defaults.js:370` hardcodes this machine's real path (`C:\Users\Admin\Music`) into shared, version-controlled defaults | Low | No — fails soft on a missing root; a portability/cleanliness item before wider distribution, not a functional defect |
| `commandRouter.js:426-427` — a grammar-table command not wired into the handler switch fails at runtime with a "this is a bug" reply, not at startup | Low | No — defensive fallback already in place; just not compiler-enforced |

**No Critical-severity issue was found in this review**, live-tested or otherwise. **Nothing found here blocks Phase 13 M9 or a public push.**

---

## Part 9 — Phase 13 M9: Public Release Preparation

See the companion deliverables produced alongside this document:
- Release checklist and sign-off: below.
- `CHANGELOG.md` — no code shipped this pass, so no new version entry; `v3.9.0`'s existing entry already reflects the true HEAD.
- `PROJECT_CONTEXT.md` — updated to record M9's completion (see diff in the commit this review is part of).
- `docs/PHASE_13_PLAN.md` — M9 marked done, pointing at this report.

### M9 checklist (per `docs/PHASE_13_PLAN.md`'s own M9 definition: "repeats exactly the process just run for `v3.0.0`")

- [x] Full regression: **1194/1194 backend + 41/41 desktop**, run fresh in this session.
- [x] `docs/` staleness audit: `README.md`'s command table, `docs/QUICKSTART.md`'s 10-step walkthrough, and `docs/OPERATOR_CONSOLE.md` (already refreshed by the reconciliation pass with a correct "last audited"/command-count line) spot-checked against the real, live command surface exercised in this session — no stale claims found.
- [x] CHANGELOG finalized: head entry is `3.9.0`, matches `package.json`, matches the real `HEAD` commit.
- [x] Tags verified: `v3.9.0` → `dcd28a4` == `HEAD`; `v3.8.0` → its own correct commit; both confirmed by direct `git rev-list`/`git rev-parse`, not assumed.
- [x] Push readiness assessed: **not pushed** — 5 commits and 2 tags (`v3.8.0`, `v3.9.0`) sit ahead of `origin/main` (last pushed at `v3.7.0`). Per this project's own standing rule (every prior push required explicit owner go-ahead), **this document does not push anything.**
- [x] Presented for approval: this document is that presentation.

### Final engineering sign-off

Phase 13 M9 is **complete as a process checkpoint**. No blocking issue was found across repository integrity, architecture, the full capability matrix, live registry/workflow validation, or Telegram UX. The gaps in Part 7 are real but are additive, documented, and already correctly triaged into Phase 14 rather than silently dropped. **Phase 13 is officially complete**, pending the owner's own go-ahead to push `main` + `v3.8.0` + `v3.9.0` to `origin` — a decision this document deliberately does not make on the owner's behalf.

---

## Part 10 — Phase 14 Planning

See `docs/PHASE_14_PLAN.md` (produced alongside this document, planning only, no code).
