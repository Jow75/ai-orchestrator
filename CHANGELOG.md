# Changelog

All notable changes to AI-Orchestrator are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/) · Versioning: [SemVer](https://semver.org/).

## [3.13.0] — 2026-07-30 — Phase 14 M2: Log Visibility

Answers "what actually happened, in the system's own words" from a phone —
distinct from `/events`' structured internal record, this tails the real
text log every daemon and mission-worker process writes to. Full design
tradeoffs, including the one real naming collision found and fixed before
shipping, recorded in `docs/PHASE_14_PLAN.md`'s M2 section.

### Added

- **`/log [project] [page]`** (`src/operator/commandRouter.js`,
  `renderLogTail()` in `render.js`) — tails the real `logs/orchestrator-
  *.log` file, newest line first: timestamp, severity icon, and message per
  line, filtered to the lines that project's own activity tagged. Paginated
  exactly like `/files` (a trailing bare number is a page only once a
  project name already precedes it). Read-only, no approval gate, matching
  `/git`/`/status`. Kill switch: `operator.log.enabled`.
- **`src/operator/logVisibility.js`** — `latestLogFile()` (picked by mtime,
  not an assembled date string, so a read moments after midnight still
  finds yesterday's real file) and `readLogTail()` (parses the winston
  JSON-lines format `src/infra/logger.js` writes, filters by the `project`
  field individual log calls already attach, paginates).

### Fixed

- **A real naming collision, caught before it shipped:** `log` was already
  a live alias for `/events`, dating to Phase 12 M2. Since `/log` and
  `/events` read genuinely different things (raw text log vs. structured
  event log) and this milestone's own command needed the name, the alias
  is retired — `/events` keeps `activity`; `/log` gets its own alias,
  `logs`.

### Regression coverage

- `logVisibility.test.js` (new, 10 tests, against a real throwaway log
  directory), `commandRouter.test.js` (+8). 1240 → 1258 backend tests, zero
  regressions. 41/41 desktop tests unaffected. Live-validated against the
  real Core Service and real project history (`calculator-proof`) through
  the CLI operator bridge: real timestamps, real severities, real
  pagination across 44 real log lines.

## [3.12.0] — 2026-07-30 — Phase 14 M1: Git Visibility

Answers "what state is this repo actually in" from a phone, without a
terminal. Kept intentionally narrow per the milestone's own scope: branch,
dirty/clean state, HEAD, recent commit subjects, and (when tracked)
ahead/behind — no diff, no file contents, no history browsing. Full design
tradeoffs recorded in `docs/PHASE_14_PLAN.md`'s M1 section.

### Added

- **`/git [project]`** (`src/operator/commandRouter.js`, `renderGitStatus()`
  in `render.js`) — repository check, branch, dirty/clean state (with a
  changed-file count), HEAD (short hash + subject), up to 8 recent commits,
  and ahead/behind the branch's own upstream when one is configured
  (reported honestly as "not tracked" rather than a fabricated 0/0).
  Read-only, no approval gate, matching `/status`. Kill switch:
  `operator.git.enabled`.
- **`/git dirty`, `/git clean`** — every registered project in that git
  state, across the whole registry, not just the active project. Reuses
  `ProjectRegistry.list()`'s already-computed `git.dirty` field (the same
  one `/workspace`'s clean/dirty counts sum) rather than re-shelling out —
  same reserved-keyword-before-project-name precedent `/projects classify`
  and `/mission all` already established.
- **`src/operator/gitVisibility.js`** — the real `git`-shelling module
  behind the single-project view (`gitReport()`). Kept separate from
  `progress/progressEngine.js`'s own `gitBranch`/`gitDirty`/etc., which
  exist to feed mission-progress snapshots, not the operator console, and
  don't compute a changed-file count, a batch of recent commits, or
  ahead/behind. Uses `configManager.getRawProject()`, not `getProject()`,
  so it works uniformly across every registered project regardless of
  mission-readiness — the same reasoning `commandWorkspace()` (M0) already
  applies.

### Regression coverage

- `gitVisibility.test.js` (new, 7 tests, against real throwaway git work
  trees — no mocking of `git` itself), `commandRouter.test.js` (+8). 1225 →
  1240 backend tests, zero regressions. 41/41 desktop tests unaffected.

## [3.11.0] — 2026-07-30 — Phase 14 M0: Workspace Overview

The first Phase 14 milestone in its own numeric order (M9 shipped first, per
an explicit owner priority call). Answers "how is the whole portfolio doing"
without opening one project at a time. Full design tradeoffs recorded in
`docs/PHASE_14_PLAN.md`'s M0 section.

### Added

- **`/workspace`** (`src/operator/commandRouter.js`, `renderWorkspace()` in
  `render.js`) — a read-only rollup over every registered project: total
  count, mission-ready count, a status breakdown (running/idle/blocked/
  waiting-for-you/etc.), git clean/dirty counts, the 5 most recently active
  projects, and a "needs attention" list. No new data source — every field
  is already computed by `ProjectRegistry.list()`, summed rather than shown
  one row at a time. Kill switch: `operator.workspace.enabled`.

### Fixed

- One real gap `/workspace`'s own design surfaced: a project with neither a
  `promptFile` nor a task plan fails `ConfigManager.validateProject()` (both
  are required for a legal config) and so always reports registry status
  `misconfigured` — including every project the Phase 14 M9 gap described.
  `renderWorkspace()`'s "needs attention" list now checks mission-readiness
  (a raw config read, the same technique `/mission`'s own `assignMission()`
  uses) BEFORE falling back to the generic `misconfigured` label, so this
  common, one-command-fixable state ("no mission yet") reads distinctly
  from a project that's actually broken for some other reason.

### Regression coverage

- `commandRouter.test.js` (+6 for `/workspace`). 1219 → 1225 backend tests,
  zero regressions. 41/41 desktop tests unaffected.

## [3.10.0] — 2026-07-30 — Phase 14 M9: Remote Mission-Readiness

Closes the single highest-value gap the 2026-07-30 acceptance review found:
19 of 23 real registered projects had no `promptFile` and no remote way to
get one. Implemented first in Phase 14's sequencing, ahead of M0–M8, per
the owner's own priority call. Full design tradeoffs (why `updateProject()`
not `saveProject()`, why auto-detect-only with no manual objective text, why
the detected metadata is a new `stack` field rather than reusing
`classification`) are recorded in `docs/PHASE_14_PLAN.md`'s M9 section.

### Added

- **`/mission [project]`, `/mission all`** (`src/operator/commandRouter.js`)
  — auto-detects a project's language/framework/package-manager/build-test
  commands from files already on disk and writes it a starter `promptFile`
  plus a `stack` metadata block. `all` mirrors `/import all`'s
  propose-then-`/confirm`-then-execute shape, with per-project failure
  isolation (one vanished working directory can't abort the rest of the
  batch — an improvement over `/import all`'s own known gap). Never
  overwrites an existing `promptFile`/`tasks`; no `--force` in v1. Kill
  switch: `operator.mission.enabled`.
- **`src/operator/projectInspector.js`** — the detector behind `/mission`.
  Deliberately deterministic (Class A per `docs/PHASE_14_PLAN.md` §1): reads
  `package.json`/`requirements.txt`/`pyproject.toml`/`Cargo.toml`, no AI, no
  mission pipeline, so it runs instantly and identically for all 19 projects
  regardless of which AI provider (if any) is configured.
- New project config field: `stack` (see `CONFIGURATION.md`). New event
  type: `project.mission-assigned`.

### Regression coverage

- `projectInspector.test.js` (new, 10 tests), `commandRouter.test.js` (+7).
  1194 → 1219 backend tests (the gap also includes the previously-unlanded
  `nvidia` driver's 9 tests), zero regressions. 41/41 desktop tests
  unaffected.

## [3.9.0] — 2026-07-30 — Reconciliation pass: classification migration, `/import all`, Safe Mode

Not a numbered Phase 13 milestone — a directed reconciliation ahead of M9.
Full report: `docs/PHASE_13_RECONCILIATION_2026-07-30.md`.

### Added

- **`/import all`** (`src/operator/commandRouter.js`) — registers every
  current `/scan` candidate in one batch, behind a single
  `ConfirmationStore` confirmation, mirroring `/projects classify`'s
  existing "propose once, confirm once, write N records" pattern. Closes
  an operational gap, not a defect: `/scan` already found every real
  project correctly, but `/import` only ever took one path, so registering
  N real folders meant N manual commands. Live-run against the real
  registry: 17 real, previously-unregistered folders under
  `C:\Users\Admin\Music` registered in one confirmed action (6 → 23
  projects).
- **Safe Mode** (`operator.safeMode`, `/safemode on|off`) — a new global,
  live-mutable override. While on, `ClaudeDriver` omits
  `--permission-mode`/`--dangerously-skip-permissions` for every project
  regardless of that project's own `claude.permissionMode`, forcing the
  same headless auto-deny-writes behaviour a project with no
  `permissionMode` set already gets today — machine-wide, for looking at
  an unfamiliar project before trusting it with write access. Wired
  through `DriverRegistry`/`src/app.js` with the same closure shape and
  per-launch-isolation guarantee Phase 13 M5's `defaultModelProvider`
  already established. Scoped to `ClaudeDriver` only — the generic `cli`
  driver has no standardized permission concept to override.
- New event types: `operator.safemode-changed`.

### Fixed

- **The Phase 13 M3 classification migration was executed.** The
  heuristic had been correct and live-validated since `v3.3.0`; only the
  owner's confirmation had never happened. Re-verified live against the
  real registry (identical to the `v3.3.0` table) and applied via
  `/projects classify` + `/confirm`.

### Regression coverage

- `claudeDriver.test.js` (+4), `driverRegistry.test.js` (+3),
  `commandRouter.test.js` (+9). 1178 → 1194 backend tests, zero
  regressions.

## [3.8.0] — 2026-07-30 — Phase 13 M8: Bot Experience & Discoverability

A discoverability milestone on top of M7: `/help` and `docs/OPERATOR_CONSOLE.md`
now organize the full 29-command surface built across M2–M7 into the same
eight sections, both reading from the one `COMMANDS` array so they cannot
drift apart or from each other. No new command was added; `commandMenu.js`'s
Telegram-menu payload is byte-for-byte unchanged. `docs/PHASE_13_M8_REPORT.md`.

### Added

- **`src/operator/commandGrammar.js`** — every `COMMANDS` entry gains a
  `category` (`General`/`Projects`/`Missions`/`Decisions`/`System`/
  `Registry`/`Configuration`/`Files`) and, for commands whose `usage` hint
  alone doesn't show a concrete value, an `examples` array. Both are
  additive metadata only — never consulted by `parseCommand()`, so a typo
  can misfile a command in `/help` but can never change what it does.
- **`src/operator/render.js`** — `renderHelp()` now sections its output by
  each command's `category`, in the category's first-seen order within the
  array it's given (`COMMANDS` by default, injectable for testing). If any
  command is missing a `category` — including every command, the shape a
  revert of the metadata commit would leave behind — it falls back to the
  pre-M8 flat list rather than rendering a broken section.
- **`docs/OPERATOR_CONSOLE.md`** — full pass: the command table now covers
  all 29 commands (previously 16; `/scan`, `/import`, `/archive`,
  `/restore`, `/hide`, `/unhide`, `/forget`, `/roots`, `/provider`,
  `/model`, `/files`, `/file`, `/download-project` were undocumented since
  their own milestones), grouped into the same sections `/help` now uses. A
  stale `operator.projectRoots` default (documented as empty; has defaulted
  to `C:\Users\Admin\Music` since M2) was corrected in the same pass.

### Regression coverage

- Every `COMMANDS` entry has a non-empty `category` (`commandGrammar.test.js`).
- Every `examples` entry actually parses back to the command it illustrates.
- The published Telegram menu carries only `{command, description}` —
  `category`/`examples` never leak into it (`commandMenu.test.js`).
- `/help` groups by category, and falls back to the flat list when category
  data is absent (`operatorRender.test.js`).

---

## [3.7.0] — 2026-07-29 — Phase 13 M7: Mission Completion Messaging

A copy-and-honesty milestone on top of M6's Remote File System: the
mission-complete message now says exactly what happened — every created,
modified, and deleted path, never capped or silently dropped — and points
the owner at the real commands (`/files`, `/file`, `/download_project`)
that can inspect it, with a real path substituted in. `docs/PHASE_13_M7_REPORT.md`.

### Added

- **`src/mission/checkpoint.js`** — `buildCheckpoint()` now records
  `filesCreated`/`filesModified` as their own fields (previously merged,
  irreversibly, into `filesTouched`). `filesTouched` is unchanged for every
  existing reader.
- **`src/notifications/missionCard.js`** — `buildMissionCard()` aggregates
  `filesCreated`/`filesModified`/`filesDeleted` across tasks, deduped, in
  addition to the existing capped `filesChanged` compact view. New
  `renderArtifactSummary(card)` — the FULL, uncapped Created/Modified/
  Deleted breakdown with real relative paths; falls back to a neutral
  "Changed:" heading (never a guessed split) for a checkpoint written
  before this milestone existed.
- **`mission:complete`'s notification** (`notificationEngine.js`) now
  composes: the compact Mission Card, the full artifact breakdown, the
  agent's own summary, and — new — a footer with the real project name and
  a real changed path substituted in:
  `/project <name>` · `/files` · `/file <real-path>` · `/download_project <name>`.
  Gated on `operator.enabled`/`operator.files.enabled` actually being
  reachable; a bare standalone `ai-orchestrator start` (no daemon,
  no CommandRouter to answer these) never shows it.
- `NotificationEngine` gains an optional `operatorConfig` constructor
  option (mirrors the existing `approvalsConfig` pattern) used only to
  gate the new footer; omitted everywhere the answer would otherwise be
  "unreachable" (see Fixed).

### Fixed

- **A real, previously-latent self-contradiction, found by this
  milestone's own live validation**: `SIMULATION_NOTICE_PAST` ("no code
  was written") is accurate for a mock project scripted to write nothing
  (`validation-sandbox`, its origin story) but not in general — the mock
  driver has always supported scripted `writeFile`/`appendFile`. Live-
  validating M7 against exactly such a fixture produced a message
  claiming "no code was written" directly above a real "Created:
  src/calculator.js" line. Fixed in `renderMissionCardText()`: a
  simulated mission that DID write real (scripted) files gets an
  accurate notice instead ("...any files listed below were part of that
  script, not independent judgment"); a simulated mission that wrote
  nothing keeps the original, still-correct wording.
- **`app.js`'s standalone `NotificationEngine` would have advertised
  `/files` commands nothing could answer.** `ai-orchestrator start` (no
  daemon) has no `CommandRouter` at all — a real architectural rule this
  module's own header already states ("`ai-orchestrator start` never
  consults \[the operator\] block"). Fixed by keying the new footer's
  visibility off the EXISTING `workerMode`/`--worker` flag: daemon-forked
  workers (where a live `CommandRouter` really is one Telegram message
  away) pass the real `operator` config through; a bare interactive
  `start` passes `{enabled: false}` and the footer is suppressed rather
  than pointing at a command nothing would answer.

## [3.6.0] — 2026-07-29 — Phase 13 M6: Remote File System

The first new runtime dependency since baseline (`archiver`) and the first
filesystem surface exposed remotely — treated as a security-sensitive
milestone. `docs/PHASE_13_M6_REPORT.md`.

### Added

- **`src/operator/fileAccess.js`** — `resolveWithinProject()`, the one
  path-traversal guard in the codebase: textual containment
  (`path.resolve()` + `path.relative()`, catching `../`, absolute paths, a
  Windows drive letter, the obscure Windows drive-*relative* form, UNC
  paths, and mixed separators with no pattern blacklist) plus real-path
  containment (`fs.realpathSync()` on both root and target, catching a
  symlink/junction escape the textual layer cannot see). Also
  `listFiles()` (paginated, Explorer-style, never recursive),
  `looksBinary()` (NUL-byte sniff), `estimateArchiveSize()` /
  `createProjectArchive()` (same exclusion list for both, so "how big"
  and "what gets zipped" can never disagree), `pruneOldDownloads()`.
- **`/files [path]`**, **`/file <path>`**, **`/download-project
  [project]`** (canonical command name `download_project` — Telegram's
  `setMyCommands` rejects hyphens; `/download-project` is a working alias).
  Small text files show inline, in full; binary or large files (or the
  complete file, past the inline threshold) send as a real Telegram
  document — never truncated either way. New `operator.files.enabled`
  kill switch and `operator.download.{maxProjectBytes,exclude,retentionMs}`.
- **`TelegramApprovalProvider.sendDocument()`** — mirrors the existing
  notification-channel method (same size ceiling, same multipart shape).
  `OperatorGateway.deliver()` sends text then attachment, duck-typed so a
  provider without one is simply skipped.
- `CommandRouter.handle()`'s reply contract grows one optional field —
  `{reply, attachment?}` — additive, every existing `.reply`-only caller
  unaffected. `POST /api/operator/command` and the CLI's `operator`
  command now surface `attachment` (a local file path) instead of
  silently dropping it.
- A refusal (not a plain not-found) is now recorded in the event log —
  `file.served` with `mode: 'refused'` — an audit trail this security-
  sensitive surface had no version of before.
- New event types `file.served`, `project.downloaded`.

### Fixed

- **A vanished project's folder silently produced a valid, empty ZIP**
  instead of an error — `readdir-glob` treats an `ENOENT` `cwd` as "zero
  matches," not a failure. Found by the adversarial test suite (which was
  run against the unfixed code and confirmed to fail first); fixed with an
  explicit existence check in both `createProjectArchive()` and
  `estimateArchiveSize()`.
- `archiver`'s own `readdir-glob` dependency's `ignore` glob option only
  filters files *after* walking them — it does not stop the walk from
  descending into an excluded directory. For a real `node_modules`, that
  is the whole performance story; fixed by using the `skip` option
  instead, which prevents the walk from entering an excluded directory at
  all.
- `POST /api/operator/command` silently dropped a reply's `attachment`
  field (the route predates this milestone). An API/CLI caller running
  `/file bigfile.bin` would have gotten "sending as a file" with no way to
  find it.

### Dependency

`archiver` (^8.0.0) — justified per `docs/PHASE_13_PLAN.md` decision D3.
Note for anyone extending this code: v8 is a pure-ESM rewrite with a
different API than older tutorials describe — named exports
(`ZipArchive`/`TarArchive`/`JsonArchive`), no default export, no
`archiver(format, options)` factory function.

1100 → **1155 backend tests** (+55). Live-validated against the real
Core Service and the real `calculator-proof` project: real directory
listings, real inline reads, a real complete source file sent through the
actual Telegram Bot API (`sendDocument`, confirmed by a real returned
message id), three distinct outside-the-project attempts refused (relative
traversal, absolute Windows path, and a real sibling project's gitignored
credentials file), a real ZIP produced and verified by actually extracting
it with Windows' own `Expand-Archive`, and archived-project access
confirmed unaffected (archiving is a registry demotion, never an access
restriction).

## [3.5.0] — 2026-07-29 — Phase 13 M5: Provider Architecture Completion & Remote Model/Provider Management

Completes the provider/model layer and exposes it remotely.
`docs/PHASE_13_M5_REPORT.md`.

### Already built, explicitly not rebuilt (stated so scope stays honest)

`AIDriver`/`AgentRun` (already an `EventEmitter` — streaming already
exists), `DriverRegistry`'s runtime `registerDriver()` (a plugin can already
add Gemini/OpenAI/local models with zero core changes), the generic
`CliDriver` (wraps any CLI engine from config alone), per-project
`driver`/`claude` config, Phase 9's per-task-role driver routing. Execution
and cancellation are already covered by `AIDriver.launch()` and the
existing worker-stop machinery. Authentication: every built-in driver
authenticates via the wrapped CLI's own ambient login; this milestone adds
no credential vault (a future driver that genuinely needs one follows the
existing `config/local.json` pattern SMTP/Telegram secrets already use).

### Added

- **`src/drivers/capabilities.js`**, `DRIVER_CAPABILITIES` — a plain data
  map (models/streaming/cancellation/toolUse per driver id). `cli`'s
  `toolUse: 'unknown'` is deliberate: a generic wrapper cannot introspect an
  arbitrary engine, and inventing `true`/`false` would be exactly the
  "confident fiction" `projectRegistry.js` already argues against.
- **A machine-wide default model** (`operator.defaultModel`/
  `operator.defaultProvider`, both allowlisted in M4's `LiveConfigLayer`).
  Threaded into `ClaudeDriver` via an optional `defaultModelProvider`
  closure (every existing caller/test unaffected when absent). Resolved
  once per launch inside `buildArgs()`: `project.claude.model ||
  defaultModelProvider()` — an explicit per-project model always wins.
- **`/provider`** (read-only: default provider/model, capabilities, known
  drivers, and — when a project is selected — that project's own override
  shown side by side) and **`/model [name|default]`** (validates against
  the provider's known models; `default` clears back to per-project
  behaviour).
- New event type `provider.model-changed`.

### Why this never interrupts an active mission

A worker process loads its own config once, at construction, and never
reloads it — the same pattern every other worker-side setting already
follows. A `/model` change lands in the daemon's live config immediately,
but an already-running worker's `defaultModelProvider` closure reads that
SAME worker's own (unchanged) snapshot, so its in-flight launch is
unaffected. A brand-new worker (the next mission) loads config fresh at
its own construction and picks up the change automatically. No explicit
"don't disrupt a running mission" logic was needed — the existing
process-boundary architecture already guarantees it.

1074 → 1100 backend tests (+26: `buildArgs`/`defaultModelProvider`
coverage in `claudeDriver.test.js`, new `driverRegistry.test.js`
(previously untested at the unit level) and `capabilities.test.js`, plus
`/provider`/`/model` integration tests in `commandRouter.test.js`).
Live-validated against the real 6 project configs: projects with no
explicit model correctly inherit a simulated machine default; `phone-demo`/
`validation-demo` (both explicitly set to `haiku`) correctly ignore it.

---

## [3.4.0] — 2026-07-29 — Phase 13 M4: Live Configuration Layer

The first mechanism for the daemon to accept a config change without a
restart. `docs/PHASE_13_M4_REPORT.md`.

### Added

- **`src/config/liveConfig.js`**, `LiveConfigLayer` — an explicit
  **allowlist** (`LIVE_MUTABLE_PATHS`: `operator.projectRoots`,
  `operator.defaultModel`, `operator.defaultProvider`,
  `notifications.minSeverity`, `approvals.mode`), deliberately not "anything
  in config" — that would silently turn restart-only settings
  (`daemon.pollIntervalMs`, `api.port`) into ones that look live but aren't.
  `applyPatch()` is all-or-nothing (one disallowed key blocks the whole
  patch) and writes to disk FIRST via the existing
  `ConfigManager.writeLocalConfig()`, then mirrors the change into the same
  in-memory config object every subsystem already holds by reference — no
  subsystem needs telling to "reload."
- **`/roots`**, **`/roots add <path>`**, **`/roots remove <path>`** — list,
  add, or remove a project root. Not destructive (`ConfigManager.getProject()`
  never consults `operator.projectRoots` at all, so this only ever affects
  `/scan`'s discovery, never a registered project's ability to run — stated
  plainly in `/roots remove`'s own reply when a registered project happens
  to live under the root being removed). New `operator.liveConfig.enabled`
  kill switch.
- New event type `config.changed` (`{key}` only — the key changed, never
  the raw value, hygiene against a future allowlisted key that turns out to
  be secret-adjacent).

### Fixed

- **A real, previously-latent bug in `ConfigManager.deepMerge()`**, found
  while building this milestone (nothing before it ever mutated a merged
  config object in place): a shallow `{...target}` spread left any branch
  the `source` override never touched as the EXACT SAME OBJECT as the one
  inside `target` — and since `load()` calls `deepMerge(ORCHESTRATOR_DEFAULTS,
  overrides)`, an untouched section of a live config (e.g. `operator` on a
  machine with no `local.json` override for it) was literally the shared,
  module-level `ORCHESTRATOR_DEFAULTS` object. `LiveConfigLayer` is the
  first code ever to mutate that object graph in place, and doing so would
  have silently corrupted the shared default for every other `ConfigManager`
  instance in the same process — caught by a new test before it ever ran
  against a live system. `deepMerge()` now deep-clones every nested object
  AND array from `target`, guaranteeing full independence.

1057 → 1074 backend tests (+17: new `liveConfig.test.js`, two new
`deepMerge`/cross-instance regression tests in `configManager.test.js`, and
`/roots` integration coverage in `commandRouter.test.js`). No live daemon
restart was performed against the real installation (consistent with M2/M3:
the mechanism is validated end-to-end through the real `ConfigManager`/
`LiveConfigLayer`/`CommandRouter` classes, never against the owner's actual
`config/local.json` without their request).

---

## [3.3.0] — 2026-07-29 — Phase 13 M3: Project Lifecycle & Registry Operations

The registry stops treating every project as equally live. Owner-set
classification (production/development/validation/demo/archived/hidden) plus
registry-only archive/hide/restore/unhide/forget operations — strictly split
from filesystem deletion, which this system still does not implement, on any
path. `docs/PHASE_13_M3_REPORT.md`.

### Added

- **`src/config/projectClassification.js`** — `PROJECT_CLASSIFICATIONS`
  (production/development/validation/demo/archived/hidden), named
  "classification" rather than "lifecycle" deliberately:
  `missionLifecycle.js` already owns that word for a mission-RUN state
  machine, an unrelated concept.
- **`ConfigManager.updateProject()`** — patches a project's RAW on-disk
  definition (never the defaults-merged object, so a patch can't bake
  defaults permanently into the file). Deliberately does NOT require full
  mission-readiness validation (driver/workingDirectory/promptFile-or-tasks)
  — a project can be legitimately incomplete (M2's freshly-imported
  projects are exactly this) and lifecycle operations must still work on
  it; only an unknown `classification` value is refused.
- **`ConfigManager.deleteProject()`** and **`getProjectFileContents()`** (the
  latter needed because `classification` now has a default, so the
  already-defaults-merged `getRawProject()` can't answer "did the owner
  actually set this yet").
- **`src/operator/projectLifecycleOps.js`**: `archive()`, `restore()`,
  `hide()`, `unhide()`, `forget()`, `classifyProposal()`.
- **`/archive [project]`, `/restore [project]`, `/hide [project]`,
  `/unhide [project]`** — reversible, registry-only, non-destructive.
- **`/forget [project]`** — destructive (removes the registry entry),
  routed through the existing `ConfirmationStore`/`prepareDestructive()`
  pattern `/stop`/`/reset`/`/shutdown` already use. Refuses while a mission
  is running. **Never touches the project's real files** — stated in its
  own confirmation text, and true on every path: deleting real code is a
  non-goal this system does not build, anywhere.
- **`/projects all`** (includes hidden) and **`/projects classify`**
  (proposes a classification for every unclassified project — evidence-based:
  simulated engine → demo; lives inside AI-Orchestrator's own install →
  demo; `$comment`/description mentions "valid" → validation; otherwise
  development — reused the same "explicit field always wins, inference is
  only the fallback" precedent `isSimulatedProject()` already established).
  One batch confirmation via `ConfirmationStore`, not one per project.
- `ProjectRegistry.list()` gains `{includeHidden = false}`; a `hidden`
  project is filtered from the default `/projects`, an `archived` one stays
  listed but sorts after every live status (badged `📦 ARCHIVED`, mirroring
  the existing `🧪 SIMULATED` convention) — a demotion in attention
  priority, not an act of hiding.
- New event types `project.archived`, `project.restored`, `project.hidden`,
  `project.unhidden`, `project.forgotten`, `project.classified`.
- New `operator.lifecycle.enabled` kill switch (default `true`) — the first
  surface (after M2's read-only discovery) that writes to the registry
  remotely.

Migration heuristic live-validated against the real 6 project files:
reproduces the plan's expected table exactly (`calculator-proof`,
`phone-demo`, `validation-demo` → validation; `example`,
`validation-sandbox` → demo; `THE FINISHER` → development, no strong
signal). Not applied to the real registry — the actual write still requires
the owner's own `/confirm`.

1023 → 1057 backend tests (+34: new `projectLifecycleOps.test.js`, plus
coverage across `configManager.test.js`, `projectRegistry.test.js`,
`operatorRender.test.js`, `commandRouter.test.js`, and one `commandGrammar.test.js`
assertion updated for the new destructive command).

---

## [3.2.0] — 2026-07-29 — Phase 13 M2: Project Roots & Discovery

The operator stops hardcoding sample folders. Configurable `operator.projectRoots`
(default `C:\Users\Admin\Music`, where every current project already lives)
are scanned for real, unregistered projects instead. `docs/PHASE_13_M2_REPORT.md`.

### Added

- **`src/operator/projectDiscovery.js`**, `scanRoots()` — one level deep per
  configured root, marker-probed (`.git`, `package.json`, `requirements.txt`,
  `pyproject.toml`, `Cargo.toml`, `README.md`) up to 2 levels further. Never
  descends into `node_modules`/`.git`/`dist`/`build`/`.next`/`.venv`/
  `__pycache__`, never re-offers an already-registered `workingDirectory`,
  never offers AI-Orchestrator's own installation directory, and treats a
  directory containing `.git` as a scan leaf so nested repos never produce
  false candidates. Always recomputed live — no cache, no state file.
- **`/scan`** (aliases `rescan`, `discover`; read-only) — reports every
  candidate found, and any configured root that doesn't exist on disk.
- **`/import <path> [as <name>]`** — registers a real folder as a new
  project (registry-only; never touches the folder itself). Defaults the
  name to the folder's own basename; `as <name>` sets an explicit one —
  needed because both filesystem paths and project names in this system may
  legitimately contain spaces, so `<path> [name]` can't be split on
  whitespace alone. Refuses a name collision outright (reuses
  `ConfigManager.saveProject()`'s existing behaviour) rather than guessing.
  An imported project has no mission yet and correctly shows as
  `misconfigured` until a `promptFile`/task plan is added — this milestone
  registers folders, it does not invent missions for them.
- **`ConfigManager.getRawProject()`** — the merged project definition
  without validation, so a caller can distinguish "the workingDirectory
  itself is gone" from "some other configuration problem" (`getProject()`
  collapses both into one thrown error).
- **New project status `missing`** (`ProjectRegistry`, `shared/vocabulary.js`)
  — a project whose folder was moved/renamed/deleted outside AI-Orchestrator
  now reports distinctly from `misconfigured`; the definition is fine, only
  the folder is gone.
- New event types `project.discovered` (one per `/scan`, a count in the
  payload — never one per candidate) and `project.imported`.
- `operator.projectRoots` default changes from `[]` to
  `["C:\\Users\\Admin\\Music"]` — a disclosed, deliberate security-relevant
  default change (it also activates Phase 12 M4's future write-safety use of
  the same list once that milestone resumes). New `operator.discovery`
  config block (`enabled`, `ignore`, `markers`, `maxDepth`).

992 → 1023 backend tests (+31: `projectDiscovery.test.js`, plus coverage in
`configManager.test.js`, `operatorRender.test.js`, `commandRouter.test.js`,
and one existing `projectRegistry.test.js` assertion updated for the new
status). Live-validated against the real installation: scanning the real,
configured `C:\Users\Admin\Music` correctly excluded all 6 registered
projects and AI-Orchestrator's own checkout, and found 17 real, genuinely
unregistered project folders.

---

## [3.1.0] — 2026-07-29 — Phase 13 M1: Long Message Reliability

Root-causes and fixes the owner's repeatedly-observed defect: mission reports
arriving cut off mid-sentence. `docs/PHASE_13_M1_REPORT.md`; full phase plan:
`docs/PHASE_13_PLAN.md`.

### Fixed

- **The real cause was never Telegram's 4096-char message limit.** Real
  mission data reconstructed through the actual card/format pipeline stays in
  the low hundreds to low thousands of characters — nowhere near it — and
  every session log available shows zero silently-swallowed HTTP failures
  (`"Notification channel failed"` never once appears, despite warn-level
  logging demonstrably working for other conditions). The actual mechanism:
  `notificationEngine.js`'s `EVENT_MESSAGES` table applied a flat,
  boundary-blind `truncate(text, N)` (300/400 for `mission:complete`, 1200 for
  `approval:required`/`human-action:required`, 1500 for the daily/weekly
  summaries) directly to the **agent's own free-form report text** — a
  deliberate Phase 11 "keep it short for a phone" choice, not a transport
  bug, that silently discarded real content mid-sentence the moment a report
  ran past the cap. All four flat caps are removed; the full text now goes
  out.

### Added

- **`src/notifications/telegramSplit.js`** — the shared send path every
  Telegram text call site now converges on. `splitForTelegram()` is a
  tag/entity-aware scanner over already-HTML-formatted text: never cuts
  inside a `<tag>` or `&entity;`, prefers a paragraph break, then a line
  break, then a word break, and only accepts a boundary that fills at least
  half the message budget (otherwise a single early break — e.g. one
  newline right after a short title — would produce a tiny first part
  instead of a well-packed one). `sendLongText()` sends one message when the
  real (post-formatting) length fits Telegram's actual 4096-char limit,
  numbered continuations (`(1/3)`, `(2/3)`, …) when it doesn't, and retries
  once with formatting stripped if Telegram rejects an HTML payload outright
  — closing the one real transport-level failure mode this investigation
  did find a plausible (if unobserved-in-logs) path for.
- `TelegramChannel.postMessage()` / `TelegramApprovalProvider.postMessage()`
  — the single-part senders `sendLongText` calls into; `send()`, `publish()`,
  and `sendText()` are now thin wrappers around it.

972 → 992 backend tests (+20: `telegramSplit.test.js` plus wiring/regression
coverage in `telegramChannel.test.js`, `approvalProviders.test.js`,
`notificationEngine.test.js`). Live-validated against the real bot: a
synthetic 7,000+ character report was sent end to end with no errors.

---

## [3.0.0] — 2026-07-28 — Phase 12 M3: Operator Control Center

The desktop app becomes a pure client of the Core Service, closing the gap M1
deliberately left open. `docs/PHASE_12_M3_REPORT.md`.

**THE PHASE 12 INVARIANT still holds:** standalone `ai-orchestrator start`
takes the identical code path it always has.

### Fixed

- **The desktop's liveness check did not know the Core Service existed.**
  `isLive()` read only `state/heartbeat.json`, written exclusively by a
  standalone `ai-orchestrator start`. The moment reboot persistence (M2.1)
  made the service the normal state, every desktop read that branched on it —
  status, tasks, memory, timeline, agents — silently took the stale-file path,
  and the header read *"Idle — no orchestrator running"* while the service sat
  one HTTP call away. Fixed with `supervisor()`, checked everywhere liveness
  was: service first (it owns the API port when both exist), heartbeat second.

- **The Missions tab gated one project's Start/Stop on machine-wide health.**
  A second-order version of the same bug, found while fixing the first:
  `getHealth()` answers true for the whole machine the instant any ONE project
  has a worker, so every idle project would have shown as running the moment
  the service — now the normal state — was up. Added `isProjectLive(project)`,
  which asks the worker registry (service) or matches the heartbeat's own
  project field (standalone) instead of applying a machine-wide answer to
  whichever project happens to be selected.

### Added

- **The Operator Control Center** — a new landing tab, deliberately not
  project-scoped. Every other tab answers a question about one project; this
  one answers what an owner actually opens the desktop for: is the service up,
  what is it running, and what is waiting on me. Service header (running,
  uptime, worker count, Telegram inbound, reboot survival — resolved from Task
  Scheduler locally, so the reboot answer works even while the service is
  down); every project on one screen from the same `/api/registry` a phone's
  `/projects` renders, each with a real Start/Stop; every pending approval
  across every project; simulated projects disclosed in the picker and on the
  card, closing the last gap from the M2.2 disclosure work.

- `startMission()` now hands a second project to a running service instead of
  refusing outright — the pre-M3 refusal was correct when one orchestrator
  could exist at all, and a regression against the exact capability M1 built.
  `stopMission(reason, project)` requires the project under the service (an
  unqualified stop cannot be resolved when several missions may be running)
  and never calls the standalone-only "stop everything" route.

972 backend tests (+3), 41 desktop tests (+21), all passing.

---

## [2.11.0] — 2026-07-28 — Phase 12 M2.2: The Artifact Investigation, Closed

The demanded full trace of the mission that reported success over an empty
workspace, the disclosure gaps that trace exposed, and automatic Telegram
command registration.

**THE PHASE 12 INVARIANT still holds:** with no daemon running and no operator
configuration, a standalone `ai-orchestrator start` behaves exactly as in
`v2.7.0`.

### The investigation

Mission M4 was traced end to end from the durable event log, the task queue, the
approval store and the mission-request store. Findings, all evidence-backed:

- The project used `"driver": "mock"`. **No Claude process was ever spawned** —
  the mock driver is in-process and replays scripted strings.
- The prompt file was built correctly and completely, and never delivered.
- No code was generated, so none was lost.
- The task's own checkpoint recorded `filesTouched: []`. **The truth was
  written down; nothing rendered it.**
- The plan the owner approved from their phone proposed editing `payroll.js` —
  left over from an earlier payroll fixture — for a request that asked for a
  React and Electron calculator.

**Answer:** expected behaviour *and* a genuine defect. A fixture replaying a
fixture is correct; no surface disclosing it is not. See
[docs/PHASE_12_M2.2_REPORT.md](docs/PHASE_12_M2.2_REPORT.md).

**Validated against a real engine.** The identical objective was re-run through
the identical operator path on a `claude`-driver project: mission complete in
13 m 13 s, **12 real files** written, and `npm test` in the resulting workspace
passes 16 tests. `filesTouched` went from `[]` to twelve entries.

### Fixed

- **Simulation disclosure stopped at the phone.** v2.10.0 covered `/projects`,
  `/status`, both approval gates and the Mission Card, and left five surfaces
  silent. Now disclosed in `projects list`, `projects status` (the terminal twin
  of `/status`, which was already handed the field and simply did not print it),
  `/approvals`, `/missions`, and `doctor` — which is where an owner goes *after*
  a mission "worked" over an empty workspace.

  The two list surfaces derive the badge from the **live config**
  (`ProjectRegistry.simulatedNames()`), not from the flag frozen into a stored
  record: pointing a project at a real engine must clear the badge on its
  already-queued approvals, and the reverse.

- **A plan written in markdown parsed wrongly** — found by the first real
  engine run. `**Objective:**` left its closing `**` glued to the text the
  owner read, and `**Tasks:**` / `**Files:**` / `**Risks:**` matched no heading
  at all, so every bullet piled under whichever heading had matched last. The
  approval gate showed eight "tasks", no risks and no files. The emphasis
  stripper is bullet-safe: `* item` and `**bold**` both start with an asterisk,
  and collapsing the first would turn every list item into a heading.

### Added

- **Automatic Telegram command registration** (`setMyCommands`). The bot now
  publishes its own command menu, so the commands appear in the chat instead of
  having to be memorized. All 16 are registered: `/help`, `/projects`,
  `/project`, `/status`, `/start`, `/stop`, `/tasks`, `/approvals`,
  `/missions`, `/service`, `/events`, `/reset`, `/shutdown`, `/confirm`,
  `/cancel`, `/whoami`.

  - **The menu is derived from the parser, never maintained beside it.**
    `operator/commandMenu.js` reads the same `COMMANDS` table
    `commandGrammar.js` parses with, and a test asserts set-equality between
    them — so a command added to the grammar appears on every phone menu
    without anyone remembering to add it.
  - **Scoped to the owner's chat** (`BotCommandScopeChat`), not published
    globally. The provider has dropped messages from every other chat since
    Phase 10C; a global menu would advertise a control surface to strangers
    that the system then refuses.
  - Descriptions carry the argument (`/project` → `<name> — Select the active
    project`), because tapping an entry inserts the bare command. Destructive
    commands say *"(asks you to confirm first)"*.
  - Published at three moments: during `notify setup telegram`, on every Core
    Service start (skipped when already current), and on demand via
    `ai-orchestrator notify commands` (`--force`, `--dry-run`). The service
    start never awaits it — the inbound channel must come up whether or not
    Telegram is reachable.

### Verified

Reboot persistence was **closed on live evidence**: a real Windows restart with
nothing launched by hand, `/projects`, `/status` and `/service` all answering
from a phone, and `scripts/verify-reboot-persistence.ps1` passing **11/11**
— including the checks that separate "autostarted" from "survived the shutdown"
and from "someone started it by hand".

969 backend tests (+50), 38 desktop tests (+18), all passing.

---

## [2.10.0] — 2026-07-28 — Phase 12 M2.1: Residency, Honesty, and Ports

Driven entirely by the M2 live-validation report. The operator console itself
passed — the full workflow (`/help` → `/projects` → `/project` → proposal →
M-series approval → A-series approval → execution → completion) behaved as
designed. Two defects and one architectural request came out of it, and this
release is those three things.

**THE PHASE 12 INVARIANT still holds:** with no daemon running and no operator
configuration, a standalone `ai-orchestrator start` behaves exactly as in
`v2.7.0`. Nothing in this release is reachable without the Core Service except
the port registry, which is deliberately usable standalone.

### Fixed

- **The Core Service did not survive a reboot** (validation Bug 1). After a
  Windows restart the operator console was silent: `/projects` went into a
  void until someone ran `serve` by hand at the machine.

  The cause was not a crash. `daemon install` had shipped in M1 and had never
  been run, `doctor` checked only the *auto-resume* task (a different job), and
  no surface could report the difference. The remedy is layered, because one
  layer was exactly what failed:

  - `daemon ensure` — starts the service only if it is not already running or
    starting. Idempotent, so it is safe on every login, in a launcher, or in a
    script. It never starts a second daemon: two of them both claim the
    Telegram long-poll, and `getUpdates` gives each message to exactly one
    caller, so the symptom is a console that answers every other message.
  - `START_SERVICE.bat` — the double-click launcher for anyone who prefers
    manual startup.
  - **Restart on failure** in `install-daemon-task.ps1` (3 attempts, one minute
    apart) plus `MultipleInstances=IgnoreNew`. A crash is restarted; a
    deliberate stop is not. The distinction is carried by the exit code the
    daemon has always used — `0` for a signal or `daemon stop`, `1` for an
    uncaught exception — so the scheduler and `daemon stop` cannot fight.
  - `/service` on the phone, and a new header on `daemon status`, reporting
    **Running / Starting / Stopped** *and* whether the service survives a
    reboot. "Starting" is a real state: between claiming `state/daemon.json`
    and answering HTTP, the service is neither stopped nor usable.
  - **`doctor` now fails** — not warns — when the Core Service logon task is
    missing. A remote interface that cannot survive a reboot is a broken
    installation, and on 2026-07-28 every available diagnostic called this
    machine healthy.

- **A simulated mission reported itself as real work** (validation Bug 2). A
  project on the `mock` driver was asked for a React and Electron calculator
  and reported the mission complete, tests passed, verified. The workspace
  contained only the README it started with.

  Nothing had malfunctioned — the mock driver replayed its fixture exactly as
  configured, and every layer above reported what it was told. The defect was
  that **no surface disclosed that the engine was a fixture**. Simulation is
  now a fact the whole system carries (`src/drivers/simulation.js`) and every
  operator surface discloses it: the project list badge, `/status`, the mission
  proposal (gate 1), the implementation-plan approval (gate 2), and the Mission
  Card — where the notice sits *above* the status line, because a phone
  notification preview shows the first line and "Mission complete" must not
  travel alone.

- **The completion marker was being counted as a passing test.** Independent of
  the mock driver, and the reason the card above said "Tests: 1/1 passed ·
  Confidence: Verified" for a mission that wrote nothing. A task with no
  verifiers of its own falls back to the mission completion marker, which
  records exactly one fact: the agent emitted `MISSION COMPLETE`. That is the
  agent grading its own homework. Markers are now excluded from both the
  Mission Card's test count and the operator console's verifier pass rate; a
  marker-only task is `unverified`, which is what it always was. **This
  affected real missions, not only simulated ones.**

- **A completed mission that changed no files now says so** on its Mission
  Card. It is the shared signature of both failure modes this card has actually
  produced: a simulated engine, and a real engine answering without write
  permission (the 2026-07-04 incident). Neither is visible from "Tasks: 1/1".

- **Port probing missed loopback-bound services.** Found while live-validating
  the new port registry: `ports check 4711` reported "nothing listening" while
  this project's own API was serving on it. Binding `0.0.0.0` succeeds on
  Windows while another process holds `127.0.0.1:<port>`, and loopback is the
  *default* for dev servers (Vite, Next, this API). The probe now requires both
  addresses to bind before calling a port free.

### Added

- **The port registry** (`src/runtime/portRegistry.js`) — the architectural
  request. One machine, many projects, no collisions:

  | Command | What it does |
  | --- | --- |
  | `ports get <project> [service]` | The port this service should use, assigning one if needed. Idempotent — call it on every start. Prints a bare number for scripts. |
  | `ports reserve <project> <port>` | Permanently hold a port whose endpoint must not move |
  | `ports release <project>` | Give a port back |
  | `ports list` | Every registered port, with what the OS says about it |
  | `ports check <port>` | Who has this port, and is anything actually on it? |

  Three ideas, in order of importance:

  1. **The OS is the authority on "in use", not the registry file.** Ports are
     tested by binding them. A registry answering from its own records would
     hand out a port Docker or a stale node process already holds, and be
     confidently wrong exactly when it matters. The registry records *intent*;
     the kernel reports *reality*; an allocation requires both.
  2. **Stable without bookkeeping.** A port is derived deterministically from
     `project:service` (FNV-1a, modulo the range), so the same service gets the
     same port on every machine and every run — before anything is written
     down, and again after the state file is deleted. Linear probing resolves
     collisions.
  3. **Reservations are a human decision; allocations are not.** THE FINISHER
     needs 5173 because something outside the machine expects it there — that
     lives in `config/ports.json`, hand-editable and committable. Dynamic
     allocations are machine-owned and live in `state/ports.json`.

  Allocation draws from `5200–5899` by default: above the ports frameworks
  scaffold into (3000, 4200, 5173, 8080) and below the ephemeral range Windows
  assigns outbound sockets from (49152+), where a port probes free and is
  stolen minutes later.

- **`GET /api/ports` and `GET /api/ports/:project/:service`** — the runtime
  integration point, so an Electron main process or a Vite config asks the
  service which port it owns instead of hard-coding one. Unauthenticated on
  purpose: the API is loopback-only, and a dev server that must first find a
  token to learn its own port will hard-code the port instead.

- **`daemon install --start-now`**, and `daemon install` now *verifies* the
  task was registered rather than trusting the script's exit code — "installed"
  is precisely the claim that was believed and untrue on this machine.

### Changed

- `m2-validation` is retired and replaced by **`validation-sandbox`**, whose
  name, description, README, and fixture text all state that it is simulated
  and writes nothing. The old name said what the project was *for*, not what it
  *does*, and that ambiguity is what turned a working fixture into a bug
  report. Its historical state under `state/` is left intact as the record.

- `config/projects/*.json` accepts an explicit `"simulated": true`, which
  overrides driver-based detection in both directions — a plugin driver can
  declare itself simulated, and a real driver is never mislabelled.

## [2.9.0] — 2026-07-27 — Phase 12 M2: Telegram Operator Interface

The second milestone of Phase 12. M1 made the daemon always present; M2 makes
it something you can *operate*. The remote channel stops being a place to reply
`APPROVE A7` and becomes a console: list projects, select one, ask for work,
watch it happen. Full report: `docs/PHASE_12_M2_REPORT.md`.

**THE PHASE 12 INVARIANT still holds, and is re-tested for this milestone:**
with no daemon running and no operator configuration, a standalone
`ai-orchestrator start` polls, parses, and resolves approvals exactly as in
`v2.7.0`. No command surface exists without the Core Service.

**THE GOVERNING RULE OF THIS MILESTONE:** *no free text may implicitly start
work.* Typing a sentence raises a proposal; only an explicit approval
authorizes a mission. There are two gates between a message and a commit, and
they answer different questions — see "Two gates" below.

### Added

- **The operator console** (`src/operator/`). A widened inbound grammar,
  parsed by a pure, side-effect-free parser (`commandGrammar.js`) and executed
  against the daemon's own collaborators (`commandRouter.js`):

  | Command | What it does |
  | --- | --- |
  | `/projects` | Every project: status, tasks, branch, health |
  | `/project <name>` | Select the active project (remembered) |
  | `/status [project]` | Phase, tasks, worker, branch, commit, last activity, health |
  | `/start [project]` · `/stop [project]` | Run or stop a mission |
  | `/tasks [project]` | The real task queue and where it is |
  | `/approvals` · `/missions` | What is waiting for you |
  | `/events [n]` | What the system actually did |
  | `/reset [project]` | Abandon an interrupted session |
  | `/shutdown` | Stop the Core Service |
  | `/confirm <code>` · `/cancel [code]` | Answer a destructive-action prompt |
  | `/whoami` · `/help` | Context, and the whole grammar |

  Aliases (`/ls`, `/use`, `/cd`, `/queue`, `/log`, `/yes`, `/no`, …) resolve to
  one canonical command, and `/help` is generated FROM the grammar so it can
  never drift from what the parser accepts.

- **The project registry** (`src/operator/projectRegistry.js`) — the daemon as
  the single source of truth for name, description, path, status, current
  worker, last activity, branch, latest commit, and Phase 10E health. Status is
  derived from evidence (`waiting-approval` → `blocked` → `running` → `queued`
  → `idle` → `misconfigured`), and the list is ordered by what needs your
  attention, not alphabetically. A project whose config is broken is still
  listed, flagged — never silently dropped.

- **The event log** (`src/events/`) — an append-only JSONL record at
  `state/events/events.jsonl` and the spine of the architecture: every
  interface reads events instead of participating in mission logic. Monotonic
  sequence numbers survive restarts, so a client can tail with `since`. The
  daemon is its single writer by design; workers write the state files they
  always have. Unknown event types are refused rather than written.

- **Mission requests, and the two gates** (`src/operator/missionRequests.js`).
  Free text becomes a proposal (`M3`), never work:

  ```text
  "Build a payroll dashboard."
        │
        ▼  gate 1 — do you want this at all?   APPROVE M3
  a real prompt file + a real task on the project's queue + a supervised worker
        │
        ▼  gate 2 — do you accept THIS plan?   APPROVE A9
  implementation
  ```

  Gate 1 shows only facts (branch, path, queue depth) and this project's own
  measured history, labelled as history. Gate 2 is Phase 10's existing
  implementation-review flow: the agent plans, and `implementationSummary.js`
  extracts the real objective, duration, files, tasks and risks *from the plan*.
  Nothing estimates the size of a request before something has read the code.

- **Live mission progress** (`src/operator/missionMonitor.js`) — Planning →
  Coding → Testing → Fixing, derived every 15 s from what missions actually
  wrote to `state/lifecycle/` and `state/tasks/`. Progress is a count of
  finished tasks; there is no percentage anywhere, because elapsed time is not
  progress. Phases the mission already notifies about (approval required,
  complete, blocked) are recorded but never re-announced — the duplicate class
  Phase 11 M2 spent a milestone eliminating. Rate-limited per project.

- **Destructive-action confirmation** (`src/operator/confirmations.js`).
  `/stop`, `/reset`, and `/shutdown` return a short single-use code that
  expires; only `/confirm <code>` performs the action. A bare `/confirm` with
  two things pending is refused and both codes are listed — guessing which
  mission to stop is exactly the failure this prevents. Codes are per channel.

- **Operator API**: `GET /api/registry`, `GET /api/registry/:project`,
  `GET /api/events`, `GET /api/operator/context`, `GET /api/operator/missions`,
  and `POST /api/operator/command` (behind the P7 token) — which runs the SAME
  router a phone message goes through. That is the architectural claim of the
  milestone made testable: Telegram is one client, not the interface.

- **`ai-orchestrator operator "<message>"`** — type what you would type on your
  phone, from a terminal. **`ai-orchestrator events`** — tail the log (works
  with the service stopped, by reading the file). **`ai-orchestrator projects
  status [project]`** — the full registry in a terminal, also without the
  service.

- **Provider routing surface** — `fetchMessages()` / `sendText()` / `canRoute`
  on `ApprovalProvider`, implemented by Telegram. Default no-ops, so every
  pre-M2 provider is unchanged.

- **`operator` config block** — `enabled`, `acceptFreeText`,
  `minObjectiveChars`, `confirmationTtlMs`, `requestTtlMs`,
  `progressIntervalMs`, `progressUpdates`, `progressMinIntervalMs`,
  `projectRoots`. Setting `enabled: false` leaves exactly the `v2.8.0` message
  set. Projects gained an optional `description`.

### Changed

- **The inbound read moved up one level** (`src/operator/operatorGateway.js`).
  `pollProvidersOnce()` parsed each update as a decision and discarded
  everything else — correct while `APPROVE A7` was the entire grammar, and data
  loss the moment `/projects` existed, because `getUpdates` is
  offset-acknowledged. The gateway now performs the one consuming read per
  provider per tick and routes decisions *and* commands from it. Decisions go
  through the new `ApprovalManager.applyRemoteDecision()`, which is the exact
  store path `pollProvidersOnce()` has always used — including the once-only
  `approval:resolved` emission workers depend on. `pollProvidersOnce()` itself
  is untouched and remains the standalone path.
- `TelegramApprovalProvider.fetchDecisions()` is now implemented on top of
  `fetchMessages()`, so the chat-id restriction and the offset advance live in
  one place. Its behaviour is unchanged and re-tested in full.
- `daemon status` reports the operator interface: whether commands are enabled,
  which channels are live, open mission requests, and how many events exist.
- `shared/vocabulary.js` gained project-status, mission-phase, and health
  vocabularies, so the CLI and the phone (and the M3 desktop) render one
  concept one way.
- `progressEngine.js` exports `gitBranch`, `gitHeadSubject`, and `gitDirty`
  beside the existing `gitHead`, all bounded and never throwing.

### Fixed

- **A completed mission worker never exited** (found in this milestone's live
  validation; the defect is M1 code). A forked worker's IPC channel is a live
  libuv handle, so its event loop never drained: the mission finished, the
  session was archived, the project claim was released, `"Mission worker shut
  down cleanly"` was logged — and the process stayed resident forever. Every
  successful mission leaked one. Worse, with no `exit` event the daemon never
  recorded `worker.completed`, so the event log showed missions that started
  and never ended. `App.shutdown()` now closes the channel in worker mode.

  M1's own live pass missed this because the worker it observed exited with
  code 1, and a throwing process terminates whatever handles are open. Only a
  mission that *succeeds* reaches the clean shutdown path. The regression test
  (`test/workerExit.test.js`) forks a real worker with a real IPC channel and
  was confirmed to fail against the unfixed code.
- **The progress rate limiter treated "never pushed" as "pushed at epoch 0"**,
  which happens to work with a real clock and silently swallows the first
  update with any other one.

### Deliberately deferred

- **Remote project creation (`/new`)** — the directive lists it as "eventually",
  and `PHASE_12_PLAN.md` schedules it for M4 with the launcher. The security
  decision it depends on is made *here*, though: `operator.projectRoots`
  exists, defaults to empty, and empty means refuse. Creation will never write
  outside an approved root.
- **The launcher** — M4, per the directive ("do not implement yet"). Nothing in
  M2 blocks it: the service already starts, the console is already a client.
- **Delete / move / rename project** — these operations do not exist anywhere in
  the product yet. When M4 adds them they inherit the confirmation gate built
  here; adding remote-only destructive operations first would be backwards.
- **A "Packaging" phase.** The directive lists it; the mission lifecycle has no
  such state. Reporting one would be simulating work.
- **Desktop changes** — M3. The desktop keeps working through its existing
  bridge; `/api/registry` and `/api/events` are what it will move onto.

## [2.8.0] — 2026-07-27 — Phase 12 M1: AI-Orchestrator Core Service

The first milestone of Phase 12, and the first change to the process model
since P7. AI-Orchestrator stops being "an executable that sometimes runs" and
becomes "a service that clients connect to." Full report:
`docs/PHASE_12_M1_REPORT.md`; plan: `docs/PHASE_12_PLAN.md`.

**THE PHASE 12 INVARIANT (tested):** with no daemon running and no daemon
configuration, every pre-Phase-12 command behaves exactly as in `v2.7.0`.
`ai-orchestrator start <project>` remains a complete, self-sufficient
orchestrator owning its own heartbeat, API server, and Telegram polling. The
service is an additive supervisor, never a required one.

### Added

- **`ai-orchestrator serve`** — the Core Service (`src/daemon/daemon.js`).
  An always-running process that owns the HTTP API, the *exclusive* Telegram
  inbound poll, the scheduler tick, and mission worker lifecycle. It stays
  alive with zero missions running, which is what makes remote operation
  possible at all: before this, the API lived inside the mission process and
  vanished with it, and Telegram was only polled while a mission sat waiting
  on an approval.
- **Simultaneous projects.** `state/workers/<project>.json` re-grains
  supervision ownership from the MACHINE to the PROJECT
  (`src/daemon/workerRegistry.js`). Starting Calculator while Remote Work
  runs was structurally impossible before — `state/heartbeat.json` is a
  machine-wide single-instance lock, and Phase 10H parallelism was fixed at
  launch time. Missions now start and stop independently.
- **`ai-orchestrator daemon status|start|stop|install|uninstall`**, plus
  `serve --stop-missions-on-exit`. `start`, `stop`, and `status` are now
  daemon-aware: with the service up, `status` reports every mission it
  supervises (status.json only ever described one), and `stop [project]`
  stops missions rather than the service.
- **Windows autostart** for the service (`scripts/install-daemon-task.ps1`),
  separate from the existing auto-resume task — they answer different
  questions and either can be installed alone.
- **Mission worker mode** (`start --worker`, `src/app.js`) — the same
  Orchestrator with the same P0–P11 guarantees, minus the four
  machine-singleton duties the service now owns.
- **Daemon API**: `GET /api/daemon`, `GET /api/daemon/workers`,
  `POST /api/daemon/missions/start|stop`. Reads unauthenticated as every GET
  has been since P0; mutations behind the existing P7 token. All gated on an
  optional `daemon` collaborator, so a standalone mission's own API answers
  503 cleanly — the same contract every Phase 10 surface uses.
- **`src/daemon/daemonClient.js`** — one discovery + auth path for the CLI
  today and the desktop (M3) and Telegram router (M2) later.
- **`daemon` config block** — `enabled`, `pollIntervalMs`, `schedulerTickMs`,
  `maxWorkers`, `workerScanMs`, `restartFailedWorkers`.

### Fixed

- **Telegram poll ownership (would have been a livelock).** `getUpdates` is
  offset-acknowledged: polling with `offset=N+1` permanently discards every
  update up to N. A daemon polling alongside a waiting mission would consume
  that mission's `APPROVE A7` reply and leave it waiting forever.
  `ApprovalManager` gained `receiveDecisions` (default `true`, so every
  pre-Phase-12 caller is unchanged); workers set it `false` and pick
  decisions up through the store re-read `waitForDecision()` has performed
  since Phase 10. Outbound publishing is stateless and deliberately not
  gated.
- **Mission workers died with the service** (found in live validation). A
  plain `fork` does not survive its parent on Windows, so killing or
  restarting the service destroyed every running mission. Workers are now
  spawned detached — the same conclusion the desktop reached in Phase 8 —
  and a restarted service re-adopts them from the worker registry.
- **"Stop" did not mean stop gracefully** (found in live validation). On
  Windows, `process.kill(pid, 'SIGTERM')` against another process is
  `TerminateProcess`, not a catchable signal: stopping an adopted worker
  killed it mid-mission while the CLI reported "the session stays resumable."
  Stop requests are now per-project files (the mechanism `stop` has used
  since P0), with a hard kill only as escalation after a grace window.
  `daemon stop` uses the same file mechanism, so a deliberate stop no longer
  reports itself as a crash.
- **The daemon recorded its configured port, not the bound one** — a client
  trusting that record could be sent to a port nothing was listening on.
- **Conflict errors printed stack traces** instead of remedies. All three
  new supervision conflicts now go through Phase 11 M3's
  `userFacingError` catalogue (cause / impact / fix).

### Deliberately deferred

- **Notification routing stays with workers.** Moving it into the service
  while workers still emit their own would duplicate every event — the exact
  class Phase 11 M2 spent a milestone eliminating. It belongs with M2's
  Mission Card work, where the sending side is being rewritten anyway.
- **No new Telegram command grammar.** The service polls with the same
  `parseDecisionText` parser workers used, so the set of accepted messages is
  byte-for-byte `v2.7.0`. Widening it is M2, behind its own security review.
- **No desktop changes.** The desktop keeps working through its existing
  live/idle bridge; making it a true multi-project daemon client is M3.

## [2.7.0] — 2026-07-27 — Phase 11 M4: UX Consistency, Remote Polish & Documentation

The fourth and final Phase 11 milestone. Prioritized consistency, clarity,
and operator confidence over new platform capabilities, per the owner's
explicit brief. No architecture changed. Full report:
`docs/archive/phase-11/PHASE_11_M4_REPORT.md` (also the Phase 11 retrospective).

### Added

- **`src/shared/vocabulary.js`** — one source for mission-outcome icons/
  labels, approval-decision labels, verification-confidence labels, and
  check marks. Fixed a confirmed drift: the same "mission succeeded" outcome
  rendered as three different icons (CLI's ✔, a notification title's 🎉,
  a Mission Card's ✅) purely because each surface had its own inline
  literal — all three now agree on ✅.
- **`src/infra/version.js`** — the version was hardcoded separately in
  `package.json`, the CLI's `.version()`, and `statusManager.js`, kept in
  sync by hand at every release. All three now read from here; a version
  bump is one line instead of three (this release is the first to prove it).
- **Startup banner** (`src/cli/banner.js`) — printed once when `start`
  launches: version, project(s), resolved approval mode, enabled
  notification channels.
- **`notify tune`** — interactive per-channel `minSeverity` setting (the
  config key has existed since Phase 10F but only via hand-edited JSON).

### Fixed

- **Desktop/CLI parity bug**: the desktop app's in-app "create project"
  never set `claude.permissionMode`, unlike the CLI's `projects add`
  (defaults to `acceptEdits` since 10.5/M1). An unattended headless engine
  can't answer permission prompts, so a desktop-created project would
  silently accomplish nothing on its first real mission. Found during M4's
  cross-product consistency audit; both paths now behave identically.
- `REPORT_AVAILABLE_NOTE`'s wording — it claimed a report was "attached
  separately" even for channels (email) with no `sendDocument` support,
  which never actually attaches anything. Reworded to state both outcomes
  without asserting which one a given channel gets.
- `docs/CLI_GUIDE.md` was missing `init`, the entire `notify` command group,
  `doctor --fix`, and `projects add --interactive` — despite being billed as
  "every command." `README.md`'s command table was similarly frozen at a
  pre-Phase-10 state. Both expanded; `docs/FAQ.md` gained missing `init`/
  `notify tune` entries; several other docs gained pointers to the newer
  wizard routes alongside their existing hand-edit instructions.

### Tests

- +31 tests across 5 new/updated files (vocabulary, version, banner, notify
  tune, and the desktop `createProject` fix). Backend suite **608/608** +
  20/20 desktop.
- Live-verified: real Telegram sends confirmed the new icon/wording; a full
  real end-to-end mission (throwaway `mock`-driver project, real child
  process) showed the banner and the unified ✅ completion line together;
  `doctor`/`notify test` re-confirmed unchanged output against the real
  configured environment.

## [2.6.0] — 2026-07-27 — Phase 11 M3: Doctor, Recovery & Operator Guidance

The third Phase 11 milestone: every failure now tells the operator what
happened, why, and the single next command — and `doctor` can offer to fix
what it flags. No new architecture; the existing engine and every prior
guarantee are untouched.

### Added

- **`doctor --fix`.** `doctor` is now built from structured findings
  (`{id, status, label, detail, cause, impact, fix?}`) instead of inline
  print statements — the same findings a plain `doctor` run shows are
  exactly what `--fix` iterates over. Read-only by default; with `--fix`,
  each flagged issue is explained (cause/impact/fix) and confirmed
  individually before anything changes. Safe, direct repairs: set
  `claude.permissionMode`, delete an already-useless quarantined corrupt
  state file, install the auto-resume scheduled task. Fixes needing real
  human input (a bot token, a mailbox password, a first project) launch the
  matching Phase 11 M1 wizard instead. The closing summary reports
  recovered/skipped/manual-follow-up counts.
- **Two new `doctor` checks**, both evidence-based: quarantined
  `*.corrupt-*` state files (the system already self-heals from corruption
  by quarantining a damaged file and falling back to defaults — this
  surfaces what happened instead of leaving it visible only in the logs),
  and a resumable session nobody is currently supervising (informational —
  continuing vs. discarding is the operator's call, so no auto-fix; both
  next commands are named).
- **`src/infra/errors.js`** — a `userFacingError({cause, impact, fix})`
  helper so every expected error (audited: `projects add`, `notify setup`,
  `notify resend`, the missing-engine start error) states its cause, impact,
  and fix in the same consistent shape, instead of each call site
  hand-rolling its own message.
- **Guided recovery in existing commands:** `tasks list` now prints the
  exact `tasks approve`/`tasks skip <project> <id>` command when the
  current task is blocked/failed; `approvals list` prints the exact reply
  (or the CLI equivalent) next to each pending request.

### Tests

- +29 tests across 4 new/updated files (doctor findings/fix/renderer,
  the error catalogue, the two guided-recovery hint functions). Backend
  suite **585/585** + 18 desktop.
- Live-verified against the real repo: `doctor` confirmed to produce
  identical output to the pre-refactor version for every existing check;
  `doctor --fix` found and cleanly deleted a genuine leftover quarantined
  file from a Phase 10.5 failure simulation; a real blocked task showed the
  exact recovery hint in `tasks list`; real pending owner-gate and
  human-action requests each showed the correct reply hint.

## [2.5.1] — 2026-07-27 — Phase 11 M2: Operational Validation

A dedicated live-validation pass on v2.5.0, following the project's own
"build → live validate → fix real-world issues → then continue" discipline.
Every M2 claim (dedup, formatting, attachments, Mission Cards) was proven
against the owner's real Telegram bot, real missions, and — where it
mattered — the owner's own phone. Full report: `docs/archive/phase-11/PHASE_11_M2_VALIDATION.md`.

### Fixed

- **`approval:resolved` was wrongly auto-excluded.** The M2 provider+channel
  dedup fix had over-broadly excluded the resolution notification too, even
  though neither the Telegram nor email approval provider ever announces a
  resolution itself (each has only `publish()` for the initial request).
  This silently killed the only notification an owner gets when a decision
  is made out-of-band (CLI/API/desktop) while away from Telegram. Found
  while designing the validation's first live test, before it ever reached
  a real phone.
- **Raw filesystem paths shown to a remote operator.** Found from the
  owner's own phone check: `mission:blocked`/`release:created` printed the
  raw absolute path (`C:\Users\...\report.pdf`) directly in the Telegram
  message — meaningless to a phone that can't open a Windows path. Both
  now say the report is attached (where the channel supports it) or
  available on the workstation, never the path itself.

### Validated (no code change — investigated, confirmed, documented)

- Desktop toast notifications can't support click-to-open on Windows —
  `node-notifier`'s `WindowsToaster` integration has no click-handler
  support at all (only macOS's `NotificationCenter` does); a real platform
  ceiling, not a wiring gap. See TROUBLESHOOTING.md.
- `mission:complete` is intentionally summary-only (no attached source
  files) — `EVENT_ATTACHMENT` only covers events with a single generated
  report document (`mission:blocked`/`release:created`); attaching every
  changed file per completion would be noise. Now stated explicitly in
  CONFIGURATION.md.

### Tests

- +8 tests (4 for the `approval:resolved` exclusion fix, 4 for the raw-path
  fix). Backend suite **556/556** + 18 desktop.
- Live-verified end to end: 4 real-API instrumented dedup/timing checks, a
  complete phone-first mission with the owner's genuine Telegram reply, two
  real-process recovery scenarios (hard crash + graceful stop/resume), and
  multi-project isolation — all against the real Telegram Bot API.

## [2.5.0] — 2026-07-26 — Phase 11 M2: Phone & notification experience

The second Phase 11 milestone, driven directly by a live operator
walkthrough of v2.4.0. Every item below traces to a confirmed defect, not
a guess: duplicate Telegram approval messages (two distinct causes),
`README.md` rendering as a dead link, and a plain-text mission-complete
message with no structure.

### Fixed

- **Duplicate approval notification, cause 1 — resume/crash re-publishing.**
  A stop/resume or crash recovery that re-entered a task/gate whose
  decision never arrived called `requestApproval()` again, which always
  minted a NEW request id and re-published it. A new
  `ApprovalStore.findPending()`, reused by `ApprovalManager.requestApproval()`,
  now returns the existing pending request as-is — no new id, no
  re-publish, no re-announcement.
  Verified with an integration test using TWO independent Orchestrator/
  ApprovalManager instances sharing only on-disk state (a real process
  restart), not the same in-memory instance.
- **Duplicate approval notification, cause 2 — provider + channel both
  firing.** Confirmed on the live config: with both
  `notifications.telegram.enabled` and `approvals.providers.telegram.enabled`
  true (a common setup — `approval:required` is a default subscribed
  event), every approval sent TWO near-identical Telegram messages, from
  two different code paths. The notification engine now auto-excludes
  `approval:required`/`human-action:required`/`approval:resolved` on a
  channel whose matching approval provider is already delivering them
  (operators can still name extra exclusions via a new per-channel
  `excludeEvents` config).
- **`README.md`/`DiagnosticReport.md` rendering as dead links on the
  phone.** Telegram sent every message with no `parse_mode`, so its
  auto-linkification ran unrestricted (`.md` happens to also be a ccTLD).
  Every Telegram send now uses `parse_mode: 'HTML'` with a new
  `formatTelegramText()` that escapes the text and wraps filename-like
  tokens in `<code>` — real URLs (including ones ending in a report
  extension) are left as single, unbroken, clickable links.

### Added

- **Formal notification idempotency** (`state/notifications/<project>.json`):
  once a notification with a stable identity (an approval/human-action
  request) is sent, it is never resent unless the previous delivery
  failed, an explicit reminder interval elapses (`notifications.reminderMs`,
  default off), or the operator runs the new `notify resend <project> <id>`.
- **Real Telegram document attachments.** `TelegramChannel.sendDocument()`
  (multipart upload via Node's global `FormData`/`Blob` — no new
  dependency) attaches a real file directly. `mission:blocked`'s diagnostic
  report and `release:created`'s release notes are now attached as real
  files (in addition to the safely-formatted text mention) whenever the
  channel supports it.
- **Executive Mission Cards.** Mission-complete and mission-blocked
  notifications now carry a structured card — duration, tasks done, files
  changed, tests passed, an honest confidence label (verified/partial/
  unverified — never dressed up), the real git commit the mission ended
  on, and (when blocked) the operator's exact next command — assembled
  from data the orchestrator already had, nothing new tracked.
- `notify resend <project> <id>` — force-resends one pending approval,
  bypassing the idempotency dedup, reusing the original message rendering.

### Tests

- +80 tests across 7 new/updated files (approval reuse, notification
  idempotency, provider/channel dedup, Telegram formatting, the Telegram
  channel's send/sendDocument — both previously untested at the unit
  level — and Mission Cards, including two real orchestrator integration
  tests). Backend suite **550/550** + 18 desktop.
- Live-verified against the REAL Telegram Bot API (not just mocked fetch):
  a text message and a document attachment both delivered successfully,
  and a realistic Mission Card rendered correctly with the actual git HEAD
  of this repo.

## [2.4.0] — 2026-07-14 — Phase 11 M1: Onboarding & first-run wizards

The first milestone of Phase 11 (operator experience). A brand-new user now
reaches a working project — and a phone that receives approvals — without
editing a single JSON file. Every wizard is a config writer only: it writes
the same `config/*.json` an expert edits by hand, so the optional-collaborator
invariant is untouched (a config with none of these keys behaves exactly as
before). CLI-first this milestone; desktop onboarding is a later phase.

### Added

- **`ai-orchestrator init`** — a guided first-run flow: environment probes,
  first-project creation, Telegram + email setup, the optional auto-resume
  task, a live channel test, and a "you're ready" summary. Idempotent and
  re-runnable; every step is skippable.
- **`projects add --interactive` (`-i`)** — a project-creation wizard that
  asks the questions, creates the working directory and a starter prompt when
  missing, and runs the result through the loader's own `validateProject`
  before writing. Removes the #1 new-user failure (a project born unable to
  write). `<name>`/`--dir`/`--prompt` are now optional; the non-interactive
  path is unchanged but errors with a remedy-first message when they're
  missing.
- **`notify setup telegram`** — validates the BotFather token via `getMe`,
  **discovers your chat id automatically** by polling `getUpdates` (detecting
  an active webhook and explaining the fix), sends a live test, and writes
  `notifications.telegram` + `approvals.providers.telegram`.
- **`notify setup email`** — collects SMTP settings (Gmail App-Password path
  spelled out), sends a real test email, translates the common SMTP failures
  (535 auth, STARTTLS, connection) into plain-language remedies, and writes
  `notifications.email` + `approvals.providers.email`.
- **`ConfigManager.writeLocalConfig(patch)`** — deep-merges a patch into the
  git-ignored `config/local.json` (preserving existing keys): the single
  sanctioned way the wizards persist credentials without touching the tracked
  `orchestrator.json`.
- **`src/onboarding/`** — a small, TTY-free prompt harness (`prompts.js`) and
  the wizards (`projectWizard.js`, `notifyWizard.js`, `init.js`), all
  injectable so every flow is unit-tested with no terminal or network.
- **Docs:** new `docs/DAY_ONE.md` (the guided "0 → first phone approval"
  page the wizards mirror); QUICKSTART/TELEGRAM_SETUP/EMAIL_SETUP now lead
  with the wizard and keep the manual steps as the "by hand" route.

### Tests

- +32 tests (prompt harness, `writeLocalConfig`, project wizard, Telegram/
  email wizards, `init` orchestration); backend suite **468/468** green.
- `init` and the project wizard verified live end-to-end through the real
  readline prompter.

## [2.3.1] — 2026-07-13 — Phase 10.5: Operational Validation & Readiness

An engineering-validation phase (no new architecture). The whole platform
was exercised end-to-end under real conditions: remote notifications
configured and live-verified (Telegram two-way + Gmail SMTP), a real
Claude mission run from approval to commit, the phone approval workflow
driven from an actual phone, ten failure simulations replayed, and
multi-project isolation proven. Seven defects surfaced during the audit
and this pass were fixed at the root.

### Added

- **`config/local.json`** — machine-local config, deep-merged over
  `config/orchestrator.json` and git-ignored, so credentials (SMTP
  passwords, bot tokens) never land in a tracked file. See CONFIGURATION.md.
- **`ai-orchestrator notify test`** — sends a real message through every
  enabled notification channel and prints a per-channel ✔/✘. The missing
  onboarding verifier for remote setup.
- **`ai-orchestrator sessions <project> --abandon`** — archive a stale
  resumable session WITHOUT launching anything, so the next `start` begins
  fresh (refuses if an orchestrator is actively supervising that project).
- **`projects add --permission-mode <mode>`** — the created project now
  includes a `claude.permissionMode` block (default `acceptEdits`); the
  previous behaviour left every new project unable to write unattended.
- **`doctor`** now warns on: a claude project with no write permissions,
  no enabled notification channel beyond desktop, and incomplete
  Telegram/email channel config.

### Fixed

- **Human-action livelock** (found live in the failure sims): a mission
  whose final output merely MENTIONED a blocker word (e.g. "the captcha
  was solved") re-triggered the human-action pause on every relaunch,
  paging the owner forever. Completion (marker / passed verification) now
  outranks fuzzy blocked-pattern matching — verified work never pauses.
- **Per-project `approvals.decisionTimeoutMs`/`decisionPollMs` ignored**:
  `waitForDecision()` read only the global config; it now honours the
  project's effective approval config.
- **`tasks skip`/`tasks approve` left the lifecycle stale**: skipping the
  final blocked task now syncs the mission lifecycle to `completed`
  (approve → `planned`) instead of leaving it stuck at `blocked`.
- **`intel` scored a blocked legacy mission "healthy"**: health scoring
  now also reads the mission lifecycle state, not only the task queue.
- **Missing-engine start error was a raw stack trace**: it is now a
  friendly, remedy-first message (the CLI suppresses the stack for
  user-facing errors).
- **Onboarding trap**: `projects add` + `doctor` (above) close the
  #1 new-user failure (a project born unable to write a single file).

## [2.3.0] — 2026-07-12 — Phase 10: Autonomous Project Manager

From autonomous coding engine to autonomous software engineering MANAGER:
the orchestrator now plans around approvals, communicates through remote
channels, records a standardized mission lifecycle, schedules its own
missions, coordinates parallel missions with shared-resource locks,
analyzes its own history, and automates releases — while the owner keeps
strict control over owner-gated decisions from a phone.

### Added — 10A/10B: the Approval Manager & operating modes

- **`src/approvals/`** — the centerpiece:
  - `approvalPolicy.js`: four approval classes (`automatic`,
    `implementation-review`, `owner-gate`, `human-action`) × three operating
    modes (`conservative` | `balanced` (default) | `autonomous`), decided per
    category. Category lists are configurable; an UNKNOWN category fails
    CLOSED to owner-gate. Modes settable globally and per project
    (`approvals.mode`), via config or `approvals mode --set`.
  - `approvalStore.js`: persisted requests at `state/approvals/<project>.json`
    with globally-unique phone-friendly ids (A1, A2, …), full decision audit
    trail (who/when/via/note), including auto-approved work.
  - `approvalManager.js`: classify → auto-continue or publish-and-pause;
    abortable `waitForDecision()` polling (store + two-way providers);
    emits `approval:required` / `approval:resolved` / `human-action:required`
    exactly once each (deduped across processes).
  - `implementationSummary.js`: a detected plan (output containing
    `approvals.planMarker`, default `IMPLEMENTATION PLAN READY`) becomes an
    owner-facing summary — objective, estimated duration (explicit or tasks ×
    ledger-average run time), estimated files changed, tasks, risks, affected
    systems — published for **APPROVE / REJECT / MODIFY** (MODIFY notes are
    carried into the agent's next briefing).
- **Owner gates**: a task may declare `approval: "<category>"`; owner-gated
  categories (production deployment, data/repo deletion, credentials,
  financial, production config, security, secrets, dangerous — configurable)
  never launch without a decision. Rejection marks the task BLOCKED (the P7
  approve/skip overrides apply) and blocks the mission.
- **Human interaction required**: new blocked-state patterns (CAPTCHA,
  authentication, external login, browser permission, desktop confirmation,
  physical interaction) now pause GRACEFULLY instead of terminally blocking:
  the owner is told exactly what happened, why it stopped, what to do, and
  where — replying `DONE <id>` resumes the mission. With approvals disabled
  the old terminal-block behavior is byte-for-byte preserved.

### Added — 10C: remote approval providers

- **`src/approvals/providers/`** — provider-independent interface
  (`approvalProvider.js`: `publish()` + optional `fetchDecisions()`; shared
  reply grammar `APPROVE/REJECT/MODIFY/DONE <id>`), with two adapters:
  - `telegramProvider.js` (two-way): publishes requests, polls `getUpdates`
    for owner replies (offset persisted; only the configured chat may decide).
  - `emailProvider.js` (publish-only by design — no IMAP dependency): sends
    the request with instructions to respond via Telegram/CLI/desktop.
  - Future WhatsApp/Discord/Slack/push adapters = one subclass each.
- **`src/notifications/smtpClient.js`** — dependency-free SMTP client
  (implicit TLS / STARTTLS / plaintext-for-local-relays, AUTH PLAIN/LOGIN,
  dot-stuffing, header-injection guard). The long-promised **email
  notification channel is now real** (`channels/email.js` placeholder
  replaced) — closes the v1.x "email channel (SMTP)" carry-over.

### Added — 10D: standardized mission lifecycle

- **`src/mission/missionLifecycle.js`**: received → analyzed → planned →
  [approval-pending → approved] → agents-assigned → executing ⇄ verifying ⇄
  fixing → completed | blocked | cancelled | failed. Every transition
  recorded with reason + history at `state/lifecycle/<project>.json`,
  exposed via `GET /api/lifecycle/:project`, the `lifecycle` CLI command,
  and the desktop Missions view.

### Added — 10E/10I: project intelligence & self-improvement

- **`src/intelligence/projectIntelligence.js`** (`intel <project>`,
  `GET /api/intelligence/:project`): health score with named signals,
  is-something-running, next highest-value ready work item, aging approvals,
  blocked-task decisions, dependency stalls, pause-vs-continue advice, agent
  assignment gaps. **Recommendations only — never executes.**
- **`src/intelligence/selfImprovement.js`** (`improve [project]`,
  `GET /api/improvement`): mines ledgers (now with per-run `durationMs` +
  `agentId`), the failure catalog, verification results, agent tallies, and
  the approval audit trail for recurring failures, reliable agents, slow
  agents, verification bottlenecks, always-approved categories (suggests
  automating them), and dominant no-progress patterns. Recommendations only.

### Added — 10F: notification engine expansion

- New events: `approval:required` (critical), `human-action:required`
  (critical), `approval:resolved`, `task:verification-failed` (warning),
  `task:done`, `release:created`, `summary:daily`, `summary:weekly`.
- **Severity policy**: every event has a severity (info/warning/critical,
  overridable via `notifications.eventSeverity`); a global
  `notifications.minSeverity` plus per-channel `minSeverity` decide who gets
  paged for what.

### Added — 10G: scheduled missions

- **`src/scheduler/`** — `cronExpression.js` (dependency-free 5-field cron:
  lists/ranges/steps/names, POSIX dom-vs-dow rule) and
  `missionScheduler.js`: `daily` / `weekly` / `once` / `cron` schedules in
  user-owned `config/schedules.json`, run state in machine-owned
  `state/schedules.json`. Due missions spawn the REAL CLI (`start
  <project>`), never a re-implementation; a running orchestrator defers the
  launch. **Missed-schedule recovery** by default (first sighting anchors a
  schedule; `recoverMissed: false` + grace window opts out).
- CLI: `schedules list|add|remove|enable|disable|run-due|watch`; API:
  `GET /api/schedules`, `POST /api/schedules/...` (auth).
- **Daily/weekly summary digests** (`notifications.summaries`): the watcher
  builds an activity digest (runs, progress, tasks done, blocks, pending
  approvals) and sends it through the notification engine.

### Added — 10H: multi-agent & multi-mission coordination

- **Parallel mission execution by composition**: `start <a> <b> [<c>]`
  supervises several projects in ONE process — each on its own untouched
  Orchestrator instance (every P0–P9 guarantee intact per mission), capped
  by `coordination.maxParallelMissions`. The first project owns
  `status.json`; the rest write `state/status/<project>.json`; one
  heartbeat records all (`projects: [...]`).
- **`src/coordination/`**:
  - `resourceLocks.js`: cross-mission resource locks (task `resources`
    field) — all-or-nothing acquisition, abortable waiting, stale-lock
    reclaim (dead pid / age), release on task completion AND mission end.
  - `dependencyGraph.js`: task `dependsOn` validation (earlier-tasks-only —
    cycles structurally impossible), ready-set computation, conflict
    detection, and an assignment planner with **work stealing**
    (recommendation-only — the declared foundation for distributed
    execution).
  - `agentMessages.js`: durable cross-agent message bus
    (`agent id` / `role:<role>` / `all` addressing); unread messages are
    folded into the recipient's next briefing (or fresh prompt) and marked
    consumed. The orchestrator posts automatic **handoff notes** when the
    next task routes to a different agent; `agents message` CLI +
    `POST /api/messages/:project` post manually.
- **Agent utilization stats**: per-agent `totalRuns`/`totalRunMs`/`avgRunMs`
  in the health report (`agents health`, API, desktop).
- CLI `coordination <project>`: held locks, ready tasks, dependency stalls,
  recent messages. API `GET /api/coordination/:project`.

### Added — 10J: release automation

- **`src/release/releaseManager.js`**: `release prepare <project> <version>`
  generates RELEASE_NOTES.md + VERIFICATION_REPORT.md + release.json under
  `state/releases/` from task checkpoints, verification results, and ledger
  stats. `release apply` is **approval-aware** (`release.approvalCategory`,
  default `commit` → automatic in balanced mode; set an owner-gate category
  to force sign-off; an approval is consumed exactly once): bumps the
  target's package.json, prepends the CHANGELOG entry, git commit + tag.
  **Pushing to a remote is never automated.**

### Changed

- `Orchestrator` accepts four new OPTIONAL collaborators (approvalManager,
  lifecycle, resourceLocks, messageBus) — absent ⇒ byte-for-byte pre-Phase-10
  behavior (all 334 prior tests unchanged and green).
- `validateSingleTask` gains optional `dependsOn`, `resources`, `approval`.
- Progress-ledger records now carry `durationMs` and `agentId`.
- Desktop app: new **Approvals** view (decide requests in one click),
  lifecycle strip in Missions, six new bridge/IPC surfaces.
- `config/orchestrator.json` notification events extended with the Phase 10
  events.
- Release CLI: `--version` collided with commander's program-level version
  flag (found in the live smoke run) — release commands take the version as
  a positional argument instead.

### Fixed

- `approval:resolved` is now announced exactly once even when the decision
  is written by ANOTHER process (CLI/desktop while the orchestrator waits) —
  found live when the lifecycle skipped the `approved` state.

### Verified

- **429/429 tests** (334 prior + 95 new across 12 new test files) plus 18
  desktop-bridge tests.
- **Live smoke pass** (real processes, not mocks): a mission paused on a
  detected implementation plan, was approved via a second CLI process, and
  completed; a past-due `once` schedule was recovered by `schedules
  run-due`, launched a real detached mission, paused on review, and
  completed after approval; `release prepare`+`apply` produced a real
  commit + `v0.1.0` tag in a real git repo; two parallel missions in one
  process serialized on a shared `resources` lock (log-verified:
  "Waiting for locked resources … held by p10-par-a") and both completed.

### Deliberately deferred (documented, not hidden)

- Within-mission parallel task batches (multiple concurrent runs inside ONE
  mission): parallelism ships at mission level; the coordination layer
  (ready sets, locks, assignment planner) is the declared foundation.
- Telegram is the only two-way approval provider; email is publish-only.
- WhatsApp/Discord/Slack/push approval adapters: interface ready, not built.
- The `schedules watch` daemon is a foreground process (pair it with the
  Windows Task Scheduler integration to run at logon).

## [2.2.0] — 2026-07-10 — Phase 9: Multi-Agent Intelligence System

A team of specialized agents in place of a single one. An *agent* is a
named, role-tagged binding of an engine driver + capabilities + engine
settings, layered ON TOP of the existing driver system — tasks route to the
best-fit agent (coding / testing / documentation / research / review /
planner), sequentially, verified between each.

### Added

- **`src/agents/`** — the agent layer:
  - `agentProfile.js`: the `ROLES` vocabulary and pure agent-definition
    validation (mirrors `missionPlan.validateSingleTask`).
  - `agentRegistry.js`: loads `config/agents.json` (global) merged with a
    project's optional `agents` block; wraps the existing `DriverRegistry`
    (each agent references a driver id). **Backward-compat core:** a project
    with no agents configured resolves to a single *implicit* agent wrapping
    `project.driver`.
  - `agentRouter.js`: pure task→agent routing — explicit `agent` id > `role`
    > `capabilities` > project default.
  - `agentHealth.js`: per-agent engine install status + performance tallies
    (tasks done/failed/blocked, attempts, last used) at
    `state/agents/health.json`; never throws into supervision.
- **`src/drivers/cliDriver.js`** (driver id `cli`) — one generic,
  config-driven CLI engine driver so Gemini/Codex/OpenCode/local LLMs are
  added by config, not a class per engine (`command`, `args`, `promptArg`/
  stdin, configurable usage-limit/network regex patterns). Registered in the
  driver registry alongside `claude` and `mock`.
- **Task routing hints**: `validateSingleTask` gains optional `role`,
  `agent`, and `capabilities`. Absent → the default agent (i.e. unchanged).
- **Orchestrator**: resolves the driver **per task** from the routed agent
  (was: one driver per project); switching agents mid-mission starts a fresh
  engine conversation; each checkpoint is stamped with its `agentId`; per-
  agent outcomes are recorded; new `agent:assigned` event; `status.json`'s
  `mission` block gains `currentAgent`/`currentAgentRole`.
- **CLI**: `agents list [project]` and `agents health [project]`.
- **API**: `GET /api/agents[?project=]` and `GET /api/agents/health[?project=]`
  (read-only, like the other GETs).
- **Desktop app**: a new **Agents** view (per-agent role/install/performance
  cards, current agent highlighted); the Tasks view shows each task's agent/
  role and its Add-task form gains role + agent selectors; the Dashboard's
  Agent card shows the current agent + role.
- **Config**: `config/agents.example.json` (Claude coding/review/testing
  agents + disabled Gemini/Codex/OpenCode `cli` presets).
- **Tests**: 39 new — `agentProfile`, `agentRegistry`, `agentRouter`,
  `agentHealth`, `cliDriver` unit suites; `orchestrator.p9` (two-agent
  routing + the legacy-guarantee integration test); plus desktop-bridge
  agent dispatch. **334 total, all green** (the 291 pre-Phase-9 tests
  unchanged).

### Guarantee

A project with no `config/agents.json` behaves **byte-for-byte** as it did
before Phase 9 (one implicit agent = `project.driver`) — asserted by
dedicated unit and integration tests. Backend changes outside `src/agents/`
were limited to the per-task driver resolution in `orchestrator.js`, the
optional task fields, the `status.json` field, and version-string bumps.

### Known limitations (documented, not hidden)

- **Sequential only** — one agent at a time. Concurrent/parallel agents are
  Phase 10 (which owns concurrency); building them now would risk the stable
  single-supervisor core.
- **Inter-agent communication** is handoff via the shared task queue + P5
  memory + P4 briefing (a downstream agent's briefing already carries the
  upstream agent's checkpoint summary), not live message-passing between
  simultaneously-running agents.
- The **Gemini/Codex/OpenCode/local `cli` presets** are real configuration
  but unverified against those actual CLIs (not installed here); `claude`
  and `mock` are the verified reference engines.

## [2.1.0] — 2026-07-07 — Phase 8: Operator Desktop Application

The first real UI on top of P7's dashboard API: an Electron desktop app
(`desktop/`) — a pure client of the existing backend, never a
reimplementation of it. Dashboard, mission control, task queue, timeline,
memory center, logs, and settings, all in one window.

### Added

- **`desktop/`** — a sibling subproject (own `package.json`, own
  `node_modules`; the root project's dependencies/tests are untouched).
  CommonJS main process; plain HTML/CSS/JS renderer (no framework, no
  bundler) — Electron loads the static files directly.
- **`desktop/main/orchestratorBridge.js`** — the dual-mode integration
  layer every IPC handler goes through: when an orchestrator process is
  live (`state/heartbeat.json`), calls the dashboard HTTP API exactly as
  P7 intended ("the UI is purely an API client"); when idle, calls the
  same library classes the CLI's read-only commands use
  (`ConfigManager`/`TaskQueue`/`MemoryStore`/`MissionTimeline`/
  `SessionManager`, all already exported from `src/index.js`) — reuse, not
  duplication, since there is no HTTP server to reach when nothing is
  running. Starting a mission spawns the real `bin/ai-orchestrator.js
  start <project>` as a detached child process (via
  `ELECTRON_RUN_AS_NODE`, no system Node dependency) — the same command a
  human would type — so no supervision logic is reimplemented; stopping
  prefers `POST /api/control/stop`, falling back to the CLI's own
  `stop.requested` file mechanism if the API is unreachable.
- **`desktop/main/logTail.js`** — tails the winston log files for the Logs
  view; works regardless of which process (this app, the CLI, or the
  Scheduler task) started the mission being watched.
- **Seven views**: Dashboard (live status, project grid), Missions
  (start/stop/resume, create a project), Tasks (queue viewer;
  add/remove/reorder/approve/skip), Timeline, Memory Center (notes,
  failure catalog, archived task history), Logs, Settings (API token
  show/rotate, project locations, config file shortcuts).
- 14 new tests (`desktop/test/orchestratorBridge.test.js`, `node --test`):
  live/idle branch selection, HTTP-vs-library dispatch, and the stop
  fallback, against real temp-dir fixtures and a fake `fetch` — no
  Electron/Chromium involved. Also picked up automatically by the root
  `node --test` run (291 total; the 277 pre-existing backend tests are
  unchanged).
- Live-verified via a Playwright `_electron` driver (not committed — a
  throwaway verification script): every view renders without a console
  error; a full mission start → stop (mid-mission) → resume →
  complete cycle against the `mock` driver; and a genuine crash-recovery
  pass — force-killed the spawned orchestrator process mid-mission,
  clicked Start again from the app, and confirmed the Timeline recorded
  "Recovered interrupted session (reboot-or-power-loss)" before completing
  normally.

### Fixed

- A real bug caught during the live-verification pass, not by unit tests:
  the renderer originally mounted every tab into one shared `#view-root`
  element. `missions.js` schedules a delayed re-render after Start/Stop to
  refresh its own live/idle read — if the user switched tabs before that
  timeout fired, it clobbered whatever tab was now showing with stale
  Missions markup. Fixed by giving each tab its own persistent container
  div (`.view-panel[data-view=...]`), so a late callback from a
  since-abandoned tab can only ever write into that tab's own hidden
  container.

### Known limitations (documented, not hidden)

- The Logs view shows orchestrator lifecycle/system events, not the
  agent's raw conversation — confirmed no code path persists full agent
  stdout to disk today. A live child-stdout pipe was deliberately not
  built either: a detached mission must survive the desktop app closing,
  and an unread stdio pipe on an unattended child can fill and block the
  orchestrator's own writes. A per-session transcript file would be a
  reasonable small backend addition later.
- Settings is view-and-create, not a full editor: project locations and
  notification config are shown read-only with a shortcut to the actual
  JSON file; only creating a new legacy (single-prompt) project is fully
  in-app.
- No packaged installer — `npm start` runs the app in dev mode.
  `electron-builder` packaging is a reasonable fast-follow.
- Task `verify` rules are entered as raw JSON, mirroring `tasks add
  --verify-file`, not a visual condition builder.

## [2.0.0] — 2026-07-06 — Phase P7: Desktop Backend — v2 stable

Backend-first, per the roadmap: extends the dashboard HTTP API with
mutating endpoints behind a local auth token. The actual Tauri/Electron
desktop shell is out of scope for this phase — "the UI is purely an API
client," and this is that API's mutation surface. With P7 complete, the
full P0–P7 v2 roadmap ("Autonomous AI Project Manager") is delivered.

### Added

- **`src/api/apiAuth.js`**: a local token (`state/api-token.txt`,
  generated once, `0600`-mode) gates every mutating endpoint below.
  Deliberately not a full auth system — one shared secret, matching the
  "one operator, one machine" model the rest of the CLI already assumes.
  `requireAuth()` checks `Authorization: Bearer <token>` or `X-API-Token`;
  a missing/unconfigured token always 401s (never open-by-default).
- **Mutating dashboard API endpoints** (all require the token; every
  existing read-only endpoint is unchanged and still unauthenticated):
  - `POST /api/control/stop` — gracefully stops the live orchestrator
    (the one endpoint that acts on the in-memory process, not a file).
  - `POST /api/tasks/:project/add|remove|reorder` — mirror the `tasks`
    CLI exactly (same validation, same PENDING-only guards).
  - `POST /api/tasks/:project/approve` / `.../skip` — **new** operator
    overrides (see below), not previously available via CLI either.
  - `POST /api/memory/:project/notes` — mirrors `memory add`.
  - `POST /api/memory/:project/failures/:id/resolve` — mirrors `memory resolve`.
- **`TaskQueue#approveRetry()`**: resets a BLOCKED/FAILED **current**
  task back to PENDING (attempts/checkpoint/verify-result cleared) so the
  next `start` retries it, instead of falling through to a static-plan/
  legacy restart. The only sanctioned way to re-enter a task that
  `block()` shut the door on — always an explicit operator decision,
  never automatic, preserving P0's loop-prevention guarantee.
- **`TaskQueue#operatorSkip()`**: marks the current BLOCKED/FAILED task
  DONE (with an `operator-skipped` checkpoint noting why) and advances
  past it — for when automated verification can't be satisfied but a
  human has confirmed the work is acceptable. Only ever the current task,
  only from a terminal state — can never touch a live/ACTIVE task, so it
  can never interfere with a live agent (by the time a task is
  BLOCKED/FAILED, `block()` has already closed the session and the
  orchestrator process has already exited).
- **CLI**: `tasks approve <project> <taskId>`, `tasks skip <project>
  <taskId> [--reason]`, `api-token [--rotate]`.
- 26 new tests: `TaskQueue#approveRetry()`/`operatorSkip()` unit tests
  (including refusing a non-current or non-terminal task, and proving the
  approved queue gets ADOPTED rather than reinitialized by the next
  session), `apiAuth` unit tests (token generation/persistence/rotation,
  middleware accept/reject, and the "no token configured = always 401"
  safe default), and a real-HTTP `DashboardServer` integration suite
  (ephemeral port, real `fetch` calls) covering every mutating endpoint's
  auth gate and actual on-disk effect. 277 tests total. Verified live: a
  real `App` instance supervising a real mock mission, stopped via a
  genuine HTTP POST to `/api/control/stop` with the auto-generated token
  — session correctly preserved for resume, exactly as the CLI's `stop`
  already guaranteed.

### Known limitations (documented, not hidden)

- No actual desktop application ships in this phase — Tauri/Electron
  shell, mission dashboard UI, timeline visualization, etc. are explicitly
  future work building **on top of** this API, not delivered here.
- The auth model is intentionally minimal: one static shared token, no
  expiry, no per-action scopes, no multi-user support. Sufficient for
  "one operator, one machine, gating accidental/remote mutation," not a
  multi-tenant or internet-facing deployment model.
- `approveRetry`/`operatorSkip` assume single-process operation (no
  orchestrator concurrently supervising the same project while an
  operator calls them) — true by construction today (a task can only be
  BLOCKED/FAILED after the process that hit it has already exited), but
  would need reconsideration if multi-process supervision is ever added.

## [2.0.0-rc.1] — 2026-07-06 — Phase P6: Verification Engine Expansion

Extends the same `verifierRegistry.js` P2 shipped — not a rewrite — with
three new verifier types. Every existing verifier, the registry contract,
and every caller (mission engine, Continuation Builder) are unchanged.

### Added

- **`json-schema` verifier**: validates a JSON file against a schema
  (inline `schema` or an external `schemaFile`). A small, dependency-free
  validator — no ajv/etc. — supporting `type`, `required`, `properties`,
  `items`, `enum`, `minimum`/`maximum`, `minLength`/`maxLength`, `pattern`.
  Explicitly NOT a full JSON Schema draft implementation (no `$ref`,
  `oneOf`/`anyOf`/`allOf`, `additionalProperties`, format validators) —
  documented as a bounded subset rather than silently unsupported.
  Failure detail names the exact field and reason, e.g. `at "$.port":
  expected integer, got string`.
- **`lint` verifier**: same execution model as `command`, but when the
  command's output parses as ESLint's `-f json` shape, the failure detail
  becomes a specific, ranked problem list (`src/a.js:12 [no-unused-vars]
  'x' is never used`) instead of a wall of raw stdout. Any other linter's
  output (or ESLint without `-f json`) falls back to the same
  exit-code-and-truncated-output detail `command` already produces.
- **`dependency` verifier**: checks a project's `package.json` declares a
  named package (`dependencies`/`devDependencies`/`peerDependencies`, or
  a narrower `where`) and, unless `installed: false`, that it's actually
  present in `node_modules` — catching the common half-finished case of
  editing `package.json` without ever running `npm install`.
- **Continuation Builder**: `describeVerifier()` gained readable
  descriptions for all three new types, so a task gated by them renders
  properly in the "checks pass" section of a retry briefing instead of
  falling through to the generic `(see project config)` fallback.
- 15 new verifier unit tests (all three types: pass, specific failure
  detail, and edge cases like missing files/invalid JSON/non-JSON lint
  output) plus a real orchestrator integration test proving a
  `dependency` verifier gates actual task completion and retry through
  the full supervision loop. 251 tests total. Verified live via a direct
  script exercising all three verifiers against real files.

### Known limitations (documented, not hidden)

- `json-schema` is intentionally a subset (see above) — a project needing
  full draft compliance should verify via a `command` verifier invoking
  a real JSON Schema CLI instead.
- `lint`'s rich failure detail only activates for ESLint's exact `-f json`
  array shape; every other linter gets the same generic detail `command`
  always provided (still functional, just less specific).
- `dependency` only understands npm's `package.json`/`node_modules`
  layout — no support for other package managers' lockfile-only
  installs (e.g. pnpm's content-addressed store) where a package can be
  installed without a matching `node_modules/<name>` directory existing.
- The verifier registry remains deliberately NOT plugin-extensible (a P2
  decision, reaffirmed here) — a closed, known set validated at
  config-load time. Revisit only if a real, concrete need emerges.
- Verification outcomes are NOT wired into `assessConfidence()`'s
  existing `'verified'` signal extension point, despite earlier ROADMAP
  language suggesting P6 would do so — verification already
  authoritatively decides mission-mode task completion, so a
  confidence-score bump for the same decision is redundant, and the
  ledger record for a run is written before that run's verification even
  executes. ROADMAP.md corrected to reflect this rather than leave a
  stale promise standing.

## [2.0.0-beta.2] — 2026-07-06 — Phase P4: Continuation Builder + Phase P5: Memory

Replaces the single static `continuePrompt` string — sent unchanged on
every resume, retry, or crash recovery since v1 — with a structured
briefing generated from live orchestrator state on every relaunch.

### Added

- **`src/briefing/continuationBuilder.js`**: `buildLegacyContinuation()`
  (single-prompt missions) and `buildTaskContinuation()` (mission mode,
  scoped to the current task). Both turn orchestrator state the agent
  would otherwise have to rediscover — completed tasks (so they're never
  redone), remaining tasks, and recent ledger activity — into one prompt.
  The headline feature: on a retry after a failed verification,
  `buildTaskContinuation()` names **exactly which check failed and why**
  (`file-exists failed: Not found: out.txt`), not a generic "try again".
- **`TaskQueue#recordVerifyResult()`**: stores the current task's latest
  verification outcome on every attempt (pass, retry, or exhausted),
  independent of `checkpoint` (which is only set on a terminal outcome).
  This is what the builder reads to explain a failed retry.
- **`Orchestrator#buildContinuationPrompt()`**: the single call site both
  supervision modes now route through for a resume/retry prompt. Reads
  `config.briefing` (`enabled`, `recentRunCount`); `enabled: false` (the
  default in hand-built configs that omit the block) reverts to the old
  static-string behaviour byte-for-byte — a deliberate escape hatch, not
  a migration requirement.
- **`ORCHESTRATOR_DEFAULTS.briefing`**: `{ enabled: true, recentRunCount: 3 }`
  — on by default for real deployments.
- **`MockDriver#receivedPrompts`**: every prompt a test launch was called
  with, in order — lets orchestrator-level tests assert on real prompt
  content instead of parsing logs.
- 15 new tests: 11 unit tests for both builder functions (including the
  "does NOT list a passing check as a failure" negative case), and 4
  orchestrator integration tests proving the real supervision loop feeds
  a failed task's specific verifier failure into the very next launch's
  prompt — verified live via a direct call into the builder as well.

### Known limitations (documented, not hidden — P4)

- `recentRunCount` is a flat cap, not adaptive to prompt-size budgets —
  a task with very long `resultText` entries could still produce a long
  briefing (each entry is capped at 300 chars, but there is no overall
  briefing-length ceiling).

Phase P5 immediately follows, closing the one gap P4 explicitly deferred:
the briefing above only drew on *this session's* ledger activity, with
nothing surviving past the data structure that produced it.

### Added (Phase P5 — Memory)

- **`src/memory/memoryStore.js`**: cross-session project memory, persisted
  at `state/memory/<project>.json`, in three categories:
  - `notes` — operator-authored durable facts (`memory add` CLI),
    categorized `project` or `architecture`. Never auto-added or removed.
  - `failures` — auto-recorded every time `Orchestrator#block()` fires (a
    BLOCKED or FAILED terminal outcome), independent of session or
    task-queue lifetime. An operator marks one resolved (`memory resolve`)
    once its cause is fixed; only unresolved failures are surfaced.
  - `taskHistory` — archived from a task queue's DONE/FAILED/BLOCKED tasks
    right before `TaskQueue` reinitializes and would otherwise discard
    them (a static-config edit mid-mission). A later plan reusing the
    same task id can now see what happened last time.
- **`TaskQueue` gains an optional `memoryStore` dependency**: calls
  `archiveTaskHistory()` immediately before a plan-shape-changed
  reinitialization discards the outgoing queue's tasks — this was a real,
  silent data-loss gap in P3's reinit path, closed here rather than
  carried forward.
- **The Continuation Builder (P4) now folds in memory**: both
  `buildLegacyContinuation()` and `buildTaskContinuation()` accept
  `memoryNotes`/`activeFailures`, rendered as "Project memory" and "Known
  problems from past attempts" sections; `buildTaskContinuation()` also
  accepts `priorAttempts` (this task id's archived history), rendered as
  "attempted before, under an earlier version of this plan".
  `Orchestrator#buildContinuationPrompt()` fetches all three from
  `this.memoryStore` before delegating — no other call site changed.
- **CLI**: `memory list <project>` (shows notes/failures/task history),
  `memory add <project> --note "..." [--category project|architecture]`,
  `memory resolve <project> <failureId>`.
- **API**: `GET /api/memory/:project` — read-only, mirrors `/api/tasks/:project`.
- **`paths.memoryDir`** (`state/memory/`) added to path resolution and
  runtime directory creation, alongside every other state subdirectory.
- 23 new tests: `MemoryStore` unit tests (persistence, note/failure/
  task-history lifecycle, graceful no-op when `memoryDir` is unset),
  `continuationBuilder` tests for the three new sections, a `TaskQueue`
  test proving archiving fires exactly on plan-shape reinitialization
  (and only for terminal tasks — an ACTIVE task has nothing to archive),
  and 5 orchestrator integration tests proving a real `block()` records a
  failure and a real continuation prompt carries operator notes and the
  unresolved-failure catalog. Verified live via the `memory add`/`memory
  list` CLI commands.

### Known limitations (documented, not hidden — P5)

- Memory is per-project only; there is no cross-project memory (e.g. "a
  pattern that recurs across every project using this driver"). Revisit
  if a real multi-project pattern emerges.
- `taskHistory` accumulates without pruning — a project reinitialized
  many times over its life grows an ever-longer archive. Harmless at
  realistic scale (JSON file, read in full only per-project), but not
  bounded the way `recentNotes`/`activeFailures` are at read time.
- Failures are never auto-resolved — even a task that later succeeds
  leaves its earlier failure entry `resolved: false` until an operator
  runs `memory resolve`. This is deliberate (an operator should confirm
  the *cause* was actually fixed, not infer it from one later success),
  but means the catalog can go stale if operators don't maintain it.

## [2.0.0-beta.1] — 2026-07-06 — Phase P3: Persistent Prompt Queue

Makes P2's task plan runtime-mutable: `tasks add/remove/reorder` build up
or adjust a project's mission without editing JSON, reusing the exact same
`TaskQueue` rather than introducing a parallel structure.

### Added

- **`TaskQueue` mutation methods**: `enqueue()` (append a task, carrying
  its full normalized definition), `removeTask()` and `reorderTask()`
  (both refuse anything that isn't `PENDING` — never touch an active,
  done, failed, or blocked task), `ensure()` (load-or-create an empty,
  session-less queue for bootstrapping).
- **`missionPlan.validateSingleTask()`**: extracted from
  `normalizeAndValidateTasks()` so the CLI's `tasks add` validates a new
  task through the exact same path as the static config array — one
  validation path, not two that could quietly disagree.
- **CLI**: `tasks` is now a command group — `list` (the P2 display, moved
  here), `add --id --prompt [--objective] [--max-runs] [--verify-file]`,
  `remove <taskId>`, `reorder <taskId> up|down`.
- **Queue entries now carry their full task definition** (objective,
  resolvedPromptFile, continuePrompt, verify, maxRuns), not just runtime
  state — the orchestrator reads a task's definition straight off its
  queue entry instead of looking it up in static config by id. This is
  what lets a CLI-enqueued task (never declared in `project.tasks` at all)
  run with zero special-casing anywhere in the orchestrator.
- **`getOrInitialize()` adoption generalized**: previously only a queue
  belonging to the *same* session was reused; now any queue whose current
  task is still `PENDING`/`ACTIVE` is adopted regardless of session
  lineage. This is what makes queued-but-never-run tasks, and tasks
  appended after a prior mission already completed, actually run on the
  next `start`.
- 21 new tests: `TaskQueue` mutations, `validateSingleTask()`, and a
  5-scenario orchestrator integration suite proving a project with **no
  static `tasks` at all** can be driven end-to-end by the CLI queue
  (including reordered execution order and removed tasks never running).
  Verified live via the real CLI: queue two tasks, reorder, `start`, and
  confirm the reordered task ran first.

### Fixed (caught while implementing the adoption-rule generalization)

- The first draft of the generalized adoption rule checked only
  `currentIndex < tasks.length` ("is there a task left") — which does NOT
  distinguish a genuinely idle task from one sitting `BLOCKED` or `FAILED`
  at the current position (`block()`/`markFailed()` never advance the
  index). That draft would have let a brand-new session silently
  re-attach to a **blocked** mission's stuck task — exactly the loop P0
  exists to prevent. Caught by an existing P2 test whose expectations
  the naive rule violated; fixed by checking the current task's own state
  (`currentIsResumable()`) instead of the index alone, and added a
  dedicated regression test (`getOrInitialize() NEVER re-adopts a BLOCKED
  task under a new session`) so this cannot silently regress again.
- Two old orchestrator test harnesses (`orchestrator.test.js`,
  `orchestrator.p0.test.js`) predated `paths.tasksDir` and crashed once
  mission-mode detection started checking for an existing queue
  unconditionally; `TaskQueue.load()` now also guards against a missing
  `tasksDir` directly (returns `null`, matching "no queue" semantics)
  rather than relying solely on callers to supply a complete `paths` object.

### Known limitations (documented, not hidden)

- `tasks add` requires the target project to already pass full config
  validation (`workingDirectory`, `driver`, and either `promptFile` or
  existing `tasks`) — it layers mission content onto an already-valid
  project rather than bootstrapping one from nothing.
- Cross-session task memory (e.g. "T1 was already done in a previous,
  now-abandoned attempt") is not tracked — Phase P5.

## [2.0.0-alpha.3] — 2026-07-06 — Phase P2: Mission System

Converts the orchestrator from a single-prompt supervisor into a true
mission engine: a project may now define an ordered plan of **tasks**,
each independently verified — "Claude does not determine success;
verification determines success" — while every existing single-prompt
project keeps running exactly as before.

### Added

- **Mission plan** (`src/mission/missionPlan.js`): validates and normalizes
  a project's `tasks` array at config-load time (fail fast, actionable
  errors); `isLegacyMission()` is the single switch between v1 behaviour
  and mission mode.
- **Task queue** (`src/mission/taskQueue.js`): persistent progress through
  the plan — current task, attempts, state, checkpoint — at
  `state/tasks/<project>.json`. Scoped to the session id, so a crash,
  usage limit, or reboot resumes the *same task*, not the mission from
  task 1 (verified with a dedicated reboot-survival integration test).
- **Task lifecycle** (`src/mission/taskState.js`): PENDING → ACTIVE → DONE,
  with FAILED/BLOCKED terminal states on exhausted retries or a detected loop.
- **Verification engine (core)** (`src/verify/`): `file-exists`, `command`,
  `output-contains`, `files-changed` verifiers plus a registry that runs
  them in isolation (one failing/throwing verifier fails only itself).
  `files-changed` deliberately reuses the P1 progress engine's change facts
  rather than re-invoking git — one source of truth for "what changed".
  This is P6's foundation, not a placeholder to be replaced.
- **Checkpoints** (`src/mission/checkpoint.js`): structured, data-only
  record of a task's outcome (files touched, verify results, summary) —
  scoped deliberately to data; turning it into a Claude-facing briefing is
  Phase P4, not pulled forward here.
- **Orchestrator integration**: `handleTaskCompletion()` runs a task's
  verifiers (or the marker fallback) instead of the legacy marker-only
  check; passing advances to the next task's own prompt (same engine
  conversation); failing retries with `continuePrompt` up to the task's
  `maxRuns`, then **blocks** with a diagnostic report — exhausted
  verification is never silently skipped, mirroring P0's stagnation
  breaker (which still runs in parallel as an extra net).
- **Observability**: `status.mission` (current task, position, state,
  attempts) surfaced in `status.json`/`/api/status`; new `ai-orchestrator
  tasks <project>` CLI command and `GET /api/tasks/:project`; `task:done`
  event recorded on the mission timeline and available to plugins.
- 66 new tests (missionPlan, taskQueue, checkpoint, verifiers, StatusManager
  — previously untested directly — and a 9-scenario orchestrator
  integration suite covering multi-task completion, retry, exhaustion,
  usage-limit/crash-mid-task resume, and reboot survival). 109 → 175 total,
  all passing.

### Fixed

- **Mock driver fidelity bug, caught by writing these tests**: scripted
  `writeFile`/`appendFile` effects silently failed (swallowed by a bare
  `catch`) when the target's parent directory didn't exist yet (e.g.
  `src/index.js` when `src/` isn't created), unlike real agents which
  create parent directories automatically. Now mirrors that behaviour.

### Changed

- `configManager.validateProject()`: `promptFile` is required only in
  legacy mode; a mission-mode project (non-empty `tasks`) validates each
  task's own prompt instead, and surfaces every task problem (missing id,
  duplicate id, missing prompt file, unknown verifier type) in one error.
- `PROJECT_DEFAULTS` gained `tasks: []` and `progress: {}` documented as
  first-class, empty-by-default fields.

### Known limitations (documented, not hidden)

- Editing a project's `tasks` mid-mission (same session, different task
  ids) reinitializes the queue rather than reconciling the diff — logged
  clearly, not silently guessed at.
- A brand-new session after a `blocked` mission always restarts task 1;
  cross-session task memory arrives with Phase P5.
- The verifier registry is a fixed, known set (not plugin-extensible) by
  deliberate choice this phase — revisit if a real need emerges.

## [2.0.0-alpha.2] — 2026-07-06 — Phase P1: Progress Engine

Promotes P0's yes/no workspace signature into a first-class, structured
progress engine, and fixes a real correctness gap discovered while building
it.

### Added

- **`src/progress/progressEngine.js`**: replaces P0's git-status-based
  signature with a bounded full-tree scan (`size:mtime` per file, skipping
  only noise directories) plus git HEAD tracking. Snapshots persist at
  `state/progress/<project>.snapshot.json` and diff against the previous
  run to produce **structured change facts**: `created`/`modified`/`deleted`
  file lists and counts, and whether a git commit was made.
- **Per-project `progress` config override**: a project's own
  `config/projects/<name>.json` may set a `progress` block (e.g. a higher
  `maxConsecutiveNoProgress` for a project with long research phases);
  omitted keys fall back to the global setting. `PROJECT_DEFAULTS.progress`
  documents this as an empty object.
- Ledger records now include `changes` (counts) and `changedFiles` (sampled
  lists, capped at 25 entries each) alongside the existing progress fields.

### Fixed

- **The P0→P1 gap**: P0's signature relied on `git status`, which is blind
  to anything matched by `.gitignore`. Agent work inside a git-ignored
  directory (a common case — build output, scratch files) registered as "no
  progress" and could trip the circuit breaker incorrectly. P1's full-tree
  scan sees those files; verified end-to-end (`test/progressEngine.test.js`,
  *"THE P0 GAP FIX"*) and via a live CLI run against a real git repo with a
  `.gitignore`d directory.
- **A confidence-scoring bug caught during this phase's own smoke testing**:
  `progressConfidence.js` matched method names (`'git'`/`'filescan'`)
  belonging to the module P1 just replaced. `progressEngine.js` reports
  `'git+scan'`/`'scan'`, which matched neither branch, so every P1 progress
  verdict silently scored as the lowest tier regardless of actual evidence
  — confidence would have read "low" even for a clean git commit. Fixed by
  matching method *tiers* (substring match) instead of exact P0-era strings;
  regression-tested (`test/progressConfidence.test.js`).
- Removed `src/progress/workspaceSignature.js` (fully superseded — kept it
  would have meant two overlapping, subtly different implementations of the
  same concept; see ARCHITECTURE.md for the `size:mtime` vs. content-hash
  trade-off this makes explicit).

### Known limitations (documented, not hidden)

- Change detection uses file `size:mtime`, not content hashing — chosen
  deliberately since P1 scans the *whole* tree (necessary to catch
  git-ignored work) and hashing every file's content on every run would not
  scale. A file touched without content changes could register a false
  "modified" — harmless in this system's fail-safe direction (see
  ARCHITECTURE.md's "Progress awareness" section for the full reasoning).
- `progress` config remains per-project or global only; there is no
  per-task granularity yet (arrives with the P2 mission system).

## [2.0.0-alpha.1] — 2026-07-05 — Phase P0 complete & locked

Finalizes Phase P0 of the v2 "Autonomous AI Project Manager" line and marks
it as the locked foundation (see [ROADMAP.md](ROADMAP.md) for the phase plan
and version-snapshot scheme). Builds on the 1.1.0 loop-prevention core with
the classification and observability primitives every later phase consumes.

### Added

- **Standardized exit reasons** (`src/core/exitReason.js`): every run is
  classified into a fixed, engine-agnostic vocabulary — `progress`,
  `completed`, `no_progress`, `blocked_permission`, `blocked_tool`,
  `blocked_missing_file`, `blocked_other`, `rate_limit`, `network`, `crash`,
  `spawn_failure`, `user_stop`, plus `timeout`/`verification_failed`/
  `orchestrator_stop` reserved for later phases. Recorded on the ledger,
  the session's `lastExit`, and the `session:exit`/`session:progress` events.
- **Progress confidence** (`src/progress/progressConfidence.js`): each
  progress verdict carries a `high`/`medium`/`low` level, a 0–1 score, and
  the corroborating signals (git-commit > git > filescan > unmeasurable).
  Verification signals from P6 will raise it through the same function.
- **Mission timeline** (`src/state/missionTimeline.js`): a sparse,
  human-readable event stream per project (`state/timeline/<project>.jsonl`)
  — mission started, progress, rate-limit, resumed, blocked, complete. New
  `ai-orchestrator timeline <project>` command and `GET /api/timeline/:project`.
- **Driver-extensible blocked detection**: `detectBlockedState()` now accepts
  engine-specific patterns via an optional `driver.blockedPatterns`, keeping
  detection AI-agnostic. Added a `missing-file` blocked category.
- New library exports for all of the above.

### Changed

- Version line moved to the `v2.0.0-alpha.*` snapshot scheme; each completed
  phase is now tagged for clean rollback points.
- `assessProgress()` now also computes exit reason + confidence and records
  them; `session.lastExit` carries `exitReason`, `progressed`, `confidence`.

## [1.1.0] — 2026-07-05 — Progress awareness (Phase P0)

Emergency reliability fixes after the 2026-07-04/05 overnight incident, in
which a write-denied agent completed 343 no-progress runs and consumed two
full Claude usage windows. The orchestrator now supervises **progress**, not
just the process.

### Added

- **Progress circuit breaker** (`src/core/loopBreaker.js`): after
  `progress.maxConsecutiveNoProgress` (default 3) completed runs that change
  nothing in the workspace, supervision stops instead of looping.
- **Workspace progress signatures** (`src/progress/workspaceSignature.js`):
  git-aware (HEAD + porcelain + dirty-file contents) with a filesystem-scan
  fallback. **Fails closed** — an unmeasurable workspace counts as no
  progress, so an environment problem pauses for review instead of looping.
- **Blocked-state detection** (`src/core/blockedPatterns.js`): recognises
  agent distress signals — permission-denied, no-access, cannot-proceed,
  awaiting-input — and stops immediately when combined with no progress.
  This alone would have caught the incident on run #1.
- **New `blocked` session state**: terminal and *not* auto-resumable, so a
  restart cannot re-enter the same futile loop. The session is archived to
  history with a diagnostic report.
- **Diagnostic reports** (`src/report/diagnosticReport.js`): on any stop,
  `state/diagnostics/<project>-<ts>.md` explains the reason, likely cause,
  recommended fix, and recent run history.
- **Progress ledger** (`src/progress/progressLedger.js`): one record per run
  in `state/ledger/<project>.jsonl` — cause, progress, signature, and the
  agent's final response (the per-run audit trail the incident lacked).
- **Inter-run delay** (`progress.interRunDelayMs`, default 15 s): paces
  continue-relaunches and caps conversation-growth burn.
- **`mission:blocked` event** and notification, plus a `blocked` status state.
- Mock driver can now simulate real workspace changes (`writeFile` /
  `appendFile` in a run script) to exercise the progress engine in tests.
- 25 new tests (blocked patterns, loop breaker, signatures, ledger, and P0
  orchestrator integration including an incident-reproduction test).

### Fixed

- **Temp-file leak**: `writeJsonAtomic` now removes its temp file when the
  atomic rename fails (the EPERM path seen twice during the incident).
- **`plugins.enabled`** is now honored (plugins previously always loaded).
- Orphaned `.status.json.*.tmp` files removed and ignored going forward.

## [1.0.0] — 2026-07-04

Complete rebuild of the original generated skeleton around the actual
mission: supervising real AI coding-agent processes. (The pre-rebuild
snapshot is preserved in git history.)

### Added

- **Supervision core** — launch → passively observe → classify exit →
  recover loop (`src/core/orchestrator.js`); the orchestrator never touches
  a live agent process.
- **Exit classifier** distinguishing mission-complete, usage-limit,
  network, interrupted, spawn-failure, and crash — each with its own
  recovery strategy.
- **Usage-limit engine**: parses reset times from engine output (epoch and
  clock-time forms), clamps waits, sleeps interruptibly, resumes the same
  engine conversation automatically.
- **Crash recovery engine**: exponential backoff, consecutive-crash
  give-up that always preserves the session for later resume.
- **Claude Code driver**: headless `-p --output-format stream-json`
  launches, prompt via stdin, engine session-id capture for `--resume`,
  activity extraction for status, limit/network message patterns.
- **Mock driver** for testing the full pipeline without an AI engine.
- **State layer**: atomic JSON persistence with corruption quarantine,
  per-project session records + history, live `status.json`, heartbeat
  with double-launch guard and unclean-shutdown detection.
- **Reboot recovery**: Task Scheduler auto-resume task
  (`scheduler install`), heartbeat-based recovery on next start.
- **Notifications**: desktop (default-on), webhook, Discord, Telegram;
  email stubbed for a future release.
- **Plugin system**: `plugins/` modules with event subscription and driver
  registration; failures isolated.
- **Dashboard API**: read-only local HTTP endpoints (status, sessions,
  history, projects, health).
- **CLI**: `start`, `resume`, `stop`, `status`, `sessions`, `projects`,
  `drivers`, `scheduler`, `doctor`; plus `START_AI.bat`.
- **Tests**: 53 unit/integration tests (node:test), covering classification,
  wait policy, backoff, persistence, sessions, config validation, and the
  full supervision loop including limit-resume and give-up-then-resume.
- MIT LICENSE; full documentation set rewritten to match the implementation.

### Changed

- Configuration migrated from YAML to JSON (`config/orchestrator.json`,
  `config/projects/*.json`) per the project specification.
- Dependencies reduced from 24 to 8 runtime packages; tests moved from Jest
  to Node's built-in runner.

### Removed

- The generic multi-agent task-queue framework (agent pools, task queue,
  worker/researcher/coder agents) — replaced by the process-supervision
  architecture the mission actually requires.
