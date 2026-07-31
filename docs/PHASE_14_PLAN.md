# Phase 14 — Remote Engineering (Planning Only)

**Status:** Draft planning document; execution has begun out of numeric order (M9 then M0), per explicit owner priority calls — see each milestone's own status line below. Produced as the Part 10 deliverable of the 2026-07-30 engineering acceptance review (`docs/PHASE_13_M9_ACCEPTANCE_REVIEW.md`), per the owner's own instruction that Phase 14 planning only starts once Phase 13 is officially closed.

**Framing, per standing owner direction:** Phase 14 is intended to be **the last infrastructure-heavy phase**. It is allowed to be substantial, but every milestone below is scoped to extend the *existing* architecture (new commands, new mission templates, new read-only surfaces) rather than introduce a new subsystem, process model, or persistence layer. Anything that would require a genuinely new architectural layer is flagged explicitly rather than folded in quietly.

**The one rule every milestone in this plan obeys:** all engineering actions continue to flow through **Telegram → Operator Console → Event Store → Daemon → Worker** — the exact path every capability since Phase 12 M1 has used. Nothing in this plan proposes a second execution path, a bypass of the approval gate, or a direct-to-filesystem write outside a supervised worker.

---

## 0a. Addendum, 2026-07-30: "Workspace Intelligence" considered and scoped down

The owner raised a larger pitch after this plan was first drafted: stop treating
the registry's 23 projects as independent, and give the operator a portfolio-level
view — plus, eventually, cross-project reasoning (dependency graphs, shared-library
detection, "what does Parakeet AI depend on"). Decision, made explicitly rather than
by default: the portfolio-*visibility* half is real and cheap — `ProjectRegistry`
already computes per-project status, classification, and git dirty/clean for every
registered project (see `src/operator/projectRegistry.js`); a rollup across all of
them is a **read-only aggregation query**, the same risk class as `/status`, not a
new subsystem. That becomes **M0** below. The cross-project *reasoning* half
(relationship tracking, dependency graphs, duplicate-code detection, a real
Workspace Registry with its own persistence) is NOT included here — it fails this
phase's own framing in §5 ("any new persistence layer... is explicitly rejected"),
and is deliberately left for a future phase once Phase 14 ships, not folded in here
under the same name.

## 0. What this phase is answering

The 2026-07-30 acceptance review (Part 7) found these items real, un-blocking-but-real gaps, all pointing at Phase 14:

- No git commit history / diff visibility from Telegram (`/git`).
- No raw log tailing from Telegram (`/log`).
- No repository or symbol search.
- No TODO/FIXME discovery.
- Test result visibility is aggregate-only (counts + confidence label).
- No AI-assisted code review, architecture summary, documentation generation, or refactoring-proposal capability at all — currently the only way to get the AI to *look at and reason about* a project remotely is a full, free-form mission request.
- Phase 12 M4 (Launch Experience & Remote Project Creation) remains formally deferred, its re-evaluation explicitly folded into this phase per the owner's 2026-07-30 direction.
- Remote configuration is incomplete: notification preferences and approval mode are still CLI/config-file-only.
- 19 of 23 real registered projects have no `promptFile` and no remote way to acquire one — found fresh in the 2026-07-30 review, the single highest-value gap identified there.

Phase 14 is the container for closing these, in priority order, without adding new architecture.

---

## 1. Design principle: two capability classes, two different mechanisms

Everything requested for Phase 14 — git inspection, repo search, symbol search, TODO discovery, test review, architecture summaries, documentation generation, remote refactoring proposals, AI-assisted engineering — sorts cleanly into two existing mechanisms. Recognizing this up front is what keeps this phase additive instead of architectural.

**Class A — Deterministic reads.** Git inspection, repo/symbol search, TODO discovery, and test-result surfacing are all *facts already on disk or already computed* (git's own object database, the filesystem, the last mission's checkpoint). These need **no AI involvement and no mission**. They are new operator commands, built the same way `/files`/`/file` were built in Phase 13 M6: read-only, behind the same path-traversal guard (`src/operator/fileAccess.js`), no approval gate (matching the existing precedent that `/status`/`/files` need none), a kill switch in `operator.*.enabled` for each new capability class (matching M6's `operator.files.enabled` precedent).

**Class B — AI-assisted engineering.** Code review, architecture summaries, documentation generation, and refactoring proposals all require the AI to actually reason about the code — there is no deterministic shortcut for these. **These are not a new execution path.** They are pre-authored **mission prompt templates** submitted through the exact same mission-request → two-gate-approval → supervised-worker pipeline every other mission already uses. A `/review [project]` command does not invoke a new "review engine" — it constructs a mission request whose objective is a fixed, well-tested prompt ("produce a code review of the current diff/repository, do not modify any files"), submits it through `CommandRouter` exactly like free-form text does today, and inherits **every existing guarantee for free**: Safe Mode still applies, the two-gate approval still applies, the event log still records it, `missionCard`/`checkpoint` still produce the completion artifact. The only new thing is a canned, reviewed prompt and a shortcut command that submits it — not a new subsystem.

This distinction is the load-bearing decision of this whole phase: it's why Phase 14 can deliver "AI-assisted engineering" without becoming architecturally heavier.

---

## 2. Milestones

### M0 — Workspace Overview (`/workspace`) — SHIPPED, `v3.11.0`
A single read-only rollup across every project the registry knows about, answering
"how is the whole portfolio doing" without opening one project at a time. Iterates
`ProjectRegistry.list()` — already computes per-project status (running/idle/
blocked), classification, `promptFile` presence, and git dirty/clean for each real
project — and aggregates:

- **Projects:** total registered, how many are mission-ready (have a `promptFile`
  or `tasks`), how many don't.
- **Status:** counts by computed status (running / idle / blocked / awaiting
  approval).
- **Git:** counts by clean/dirty.
- **Recently active:** the N most recently touched projects (registry already
  tracks this for `/projects`' own sort order).
- **Needs attention:** projects missing a `promptFile`, or flagged `blocked`.

No new data source, no new persistence, no cross-project computation (nothing
here reasons about *relationships between* projects — see §0a) — every field is
already computed by an existing registry read, just summed instead of shown one
row at a time. Kill switch: `operator.workspace.enabled`, following the one
switch per new capability class convention every other Phase 13/14 milestone
uses.

**One deviation from the sketch above, forced by something the sketch missed:**
mission-readiness could NOT come from `ProjectRegistry.list()` records directly —
`ConfigManager.validateProject()` requires either a `promptFile` or a non-empty
`tasks` array to consider a config legal at all, so a project missing both never
reaches `describe()`'s status computation; it throws first and the record comes
back `status: 'misconfigured'`. `commandWorkspace()` reads each project's RAW
config file instead (the same technique M9's `assignMission()` already uses) to
tell "no mission yet" (this milestone's whole reason to exist — the M9 gap,
mostly closed but not universally guaranteed forever) apart from "broken for a
real, different reason" (bad driver id, say) — `render.js`'s `attentionReason()`
checks mission-readiness BEFORE the generic `misconfigured` label for exactly
this reason. `1219 → 1225` backend tests (`commandRouter.test.js` +6), zero
regressions.
**Depends on:** nothing. **Risk:** low — read-only, same risk class as `/status`/`/projects`, which this milestone is a rollup of.

### M1 — Git Visibility (`/git [project]`) — SHIPPED, `v3.12.0`
Branch, dirty/clean state, HEAD, and the last 5–10 commit subjects (`git log --oneline -N` equivalent), shelling out to the real `git` binary the same way `/status`'s existing `git.branch`/`git.dirty` fields already do. Read-only. No approval gate, matching `/status`. Kill switch: `operator.git.enabled`.

**Shipped shape (two additions beyond the sketch above, both still read-only "just visibility"):** a changed-file count alongside the dirty/clean state (`Dirty (4 changed)`, not just a boolean), and ahead/behind the branch's own upstream when one is configured — reported honestly as "not tracked" rather than a fabricated `0 ahead, 0 behind` when it isn't (very common for local-only branches in this exact workspace). `/git dirty`/`/git clean` were added alongside the core command: every registered project in that git state, reusing `ProjectRegistry.list()`'s already-computed `git.dirty` (the same field `/workspace`'s own clean/dirty counts already sum) rather than re-shelling out — same reserved-keyword precedent `/projects classify`/`/mission all` established. The single-project view needed more than `ProjectRegistry.gitInfo()` already returns (recent commits, ahead/behind, a changed-file count), so it got its own small module, `src/operator/gitVisibility.js`, kept separate from `progress/progressEngine.js`'s `gitBranch`/`gitDirty`/etc. (those feed mission-progress snapshots, not the operator console). Reads via `configManager.getRawProject()`, not `getProject()`, so it works uniformly across all 23 real projects regardless of mission-readiness — the same reasoning M0's `commandWorkspace()` already applies. `gitVisibility.test.js` (new, 7 tests, against real throwaway git work trees), `commandRouter.test.js` (+8). 1225 → 1240 backend tests, zero regressions; 41/41 desktop tests unaffected.
**Depends on:** nothing. **Risk (realized):** low, as predicted — reused an existing, already-shipped git-shelling pattern.

### M2 — Log Visibility (`/log [project] [n]`) — SHIPPED, `v3.13.0`

Tails the last N lines of the real `logs/orchestrator-*.log` file for a project (distinct from `/events`, which shows the structured internal event log — this is the raw text log). Read-only, same path-guard discipline as `/files`. Kill switch: `operator.log.enabled`.

**Shipped shape (one correction to the sketch above, and one deviation forced by something the sketch got wrong about the log file itself):** the correction — the "path-guard discipline" line assumed a per-project log file; there is only ever ONE real log file for the whole installation (`src/infra/paths.js`'s `logsDir`, written by every daemon and mission-worker process alike — see `src/infra/logger.js`), so there is no project-supplied path to guard at all, and `resolveWithinProject()` was never applicable here. The actual guard is simpler: `/log` only ever reads the ONE file this codebase itself writes, never a path the owner types. The deviation — "for a project" means filtering the shared file's own JSON lines by the `project` field individual log calls already attach to their own lines (`workerSupervisor.js`, `taskQueue.js`, `missionLifecycle.js`, … already did this before this milestone, for their own reasons); lines with no such field (daemon startup, HTTP, port allocation, …) are the service's own activity, not any one project's, and are correctly excluded rather than guessed at. New `src/operator/logVisibility.js` (`latestLogFile()` — picked by mtime, not an assembled date string, so a read moments after midnight still finds yesterday's real file instead of a phantom empty one; `readLogTail()`), paginated exactly like `/files` (a trailing bare number is a page only once a project name already precedes it — the identical disambiguation `commandFiles()` uses, and for the same reason: a project name is never assumed to be a page number). One real naming collision found and fixed before it shipped: `log` was already a live alias for `/events`, dating to Phase 12 M2 — freed here, since the two commands read genuinely different things and this milestone's own command needed the name. `logVisibility.test.js` (new, 10 tests), `commandRouter.test.js` (+8). 1240 → 1258 backend tests, zero regressions; 41/41 desktop tests unaffected. Live-validated against the real Core Service and real project history (`calculator-proof`) through the CLI operator bridge — real timestamps, real severities, real pagination across 44 real log lines.
**Depends on:** nothing. **Risk (realized):** low, as predicted.

### M3 — Repository & Symbol Search (`/grep <pattern>`, `/symbol <name>`) — SHIPPED, `v3.15.0`
A text-search primitive over the active project's real files, reusing `fileAccess.js`'s existing containment guard (the same textual + real-path/symlink check `/files`/`/file` already enforce — no new traversal surface). `/symbol` is `/grep` with a language-aware-ish pattern (function/class/const declaration shapes) layered on top, not a real AST/ctags index — explicitly scoped as "good enough to find a definition fast," not a full symbol database, to avoid a new persistence layer (an index would be exactly the kind of new architecture this phase is meant to avoid). Results paginated the same way `/files` already paginates. Kill switch: `operator.search.enabled`.

**Shipped shape (one deviation from the sketch above, the same shape M9 already established for the identical problem):**
- **No `[project]` argument.** The sketch's own `/grep <pattern> [project]` can't disambiguate a free-text pattern from a free-text project name with no delimiter between them — several real project names contain spaces ("THE FINISHER", "Human Typer Fast Speed"), the exact ambiguous-split problem Phase 14 M9's own implementation notes already ran into and avoided (see M9's section below). Both commands operate on the ACTIVE project only, matching `/files`/`/file`'s existing design exactly — `/project <name>` first, then search.
- Two hard, honestly-reported caps in `src/operator/repoSearch.js`: `MAX_MATCHES` (500) and `MAX_FILES_SCANNED` (20,000) — hitting either sets a `truncated` flag the reply surfaces as "narrow your pattern," never a silent partial result. A pattern that fails to compile as a regex falls back to a literal substring match rather than refusing outright.
- `buildSymbolPattern()` covers JS/TS, Python, Rust, and Go-ish declaration shapes (function/class/const/let/var/def/interface/type/struct/enum/fn/func, plus a generic method-shorthand line) in one combined regex — case-sensitive, unlike `/grep`'s case-insensitive default, since a symbol name is an identifier.

`repoSearch.test.js` (new, 16 tests, real throwaway directories), `commandRouter.test.js` (+13). 1275 → 1304 backend tests, zero regressions.
**Depends on:** M1/M2 not required, but shipped after them — same review category, same review pass.
**Risk (realized):** medium, as predicted — the highest-blast-radius new surface this phase adds. Adversarial coverage: stays inside the project root (reuses `resolveWithinProject()` directly), skips binary files (reuses `looksBinary()`), never descends into `node_modules`/`.git`/etc. (reuses `DEFAULT_IGNORE_DIRS`), and both caps are exercised at small scale in tests via overridable options rather than only reasoned about.

### M4 — TODO/FIXME Discovery (`/todos [project]`)
A thin, pre-canned `/grep` for `TODO|FIXME|XXX`-shaped comments, formatted as a list with file:line. Built entirely on M3's primitive — no new capability underneath it, just a friendlier front end. Kill switch: reuses `operator.search.enabled`.
**Depends on:** M3. **Risk:** low (inherits M3's guard, adds no new surface).

### M5 — Test & Verification Visibility (`/tests [project]`)
Surfaces the **already-computed** result of the most recent mission's verification run (from `checkpoint.js`'s persisted data) — which specific verifiers passed/failed and why, not just the aggregate count + confidence label `missionCard` shows today. **Explicitly does not run tests on demand.** Running tests is executing arbitrary code remotely — a different risk class than reading a result that already exists on disk, and the 2026-07-29 consolidation review already ruled this out correctly: an on-demand "run tests now" belongs to the mission-request pipeline (as a mission objective, approval-gated), never a bare convenience command. This milestone only ever reads.
**Depends on:** nothing new architecturally; reads existing `checkpoint.js` data. **Risk:** low.

### M6 — AI-Assisted Engineering Mission Templates
The Class-B capability from §1, delivered as a small family of shortcut commands, each one a fixed, reviewed mission-prompt template submitted through the existing mission pipeline:
- `/review [project]` — code review of the current diff (or whole project if not a git repo), read-only objective.
- `/architecture [project]` — a summary of the project's structure and major components.
- `/docgen [project] <path>` — draft documentation for a specific file or module.
- `/refactor [project] <description>` — a **proposal only** (the mission's objective is explicitly "propose a plan, do not implement it" for the first-pass version of this command; actually applying a refactor is just a normal mission request afterward, inheriting the standard two-gate approval before any write).

Each of these is syntactic sugar over "submit this specific objective text as a mission request" — `CommandRouter` needs a small table mapping command name → template string, not a new mission type. Every existing guarantee (Safe Mode, two-gate approval, event logging, checkpoint/artifact reporting) applies automatically, because nothing about mission execution changes.
**Depends on:** none of M1–M5 structurally, but sequenced after them because `/review`'s prompt template is materially better once M1 (git diff context) exists to feed it.
**Risk:** low-to-medium — the risk isn't a new execution path (there isn't one), it's prompt quality (a bad canned template produces a bad mission, same as a bad free-form request would) — mitigated by treating each template as reviewed, versioned text, not user input.

### M7 — Phase 12 M4 Re-evaluation (Launch Experience & Remote Project Creation)
Per the owner's 2026-07-30 direction, formally re-evaluate the still-deferred `docs/PHASE_12_PLAN.md` §4 scope now that M1–M6 above exist. Original scope: a launcher/Start Menu experience and `/new` (remote project creation with mandatory plan approval). Deliverable of this milestone is a **decision**, not code: resume M4 as originally scoped, resume it with a narrower scope now that most of what motivated it (remote model/provider management, remote file access, live config) has since shipped independently, or defer again with a stated reason. Not pre-decided by this plan.
**Depends on:** conceptually on M1–M6 existing, since M4's original scope overlaps less with them now than it did in 2026-07-28.
**Risk:** N/A — this milestone is a decision point, not an implementation.

### M8 — Remote Configuration Completion — SHIPPED, `v3.14.0`
Closes owner directive #11's remaining gap: notification channels and the approval mode required editing `config/local.json` by hand. Mirrors the exact pattern `/safemode` established in the 2026-07-30 reconciliation pass (a `LIVE_MUTABLE_PATHS`-allowlisted, live-mutable config flag, isolated from in-flight missions the same way `/model` already is).

**Shipped shape (deviates from the original sketch above in two ways):**
- `/notify [status|<telegram|email|discord|webhook> on|off|severity <level>]` — **no `tune`/`test` subcommand.** Sending a real test notification is an action with a side effect outside this command's own state (an actual message lands in a channel), which is a different risk class than every other setting this milestone touches; deferred rather than folded in.
- The approval-mode equivalent is `/approvals mode [conservative|balanced|autonomous]`, a subcommand on the existing `/approvals` command — **not a new top-level `/approval` command.** `APPROVE`/`REJECT`/`MODIFY`/`DONE` are already decision verbs in this grammar (`commandGrammar.js`'s `parseDecisionText` check runs before any command match), so a new near-homophone command risked exactly the kind of shadowing that grammar file's own design notes warn against. Reusing `/approvals` (plural, already Decisions-category) with a `mode` sub-word follows the same convention `/roots add/remove` and `/projects classify` already established. `/approvals` with no argument is unchanged — still lists pending decisions.

Deliberately narrow scope, confirmed with the owner before implementation: only `<channel>.enabled` and `minSeverity`/`mode` are remotely settable. Credentials (`botToken`, `chatId`, SMTP `host`/`user`/`pass`) are never set, changed, or displayed remotely — same boundary this codebase already draws for `nvidia.apiKey`. Kill switch: `operator.liveConfig.enabled` (the same one `/roots`/`/model`/`/safemode` already share — no new switch, this is the same capability class). New events: `notifications.channel-changed`, `notifications.severity-changed`, `approvals.mode-changed`.
**Depends on:** nothing new; reuses the M4 (Phase 13) live-config layer directly.
**Risk (realized):** low, as predicted — no new mutation mechanism, no new kill switch, four new `LIVE_MUTABLE_PATHS` entries plus two already-allowlisted from earlier milestones. 1258 → 1275 backend tests, zero regressions.

### M9 — Remote Mission-Readiness (`promptFile` assignment) — SHIPPED, `v3.10.0`
Closes the gap found fresh in the 2026-07-30 acceptance review: 19 of 23 real registered projects have no `promptFile` and today the only fix is hand-editing `config/projects/<name>.json` outside the operator interface entirely.

**Shipped shape (deviates from the original sketch above in three ways, each forced by something the sketch got wrong about the existing codebase — see the implementation plan's own "Context" section for the full reasoning):**
- `/mission [project]` and `/mission all` — **auto-detect only, no manual `<objective text>` argument.** `resolveTarget()`'s "the whole rest IS the project name" rule can't combine with trailing free text without an ambiguous split (several real project names contain spaces, e.g. `"THE FINISHER"`), and inspecting the repo is what was actually asked for (see the owner's 2026-07-30 direction to enrich M9 with detected stack metadata, not just a bare prompt).
- Writes via `ConfigManager.updateProject()`, not `saveProject()` — `saveProject()` throws if the project already exists, which every M9 target does (it was created by `/import`/`/import all`).
- A new deterministic detector, `src/operator/projectInspector.js` — reads `package.json`/`requirements.txt`/`pyproject.toml`/`Cargo.toml` off disk (no AI, no mission pipeline; this is a Class A read per §1) and reports `language`/`framework`/`packageManager`/`buildCommand`/`testCommand`/`tags`/`confidence`/`signals`. Stored in a new `stack` config field — **not** named `classification`, which already means something else in this codebase (the Phase 13 M3 lifecycle enum).

Never overwrites an existing `promptFile`/`tasks` (no `--force` in v1). Kill switch: `operator.mission.enabled`. New event: `project.mission-assigned`. Full detail: `CONFIGURATION.md`'s "stack" section, `docs/OPERATOR_CONSOLE.md`'s Registry section.
**Depends on:** none structurally — the single highest-value item in this phase per the acceptance review's own finding (Part 6).
**Risk (realized):** low-medium as predicted — writes a new file (the prompt) and mutates the registry via an already-exercised path (`updateProject()`, used since Phase 13 M3). 1219 backend tests (was 1194 before the NVIDIA driver + this milestone), zero regressions.

---

## 3. Dependency graph

```
M0 (Workspace Overview)
  [independent]

M1 (Git Visibility)  ---+
                         |--> M6 (AI-Assisted Mission Templates, esp. /review)
M2 (Log Visibility)      |
  [independent]          |
                         |
M3 (Repo/Symbol Search) -+--> M4 (TODO Discovery)
  [independent]

M5 (Test/Verification Visibility)
  [independent]

M7 (Phase 12 M4 re-evaluation)  -- conceptually informed by M1-M6, not code-dependent

M8 (Remote Config Completion)   -- independent, reuses Phase 13 M4's live-config layer

M9 (Remote Mission-Readiness)   -- independent, reuses Phase 13 M2/M3's registry-write path
```

Recommended ship order by value/risk (not a hard dependency chain): **M9, M0, M1, M2, M8, M3, M4, M5, M6, M7** — the acceptance review's own finding (Part 6) is that M9 is the single highest-value item, and M0/M1/M2/M8 are the lowest-risk, already-precedented items (M0 slotted right after M9 since it's the direct answer to "I can only see six projects" and reuses nothing but existing registry reads). M6 is sequenced late because its best version wants M1's git-diff context. M7 is last because it is a decision, not a build, and is best made once the rest of the phase's actual shape is known.

**Already shipped ahead of this sequencing, 2026-07-30:** an optional `nvidia` driver (`src/drivers/nvidiaDriver.js`) — a fallback text-completion engine for when `claude` is unreachable, requested and approved the same day as this addendum. It's a genuinely new `AIDriver` implementation, not a new subsystem (same extension point `cli`/`mock` already use), and it has a stated capability boundary: no file/tool access (`toolUse: false` in `drivers/capabilities.js`), so it can only produce text results, never edit a workspace. Its API key lives in `config/local.json` (git-ignored), never in a tracked file.

---

## 4. What stays invariant (explicitly re-affirmed for this phase)

- **Single source of truth:** the daemon remains the only writer of registry/event-store state; every new command reads through the same `ProjectRegistry`/`EventStore` every existing command uses.
- **Registry-based discovery:** no new command hardcodes a project name or path; everything resolves through the active-project context the same way `/status`/`/files` do today.
- **Provider abstraction:** M6's mission templates submit objectives, not driver-specific instructions — they work identically regardless of which `AIDriver` a project uses, exactly like a free-form mission request does today.
- **Event-driven architecture:** every new command that changes state (M8, M9) emits a new, specific event type, following the existing `eventTypes.js` pattern (e.g., `notifications.channel-changed`, `approvals.mode-changed`, `project.mission-assigned`) — nothing is a silent mutation.
- **Centralized security:** every new filesystem-touching command (M2, M3, M4) goes through the one existing `fileAccess.js` guard, not a new one — a second path-traversal implementation would itself be a new architectural surface and is explicitly rejected as an approach.
- **Honest reporting:** M6's mission templates are subject to the same "no invented estimates," real-artifact-only reporting discipline as every other mission — a `/review` that didn't actually read the diff must say so, not produce a plausible-sounding fabrication (this is the same discipline the 2026-07-30 review's own live testing verified is already enforced for ordinary missions).
- **Explicit validation:** every milestone above ships with the same discipline every Phase 12/13 milestone used — unit tests, then live validation against a real project through the real operator CLI bridge (or real Telegram, if available), with defects disclosed rather than patched around quietly.

---

## 5. Explicitly out of scope for Phase 14

- **An on-demand "run tests now" command** — already ruled out by the 2026-07-29 consolidation review and re-affirmed in M5 above: executing arbitrary code remotely is a mission-request-shaped action, not a convenience command.
- **A real symbol index / language server** — M3 deliberately stays at "good enough regex-based search," not a persisted AST or ctags database, because that would be new architecture (a new index to build, store, and keep in sync), which this phase's framing exists to avoid.
- **Any new persistence layer, new process model, or second execution path** — every milestone above was checked against this before being included; none require one.

---

## 6. Deliverable of this document

A decision, from the owner, on: (1) whether Phase 14 proceeds with this milestone set and ordering, (2) M7's actual disposition for Phase 12 M4, and (3) whether to begin implementation now or let this plan sit, per this project's own standing practice of not starting a new phase's code until the previous one is explicitly closed out. **Phase 13 is closed by `docs/PHASE_13_M9_ACCEPTANCE_REVIEW.md`.**

**Update, 2026-07-30:** the owner made decision (1) — proceed with this milestone set plus M0 (§0a) — and separately approved the `nvidia` driver described above. Both are now reflected in this document. Decision (2) and the choice of which remaining milestone to implement next are still open.
