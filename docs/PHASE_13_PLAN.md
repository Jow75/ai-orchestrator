# Phase 13 — Architecture Evolution: Discovery, Lifecycle, Live Configuration, Provider/Model Control, Remote Filesystem & Reliability

**Status:** approved, M0 in progress
**Baseline:** `v3.0.0` (Phase 12 M1–M3 complete, audited, not yet pushed). Phase 12 M4 (Launch Experience & Remote Project Creation) has **not shipped** and is **deferred, not cancelled** — re-evaluated against Phase 13's final architecture and slotted into the next available `v3.x` release once Phase 13 completes, per the owner's explicit decision. See `docs/PHASE_12_PLAN.md` §4.
**Author:** Phase 13 architecture pass, 2026-07-29

---

**Versioning (owner's explicit decision):** continue the established minor-bump-per-milestone convention (`v2.8.0`→Phase 12 M1, `v2.9.0`→M2, `v3.0.0`→M3, …) rather than jumping to a major version. Phase 13 is architecturally significant but *extends* the v3 architecture Phase 12 introduced rather than breaking it — a major bump is reserved for the future, and only if a milestone turns up a genuine incompatible break (config, API, or plugin), proposed explicitly with evidence at that time, never pre-emptively. Phase 13 therefore runs `v3.1.0` → `v3.8.0`.

**Roadmap consistency (owner's explicit follow-up requirement):** `v3.1.0` was reserved in writing (`docs/PHASE_12_PLAN.md` §4) for Phase 12 M4. Claiming it for Phase 13 M1 without updating that record would leave an undocumented gap in the release history — a future contributor reading `PHASE_12_PLAN.md` would see "M4 → v3.1.0" and then find `v3.1.0` tagged as something else entirely, with no explanation. **M0 below (docs-only, no version bump, no tag) closes that gap first, before M1 touches any code.** This mirrors an existing precedent in this repo's own history: `c2428f9` ("Archive Phase 11 planning docs; mark v2.7.0 as stable baseline") is a real commit that updated the roadmap without claiming a version of its own — M0 follows that same shape.

## Context

The owner reviewed Phase 12 M1→M3 (the always-on daemon, the Telegram operator console, the desktop control center) end to end — reports, live evidence, and hands-on testing — and approved the direction. Before any further feature work, they want the next body of work treated as a permanent architecture decision, not a milestone to move fast through: project discovery/lifecycle, provider abstraction, remote model control, remote file access, and a real fix for a live bug (Telegram messages cutting off mid-report) all need to be designed once, correctly, because — in the owner's words — it needs to "still make sense after hundreds of projects." This plan is that design, produced by first mapping exactly what already exists in the codebase (a surprising amount — the driver/provider abstraction, the destructive-confirmation flow, the append-only event log, and even a `operator.projectRoots` config stub already reserved for this exact purpose all predate this plan) so that Phase 13 extends real infrastructure instead of duplicating it.

---

## Governing constraint (inherited unchanged from Phase 12)

Every milestone must leave `ai-orchestrator start <project>` with no daemon running byte-for-byte identical to today (the Phase 12 Invariant). Every new capability lives behind the daemon/operator surface, gets a kill switch matching this codebase's existing convention (`daemon.enabled`, `operator.enabled`, `approvals.enabled`, `plugins.enabled` in `src/config/defaults.js`), and reuses `ConfirmationStore` (`src/operator/confirmations.js`) for anything destructive rather than inventing a second pattern.

---

## Four design decisions the plan turns on

| # | Question | Recommendation | Why (tied to this codebase, not generic advice) |
| --- | --- | --- | --- |
| D1 | One `operator.projectRoots` list, or split discovery-scope from write-safety-boundary? | **Reuse the one list.** | `apiAuth.js:11` states the system's own model plainly: "one operator, one machine." The folders the owner trusts AI-Orchestrator to *discover existing work in* and the folders they'd trust it to *create new work in* (Phase 12 M4's future use of the same key) are the same trust boundary under that model. `docs/PHASE_12_M2_REPORT.md` already commits to one meaning ("empty ⇒ refuse outright"); Phase 13 M2 simply exercises that same key for a second, compatible purpose. Splitting later (if experience ever demands it) is a trivial additive change; merging two lists an owner has maintained separately for months is not. |
| D2 | Live-config mutation: memory-only, file-watch-and-reload, or write-and-mutate-in-place? | **Write to disk, then mutate the same in-memory object every subsystem already holds by reference.** | Ground truth from `docs/PHASE_12_PLAN.md` (E6): "files remain the source of truth… IPC/memory is advisory." Memory-only makes memory the source of truth the moment the daemon restarts and forgets a change from minutes ago. A file-watcher is new infrastructure this codebase has never needed. The chosen approach uses the **existing** `ConfigManager.writeLocalConfig()` (`src/config/configManager.js:225`, today only called by one-shot setup wizards) for the disk write, and exploits that `src/daemon/daemon.js:105` already does `this.config = this.configManager.getAll()` **by reference**, handing that same object to every subsystem at construction — mutating it in place needs no subsystem to "reload" anything, because nothing ever stopped holding the live object. |
| D3 | `/download-project` zip generation: hand-rolled (Node's built-in `zlib`) or a dependency (`archiver`)? | **Add `archiver`.** First new runtime dependency since baseline — flagged explicitly, not folded silently into a feature commit. | `package.json` is not dependency-phobic (express/helmet/winston are already real deps); the one hand-rolled precedent, `smtpClient.js`, was justified because a narrow text protocol talking to a handful of mail servers is fully ownable. A ZIP's central-directory/CRC32 format has real edge cases (zip64 boundaries, cross-platform readers) a maintained library has already absorbed at a scale this fleet won't organically reach for a long time — exactly the "still make sense after hundreds of projects" failure mode to design against now, not patch later. |
| D4 | `/file` document delivery: add `sendDocument()` to the two-way `TelegramApprovalProvider`, or reroute through the one-way notification channel that already has it? | **Add it to the provider** (mirror the ~30-line method already proven in `src/notifications/channels/telegram.js:85-116`). | Phase 12 M2's whole point is "Telegram is one client, not the interface" — `POST /api/operator/command` gets the identical `{reply}` contract a phone gets. Rerouting `/file` through the separate notification channel would make that one command invisible to the API/CLI path while working over Telegram — breaking the one-router-serves-every-client invariant for exactly one command. The router's reply contract instead grows one optional field: `{reply, attachment?}`. |

---

## Milestone breakdown

Each ships independently: implementation → tests → full regression (`npm test`) → live validation → docs → version bump → commit → annotated tag → completion report — the exact discipline `docs/PHASE_12_PLAN.md` used and `docs/PHASE_12_M2_REPORT.md` demonstrates. Order below is the recommended ship sequence — **M1 (Long Message Reliability) is deliberately moved to the front**, ahead of the owner's own item numbering, because it fixes a bug the owner has already observed in production with zero dependency on anything else in this plan; everything else keeps the owner's relative ordering.

### M0 — Roadmap Synchronization (docs only — no code, no version bump, no tag)

*Runs first, before any Phase 13 code. Required by the owner's explicit instruction: no version number may be reused or left ambiguous in the release history.*

Per the "Roadmap consistency" note above, three documents asserted that Phase 12 M4 owns `v3.1.0` and is "next, unblocked." All three get corrected in one commit before M1 begins:

- **`docs/PHASE_12_PLAN.md` §4 (milestone table)** — M4's row gets a `Status: Deferred` annotation and a short section explaining why. M4 itself is **not deleted or reworded** — its scope (launcher, Start Menu, `/new` with mandatory plan approval) stays intact for whenever it's picked back up, with a note that it should be re-checked against Phase 13's final architecture (particularly M2's discovery use of `operator.projectRoots`, which M4 will also consume) before it resumes.
- **`ROADMAP.md`** — the Phase 12 section's M4 bullet gets the same `Deferred` marker and a pointer to `docs/PHASE_12_PLAN.md` for the reason; a new "Phase 13" section lists M1–M9 with their planned versions, sourced from this plan.
- **`PROJECT_CONTEXT.md`** — the "NEXT" pointer is corrected to point at Phase 13 M1 instead of Phase 12 M4, with M4's deferral stated plainly.

No version bump and no tag — matches the `c2428f9` precedent cited above.

**Validated by:** grep across `docs/`, `ROADMAP.md`, and `PROJECT_CONTEXT.md` confirming no remaining reference claims `v3.1.0` for M4.

---

### M1 — Long Message Reliability (`v3.1.0`) — ✅ DONE

*Owner's item 7. No dependencies — ships first.* Full write-up:
[PHASE_13_M1_REPORT.md](PHASE_13_M1_REPORT.md). Root-cause finding worth
flagging here: it was **not** Telegram's 4096-char limit (real messages
measured in the hundreds of characters) and **not** a swallowed HTTP error
(zero such log entries across 6 days of real operation) — it was a flat,
boundary-blind `truncate()` applied directly to the agent's own report text,
a Phase 11 design choice, not a transport bug. The plan below is retained as
written (including the un-narrowed hypotheses) because it accurately
reflects what was investigated and why; the report has the resolution.

**Root-cause investigation before any fix** (part of the milestone, not a preamble): correlate the owner's observed "Purpose …" cutoffs against `state/events/events.jsonl` timestamps/types, then evaluate two concrete, evidenced hypotheses:
- **A — the real 4096-char Telegram limit is actually being hit.** None of the ~9 scattered local `truncate(text, maxChars)` helpers across the codebase (`notificationEngine.js`'s 300/1200/1500-char caps, plus one each in `render.js`, `implementationSummary.js`, `continuationBuilder.js`, `checkpoint.js`, `claudeDriver.js`, `cliDriver.js`, two verifiers) measure the string **after** `formatTelegramText()` (`src/notifications/telegramFormat.js`) — which *grows* it (HTML-entity escaping, `<code>` wrapping around every filename-like token). A message safely under a local cap pre-formatting can cross Telegram's real limit post-formatting, invisibly to every existing check. A Mission Card near its 8-file display cap (`src/notifications/missionCard.js:175`) with full Windows paths plus a 300-char summary is a concrete, plausible way to cross it.
- **B — an HTML parse failure is silently swallowed, not truncated.** `NotificationEngine.notify()`'s `Promise.allSettled` fan-out logs-and-swallows a rejected send; a malformed `parse_mode: 'HTML'` payload never arrives at all, which can look identical to "cut off" from the owner's side.

Both get confirmed against real message/event history before the fix ships, and the fix closes both regardless of which is confirmed.

**Builds:** new `src/notifications/telegramSplit.js`:
- `MAX_MESSAGE_CHARS = 4096` — the one real, named Telegram limit (distinct from the ~9 unrelated readability caps, which are left alone).
- `splitForTelegram(formattedHtml, opts)` — a tag/entity-aware scanner over the already-`formatTelegramText()`'d string; only splits where it isn't inside an open `<tag>` or `&entity;`; prefers paragraph → line → word boundaries; appends a `(2/3)`-style suffix when there's more than one part.
- `sendLongText({send, title, message})` — the one shared send path (an injectable `send(text)` so it composes with existing HTTP call sites rather than duplicating them). Sends as one message when it fits (today's behavior, unchanged); splits and sends sequentially when it doesn't; on a 4xx from Telegram, retries once with formatting stripped rather than losing the message (closes hypothesis B).

**Modified call sites** (converge on `sendLongText`, nothing else changes): `src/notifications/channels/telegram.js`'s `send()`; `src/approvals/providers/telegramProvider.js`'s `publish()`/`sendText()`.

**Validated by:** property-style tests generating adversarial HTML-ish text asserting every split part is independently well-formed; exact boundary tests (4095/4096/4097 chars); the HTML-error-retry path using the same injectable-`fetchFn` pattern every Telegram test already uses; live validation sending a synthetic oversized Mission Card on the real bot and confirming numbered, non-mangled delivery.

---

### M2 — Project Roots & Discovery (`v3.2.0`) — ✅ DONE

*Owner's item 1. No dependencies.* Full write-up:
[PHASE_13_M2_REPORT.md](PHASE_13_M2_REPORT.md).

**Builds:** new `src/operator/projectDiscovery.js` exporting `scanRoots(roots, {ignore, markers, maxDepth})`. New commands `/scan` (aliases `rescan`, `discover`; read-only) and `/import <path> [name]` in `commandGrammar.js`'s `COMMANDS`, handled in `commandRouter.js`.

**Discovery algorithm:**
- Walk each root in `operator.projectRoots` one level deep for candidate directories.
- A directory qualifies only if it is not already a `workingDirectory` of any `config/projects/*.json` (case-insensitive compare) and contains a marker file (new `operator.discovery.markers`, default `['.git', 'package.json', 'requirements.txt', 'pyproject.toml', 'Cargo.toml', 'README.md']`) within `operator.discovery.maxDepth` (default `2`).
- **Ignored folders:** new `operator.discovery.ignore` (default `['node_modules', '.git', 'dist', 'build', '.next', '.venv', '__pycache__']`) plus a hard, non-configurable self-exclusion of `ROOT_DIR` (`src/infra/paths.js:21`) — without it, a root containing AI-Orchestrator's own checkout would "discover itself."
- **Nested repos:** a directory containing `.git` is a scan leaf — discovery never descends past the first repo boundary, so monorepo internals never become false candidates.
- **Duplicates:** two candidates sharing a basename under different roots are both reported with full paths; `/import` requires an explicit name and `ConfigManager.saveProject()` already refuses a colliding one (reused as-is).
- **Deleted projects:** `ProjectRegistry.describe()` gains an explicit `fs.existsSync(workingDirectory)` check *before* delegating to `configManager.getProject()` (today that path throws inside `validateProject()` and surfaces as a generic `misconfigured`); reports a new, more specific `status: 'missing'`, with `/scan` suggesting `/forget` (M3) as the remedy.
- **Renames:** deliberately **not** auto-detected (no inode tracking, no fuzzy matching — exactly the kind of permanent fragile machinery the "still make sense after hundreds of projects" framing argues against). A rename shows up as the old entry going `missing` and a new candidate appearing; resolved via `/forget` + `/import`, or hand-editing `workingDirectory` (already works today since `getProject()` re-reads the file fresh every call).
- **No new state file** — discovery is always recomputed live off `fs.readdirSync`, matching `ConfigManager.getProject()`/`listProjects()`'s existing "no cache" philosophy.

**Config shape:**
```json5
operator.projectRoots: string[]     // REUSED key; default changes [] -> ["C:\\Users\\Admin\\Music"]
operator.discovery: { enabled: true, ignore: [...], markers: [...], maxDepth: 2 }
```
The default-value change is called out explicitly in the CHANGELOG (it also activates Phase 12 M4's future write-safety use of the same list) — not folded silently into "new feature" prose.

**New event types** (`src/events/eventTypes.js`): `project.discovered` (one per scan, not per candidate), `project.imported`.

**Validated by:** unit tests for ignore/marker/nested-repo/self-exclusion/duplicate-name logic; live `/scan` against the real `C:\Users\Admin\Music`, confirming the real on-disk projects are found with zero false candidates, then import/forget round-tripped on one throwaway folder.

---

### M3 — Project Lifecycle & Registry Operations (`v3.3.0`) — ✅ DONE

*Owner's item 2. Depends on M2 (Rescan/Import are M2's commands).* Full
write-up: [PHASE_13_M3_REPORT.md](PHASE_13_M3_REPORT.md). One real deviation
from this plan, disclosed in the report: `updateProject()` does NOT run full
mission-readiness validation as originally described — doing so would have
made it impossible to archive/hide an M2-imported, no-mission-yet project,
exactly backwards from the point.

**Builds:** new `src/config/projectClassification.js` — `PROJECT_CLASSIFICATIONS = ['production','development','validation','demo','archived','hidden']`. Named **"classification,"** not "lifecycle" — `src/mission/missionLifecycle.js` already owns "lifecycle" for a mission-run state machine; reusing the word for an unrelated, owner-set, per-project concept is exactly the naming collision to avoid.

New `src/operator/projectLifecycleOps.js`: `archive()`, `restore()`, `hide()`, `unhide()`, `forget()`, `classifyProposal()` (the migration heuristic below) — pure functions the router calls, matching how `commandRouter.js` already delegates to `render.js`/`missionRequests.js` rather than inlining logic.

**Data shape:** `PROJECT_DEFAULTS.classification = 'development'` (new field in `src/config/defaults.js`, deep-merged like any other default). Two new `ConfigManager` methods: `updateProject(name, patch)` (reads the raw on-disk JSON, not the defaults-merged object, so defaults never get baked permanently into the file; deep-merges, re-validates, writes) and `deleteProject(name)` (removes the JSON file only, refuses if a worker currently holds the project — reusing `commandRouter.js`'s existing `startBlocker()` holder-check).

**Operations, split exactly along the owner's registry-vs-filesystem line:**

| Command | Destructive? | Mechanism |
| --- | --- | --- |
| `/archive`, `/restore`, `/hide`, `/unhide` | No — reversible, config-only | `updateProject()` |
| `/forget` | Yes — deletes the config file | `ConfirmationStore` via `prepareDestructive()`, same pattern as `/stop`/`/reset`/`/shutdown` |
| `/rescan`, `/import` | No | M2, unchanged |
| Real filesystem delete of a project's code | — | **Not built.** Explicit non-goal, stated in docs, not silently dropped: "delete the folder yourself; this system will never do it for you." |

Both mutating groups sit behind new `operator.lifecycle.enabled` (default `true`) — a new kill switch, per this codebase's convention of one per new mutating capability class. `ProjectRegistry.list()` gains `{includeHidden: false}` default (`/projects` hides `hidden` projects by default — phones show "about six lines before scrolling," `projectRegistry.js`'s own stated design constraint; `/projects all` shows everything). Archived projects stay listed, sorted after live statuses, badged like the existing `🧪 SIMULATED` convention.

**New event types:** `project.archived`, `project.restored`, `project.hidden`, `project.unhidden`, `project.forgotten`, `project.classified`.

**Migration of the 6 existing projects is this milestone's validation** — see the dedicated section below.

---

### M4 — Live Configuration Layer (`v3.4.0`) — ✅ DONE

*The shared mechanism underlying owner's items 4 and 8. No dependency on M1–M3.*
Full write-up: [PHASE_13_M4_REPORT.md](PHASE_13_M4_REPORT.md). Building this
surfaced a real, previously-latent bug in `ConfigManager.deepMerge()` —
nothing before this milestone ever mutated a merged config object in place,
which let a shallow-copy bug hide: an untouched config branch could be the
literal same object as the shared `ORCHESTRATOR_DEFAULTS` singleton. Fixed
at the root (`deepMerge` now deep-clones), not patched around here.

**Builds:** new `src/config/liveConfig.js`, `LiveConfigLayer`:
- `LIVE_MUTABLE_PATHS` — an explicit **allowlist** of dotted config paths (`operator.projectRoots`, `operator.defaultModel`, `operator.defaultProvider`, `notifications.minSeverity`, `approvals.mode`), deliberately not "anything in config" — that would silently turn restart-only settings (`daemon.pollIntervalMs`, `api.port`) into ones that look live but aren't, an unaudited surface nobody asked for. Extensible over time as more of the owner's "remote configuration" wishlist gets prioritized.
- `applyPatch(patch)` — validates every key against the allowlist; writes to disk first via the **existing** `ConfigManager.writeLocalConfig()` (so a crash mid-mutation loses at most the in-memory mirror, never the fact); then updates the **same object reference** `daemon.js:105` already hands to every subsystem, for only the allowlisted leaf keys (explicit assignment, not a blind deep-merge-in-place).

**New commands:** `/roots`, `/roots add <path>`, `/roots remove <path>` (validated as an existing absolute path; `remove` warns, non-blocking, if a registered project currently lives under the root being removed, and states plainly that removal only affects discoverability — `ConfigManager.getProject()` never consults roots). Gated by new `operator.liveConfig.enabled` (default `true`).

**New event type:** `config.changed` (`{key}` only — never the raw value, hygiene against a future allowlisted key that turns out to be secret-adjacent).

**Validated by:** allowlist-enforcement tests; an in-place-mutation test that grabs a config sub-object reference before `applyPatch` and asserts the same reference reflects the change after; a restart-survival test (patch applied, fresh `ConfigManager` constructed against the same root, confirms `load()` reflects it); live `/roots add` on the real bot confirming `/scan` sees it with no restart, then confirming it survived a real daemon restart.

---

### M5 — Provider Architecture Completion & Remote Model/Provider Management (`v3.5.0`) — ✅ DONE

*Owner's items 3 and 4. Depends on M4.* Full write-up:
[PHASE_13_M5_REPORT.md](PHASE_13_M5_REPORT.md).

**Explicitly not rebuilt** (already exists — stated so scope stays honest): `AIDriver`/`AgentRun` (`src/drivers/aiDriver.js`, already an `EventEmitter` — **Streaming** already exists), `DriverRegistry`/`BUILTIN_DRIVERS`/runtime `registerDriver()` (`src/drivers/driverRegistry.js` — a plugin can already add Gemini/OpenAI/local models with **zero core changes**), the generic `CliDriver` that already wraps any CLI-based engine from config alone (`src/drivers/cliDriver.js`), per-project `driver`/`claude` config block (`src/config/defaults.js:434`), Phase 9's per-task-role driver routing (`src/agents/`). **Execution** and **Cancellation** are likewise already covered by `AIDriver.launch()` and the existing worker-stop machinery (Phase 12 M1's stop-file + escalation) — nothing new needed. **Planning** is already the mission-planning/role-routing layer's job (`agentRouter`, role `planner`) and is out of scope here.

**Authentication — addressed explicitly, deliberately minimal:** every built-in driver authenticates via the wrapped CLI's own ambient login (the `claude` executable's own session, or whatever a `cli`-wrapped engine's own auth is) — AI-Orchestrator manages none of it today and this milestone does not add a credential vault or per-provider API-key UI. If a future driver genuinely needs orchestrator-managed secrets (e.g. a raw HTTP-API-key provider with no CLI to defer to), it follows the exact pattern already proven for SMTP/Telegram secrets: a field in git-ignored `config/local.json`, never in `config/projects/*.json`. Stated as a considered-and-deferred decision, not an oversight.

**What's actually missing, built here:**
1. **Capabilities descriptor** — new `src/drivers/capabilities.js`, a plain data map (matching the existing preference for data over class hierarchies — `BUILTIN_DRIVERS`/`SIMULATED_DRIVERS` are both plain objects): `DRIVER_CAPABILITIES = {claude: {models: [...], streaming: true, cancellation: true, toolUse: true}, mock: {...}, cli: {models: [], streaming: true, cancellation: true, toolUse: 'unknown'}}`. `cli`'s `toolUse: 'unknown'` is deliberate — a generic wrapper cannot introspect an arbitrary engine, and `projectRegistry.js:19`'s own stated principle ("more useful than one that reports a confident fiction") argues against inventing an answer. Reference data only — no capability-gating logic is added, nobody asked for it.
2. **A machine-wide default model**, independent of any one project's file. New allowlisted `operator.defaultModel`/`operator.defaultProvider` (M4). Threaded into `ClaudeDriver` via an **optional** constructor closure `defaultModelProvider: () => string` (defaults to `() => ''` — every existing caller/test unaffected, the same optional-collaborator contract every Phase 10 surface uses). Resolved at launch time where `buildArgs()` already decides `--model`: `project.claude.model || defaultModelProvider() || ''`. Because the closure reads the live-mutated `this.config` at call time, "never interrupts an active mission, new missions inherit the change" falls out for free — an in-flight `AgentRun` is already spawned with fixed args; only the next `launch()` re-reads the closure. No extra non-interruption logic needs writing.
3. **`/provider`** (read-only: default provider/model, `driverRegistry.listDrivers()`, `DRIVER_CAPABILITIES`, and — when a project is selected — that project's own override, shown side by side) and **`/model <name>`** (validated against `DRIVER_CAPABILITIES[provider].models`; `/model default` clears back to per-project behavior). Both behind `operator.liveConfig.enabled` (M4's switch, reused).
4. **Explicitly not built:** a parallel per-role remote model system on top of Phase 9's `agentProfile.js` — that already overrides at finer granularity than one machine-wide default; duplicating it would fork "where does model config come from" into two competing answers.

**New event type:** `provider.model-changed`.

**Validated by:** capability-map shape tests; `ClaudeDriver` with/without the closure (regression: identical args when absent); a mid-mission test (`/model` switched during a run, running launch's args untouched, only the next launch differs); live validation on the real bot with a real Claude mission confirming the actual `--model` argument used.

---

### M6 — Remote File System (`v3.6.0`)

*Owner's item 5. Depends on M1 (message splitting + the `sendDocument` HTTP pattern). Independent of M2–M5.*

**Builds:** new `src/operator/fileAccess.js`:
- **`resolveWithinProject(project, relativePath)`** — the path-traversal guard that exists **nowhere** in the codebase today (the one precedent, `validateSingleTask()` in `src/mission/missionPlan.js:69-81`, resolves a path but never checks it stays inside the project — must not be copied as-is). `path.resolve()`, then `fs.realpathSync()` on **both** the project root and the resolved path (catches a symlink escaping the project, which textual `../` checks miss), then verifies `path.relative(realRoot, realResolved)` doesn't start with `..` and isn't itself absolute (catches a Windows drive-letter escape). UNC paths and mixed-separator traversal are caught by the same real-path check, not pattern blacklisting.
- **`listFiles(project, {subPath, page, pageSize=30})`** — one directory level at a time (Explorer-style, never a recursive full-tree walk), directories first then alphabetical, paginated.
- **`/files [path]`** — read-only, renders through M1's `sendLongText` (pagination is the readability layer; the split path is the hard guarantee behind it).
- **`/file <path>`** — resolves via the guard; binary detection via a NUL-byte sniff on the first few KB (extension-agnostic); size-checked against the **existing** `MAX_DOCUMENT_BYTES` (`channels/telegram.js:22`, 50MB, reused not duplicated); delivered via D4's new `TelegramApprovalProvider.sendDocument()`. `CommandRouter.handle()`'s return contract grows one optional field: `{reply, attachment?: {filePath, caption}}` — additive, every existing `.reply`-only caller unaffected. `OperatorGateway.deliver()` (the confirmed single choke point where a router reply becomes an outbound send) gains an `if (attachment) await provider.sendDocument(attachment)` branch alongside its existing `sendText`.
- **`/download-project [project]`** — size-guarded before zipping (new `operator.download.maxProjectBytes`, default 200MB, checked by summing directory size *before* attempting to zip, so an oversized project fails fast); zipped via D3's `archiver` (streaming API, bounded memory) into new `state/operator/downloads/` (machine-owned generated artifact — belongs under `state/`, not `config/`, per the existing config-vs-state split); delivered via the same `sendDocument` path. A zip over Telegram's 50MB cap reuses the existing `REPORT_AVAILABLE_NOTE` wording style (`notificationEngine.js:82`) rather than inventing new phrasing. Downloads older than 24h are pruned on daemon start and after each new zip.

All three commands sit behind new `operator.files.enabled` (default `true`) — the single highest new filesystem-read exposure in this phase gets its own kill switch, separate from the general `operator.enabled` grammar switch.

**New event types:** `file.served`, `project.downloaded`.

**Validated by:** the path-traversal test suite is the centerpiece — `../../../windows/system32`, symlink escape, absolute drive-letter injection, UNC paths, mixed separators, all asserted refused via real-path comparison; live validation against `calculator-proof` (12 real files) exercising `/files`, `/file README.md` (a real Telegram document received), a rejected traversal attempt, and `/download-project` producing a zip that opens cleanly.

---

### M7 — Mission Completion Messaging (`v3.7.0`)

*Owner's item 6. Depends on M6 (references real commands) and M1 (flows through the split-safe send path).*

**Builds:** nothing structurally new — a copy change in `EVENT_MESSAGES['mission:complete']` (`src/notifications/notificationEngine.js:149-157`), appending a footer with the real project name substituted: `📂 /files <project> · /file <project> <path> · /download-project <project>`. Kept on the notification message only, not baked into `renderMissionCardText()` itself (which also renders for `/status`/`/tasks`, where the nudge would be repetitive).

**Validated by:** unit test asserting real substitution; live validation completing a real mission and tapping through `/files` → `/file` → `/download-project` from the resulting message.

---

### M8 — Bot Experience & Discoverability (`v3.8.0`)

*Owner's item 9. Depends on M2, M5, M7 (audits the final command surface once, not partially twice).*

**Builds:** additive-only fields on `COMMANDS` entries in `commandGrammar.js` (`category`, `examples` — `usage` already serves as the parameter hint). `commandMenu.js`'s Telegram-menu-building logic is **unchanged** (still just `{command, description}`; a regression test asserts the new fields never leak into the published payload). New grouped `renderHelp()` in `render.js` (currently a flat list at line 346), sectioned by `category`, reading the same single `COMMANDS` array — the "single source of truth" the owner asked for is satisfied by construction, since there is exactly one array.

**Localization:** scaffolding, not implementation, matching the owner's own "future localization" framing. `menuDescription()` is already the one function all Telegram-menu text flows through — a future localization pass has exactly one function to change. Documented, not built.

**Docs:** full `docs/OPERATOR_CONSOLE.md` pass covering every M1–M7 command.

**Validated by:** every `COMMANDS` entry has a valid `category` (test); menu-payload shape regression test; live `/help` grouping check on the real bot.

---

### M9 — Public Release Prep (process checkpoint, no code)

*Owner's item 10. Depends on M1–M8, each already independently live-validated.*

Repeats exactly the process just run for `v3.0.0`: full regression, `docs/` staleness audit, CHANGELOG finalized, README/QUICKSTART spot-checked against the real command surface, tags verified, then **presented for approval and never auto-pushed** — no new version number of its own; it finalizes and audits whatever M8 shipped as (`v3.8.0`).

---

## Dependency graph

```
M1 (Long Message Reliability) ---+---> M6 (Remote File System) ---> M7 (Mission Completion Messaging)
  [no dependencies]               |      [needs sendLongText +           [needs M6's real commands
                                   |       sendDocument HTTP pattern]      + M1's send guarantee]
                                   |
M2 (Project Roots & Discovery) ---+---> M3 (Project Lifecycle & Registry Ops)
  [no dependencies]                      [Rescan/Import ARE M2's commands]

M4 (Live Configuration Layer) ---> M5 (Provider Architecture & Remote Model/Provider Mgmt)
  [no dependencies]                 [/model, /provider persist through M4's applyPatch()]

{ M3, M5, M7 } ---> M8 (Bot Experience) ---> M9 (Public Release Prep)
  [audits the FINAL command surface once new commands from all three chains exist]
```

Three independent chains (M1→M6→M7, M2→M3, M4→M5) converge only at M8. Recommended single-owner ship order respecting every edge: **M1, M2, M3, M4, M5, M6, M7, M8, M9** (as numbered above).

**Coordination note, not a blocking dependency:** Phase 12 M4 was the original reason `operator.projectRoots` exists (reserved for its write-safety check). Phase 13 M2 starts *reading* that list for discovery before Phase 12 M4 (whenever resumed) *reads* it for creation-safety — safe in either order, since both are read-only consumers of the same array; D1 is precisely the design choice that makes that non-conflicting.

---

## Migration strategy — the 6 existing projects

`m2-validation` is not migrated — retired per `PROJECT_CONTEXT.md`, no config file exists for it; nothing invents a migration step for a file that isn't there. M3's `classifyProposal()` **proposes, never silently applies** (mirroring `isSimulatedProject()`'s own precedent — explicit field wins, inference is only a fallback):

| Project | Evidence | Proposed classification |
| --- | --- | --- |
| `validation-sandbox` | `simulated: true`, mock driver | **demo** |
| `phone-demo` | claude driver, Phase 10.5 phone-workflow validation | **validation** |
| `validation-demo` | claude driver, operational-validation demo | **validation** |
| `calculator-proof` | claude driver, real files, explicitly kept as evidence | **validation** |
| `THE FINISHER` | claude driver, not yet seriously run | **development** |
| `example` | claude driver, lives inside AI-Orchestrator's own repo (the `projects add` template) | **demo** (also the one project that breaks the "lives beside AI-Orchestrator" pattern the other five follow — correctly self-excluded from M2's discovery since it's inside `ROOT_DIR`) |

Mechanism: `/projects classify` (and a CLI equivalent) **prints** this table for every project missing an explicit `classification` and requires **one batch confirmation** via `ConfirmationStore` (not one prompt per project) before writing anything. No project currently qualifies as `production`/`archived`/`hidden` under this heuristic — itself informative: the fleet is entirely pre-production, consistent with the daemon having just gone always-on.

---

## Risk register

| Risk | Mitigation |
| --- | --- |
| `operator.projectRoots` default widening (`[]` → real path) silently changes security posture for the still-unshipped Phase 12 M4 | Disclosed explicitly in M2's CHANGELOG entry, not folded into "new feature" prose; the invariant itself ("empty ⇒ refuse") is untouched, only the default value moves |
| Live-config memory/disk divergence | D2's ordering — disk write happens before the in-memory mutation, so the two can never show different values to two different reads |
| Path-traversal guard bug (highest blast-radius new surface) | Dedicated adversarial test suite is M6's centerpiece; `operator.files.enabled` kill switch ships with the feature, not after |
| `archiver` dependency adds new supply-chain surface | Isolated to one module; D3's reasoning documented inline (matches this codebase's habit of explaining non-obvious choices) |
| Classification heuristic misclassifies a project | Never auto-applied — one explicit confirmation over a printed proposal; owner-correctable any time, same as `simulated` is today |
| `/model` mid-mission race | Resolution happens only inside `launch()`, reading the live closure fresh each call — no explicit "don't disrupt a running mission" logic needed because none is possible given the design |
| Message-splitting introduces a new failure mode (a tag split across parts) | Adversarial property tests specifically hunting split-boundary bugs; live validation against a synthetic oversized card before any real mission depends on it |
| `/forget` confused with a real disk delete | `/forget`'s confirmation text states explicitly "files on disk are NOT touched"; no command exists that could be mistaken for one, because the capability is simply absent |
| Kill-switch sprawl | Applied selectively — only the three genuinely new, higher-risk capability classes (`operator.discovery`, `operator.liveConfig`, `operator.files`) get one; M3's lifecycle ops reuse `operator.lifecycle.enabled`, M7's copy change needs none |

---

## Rollback strategy per milestone

| Milestone | Rollback |
| --- | --- |
| M1 | Git revert — no data persisted by this milestone |
| M2 | `operator.discovery.enabled: false` disables `/scan`/`/import` without a code revert |
| M3 | `operator.lifecycle.enabled: false` disables mutating commands; the `classification` field is inert once unread — no cleanup needed to revert |
| M4 | `operator.liveConfig.enabled: false` refuses new mutations immediately; anything already written to `local.json` stays (a real, disclosed change) and is hand-editable |
| M5 | Same switch as M4; `ClaudeDriver`'s closure defaults to a no-op when absent |
| M6 | `operator.files.enabled: false` disables all three commands immediately; git revert removes `archiver` cleanly (isolated to one module) |
| M7 | Pure copy revert |
| M8 | Additive fields revert cleanly; `renderHelp()` falls back to the flat list |
| M9 | N/A — process step, nothing shipped until the owner approves the push |

---

## Text-form architecture diagram

```
                    Telegram / Desktop / CLI / API  (existing Phase 12 clients)
                                    |
                                    v
                    OperatorGateway (exclusive inbound, existing)
                                    |
                                    v
                    commandGrammar.parseCommand()  (existing; M2/M3/M4/M5/M6
                                    |                 add entries, don't change parsing)
                                    v
                    CommandRouter.handle() -> {reply, attachment?}   <-- M6 adds `attachment`
                          |                        |
             +------------+-----------+            +--> OperatorGateway.deliver()
             |            |           |                  sendText + NEW sendDocument (D4)
             v            v           v
      ProjectRegistry  ConfigManager  ConfirmationStore
      (existing)       .config       (existing, reused
        + classification  (existing,   as-is for /forget)
          field (M3)      mutated in
             ^             place by
             |             LiveConfigLayer (M4)
      projectDiscovery         |
      .scanRoots() (M2)        v
                          DriverRegistry / ClaudeDriver
                          (existing) + DRIVER_CAPABILITIES (M5)
                          + optional defaultModelProvider() closure

      fileAccess.js (M6): resolveWithinProject() + listFiles() + archiver zip
                          -> delivered via sendDocument (D4)

      telegramSplit.js (M1): sendLongText() -- the one path every text send
                          (existing channels + provider) converges on

      eventTypes.js (existing, grows): project.*, config.changed, provider.*,
                          file.*  -- every new durable fact logged here
                                    |
                                    v
                          Mission Worker(s) -- UNCHANGED. Reads project.claude.model
                          already resolved with the live default folded in by the
                          time launch() is called; no new code path to a worker.
```

The invariant this makes visible: every Phase 13 addition is either a new **reader** of existing daemon state (`ProjectRegistry`, `ConfigManager.config`) or a narrowly-scoped **writer** that goes through an existing choke point (`writeLocalConfig`, `ConfirmationStore`, `OperatorGateway.deliver`, `sendLongText`) — never a second path to the same outcome, and never a new route to a mission worker. Same two disciplines that let Phase 12 M1–M3 ship without a compatibility break.

---

## Critical files

- `src/config/configManager.js` — gains `updateProject()`/`deleteProject()` (M3); wrapped by `LiveConfigLayer.applyPatch()` (M4)
- `src/config/defaults.js` — every new config key across M2–M6 lands here (`operator.discovery`, `operator.liveConfig`, `operator.files`, `operator.defaultModel`, `PROJECT_DEFAULTS.classification`)
- `src/operator/commandRouter.js` — every new command's handler; gains the `{reply, attachment}` contract change (M6)
- `src/operator/commandGrammar.js` — the one `COMMANDS` array every new command extends
- `src/daemon/daemon.js` — composition root every new module wires into, at `buildOperatorInterface()` (line 267), same place M2's modules already wire in
- `src/notifications/telegramFormat.js` + new `src/notifications/telegramSplit.js` — the root-cause and fix for M1, the shared path M6/M7 depend on
- `src/events/eventTypes.js` — the closed vocabulary every new durable fact (M2–M6) must be added to before it can be logged

## Verification approach (applies across all milestones)

Same discipline this project has used since Phase 8: `npm test` must stay green after every milestone (baseline: 972/972 backend at the start of Phase 13), each milestone adds its own unit tests for the new module(s) it introduces, and — because this project's own standing rule is that live validation has repeatedly caught real defects unit tests missed (Phase 12 M1's leaked worker process, Phase 12 M2.2's undisclosed mock-driver mission) — every milestone's "Validated by" section above ends in a live check against the real bot and/or a real project (`calculator-proof`), not just a green test run.
