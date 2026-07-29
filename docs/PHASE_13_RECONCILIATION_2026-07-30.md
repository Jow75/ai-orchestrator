# Reconciliation Pass — 2026-07-30 (`v3.9.0`)

**Trigger:** an owner directive to reconcile the repository against its own
prior audits/reports before starting Phase 13 M9, and to resolve three
specific open items: the deferred project-classification migration, an
undefined "Safe Mode," and a project-registry exposure gap on Telegram.
**Predecessor:** [M8 — Bot Experience & Discoverability](PHASE_13_M8_REPORT.md).
**Not a numbered Phase 13 milestone** — `PHASE_13_PLAN.md` was not amended;
this is a reconciliation pass ahead of M9, versioned because real code
shipped.

---

## 0. What the directive claimed vs. what the repo actually has

The directive named three documents as authoritative: "Phase 12 Engineering
Audit," "Phase 13 Engineering Audit," and "Engineering Reconciliation
Report." None of the three exist under those names anywhere in this
repository. Searched by content, not just filename — nothing matches. The
closest real equivalents are
[PHASE_13_CONSOLIDATION_REVIEW.md](PHASE_13_CONSOLIDATION_REVIEW.md)
(2026-07-29) and the per-milestone `PHASE_1X_M*_REPORT.md` files, which do
exist and were used as the actual source of truth for this pass. Recorded
here rather than silently substituting one for the other without saying so.

---

## 1. Reconciliation findings

- **Repo state**: `v3.8.0` tag matched HEAD; main was 3 commits ahead of
  `origin` (still unpushed, owner's own standing policy — every prior push
  in this project's history required explicit go-ahead); two files
  (`PROJECT_CONTEXT.md`, `PHASE_13_M6_REPORT.md`) were already modified but
  uncommitted from a prior session, both accurate. Committed as-is
  (`ccaccf4`) before any new work started.
- **Classification migration**: `classifyProposal()` re-run live against
  the real `ConfigManager` reproduced the exact same 6-project table
  `PHASE_13_M3_REPORT.md` documented at `v3.3.0` — the heuristic and the
  data were both still correct, only the confirmation had never happened.
- **"Safe Mode"**: confirmed absent — zero matches across code, docs, and
  `ROADMAP.md`. Not a forgotten feature; undefined until this pass.
- **Phase 12 M4**: still deferred per its own re-evaluation clause in
  `PHASE_12_PLAN.md` (`§M4 deferral`) — unaffected by this pass.
- **Registry exposure gap**: `/scan` (Phase 13 M2) already found every real
  project correctly — live-verified against the real
  `C:\Users\Admin\Music` root, 17 real candidates, zero false positives,
  zero false negatives, `AI-Orchestrator`'s own checkout correctly
  self-excluded. The gap was operational, not architectural: `/import`
  only ever took one path, so registering 17 real folders meant 17 manual
  commands nobody had run.

Full findings, with evidence, were presented to the owner before any
registry write or new code — see the conversation this report summarizes.
The owner approved all four proposed actions: execute the classification
migration, build and immediately run a batch-import command, implement
Safe Mode as proposed, and commit the pending docs.

---

## 2. What shipped

- **`/import all`** (`src/operator/commandRouter.js`) — proposes every
  current `/scan` candidate in one message, then registers all of them
  inside a single `ConfirmationStore` confirmation, mirroring the exact
  pattern `/projects classify` already established for "propose once,
  confirm once, write N records." Still strictly additive: `saveProject()`
  never touches a candidate's files, and any import can be undone
  individually with the pre-existing `/forget <name>`. A defensive
  re-check inside `perform()` skips (rather than double-registers) any
  candidate that got claimed by something else between the proposal and
  the confirmation.
- **Safe Mode** (`operator.safeMode`, `/safemode on|off`) — a new global,
  live-mutable config flag (`src/config/defaults.js`, added to
  `LIVE_MUTABLE_PATHS` in `src/config/liveConfig.js`). `ClaudeDriver`
  (`src/drivers/claudeDriver.js`) takes a `safeModeProvider` closure,
  forwarded through `DriverRegistry` (`src/drivers/driverRegistry.js`) and
  wired in `src/app.js` exactly like Phase 13 M5's existing
  `defaultModelProvider` — same closure shape, same "read fresh per
  launch, never disrupts an in-flight worker" isolation guarantee. While
  on, `buildArgs()` omits `--permission-mode` and
  `--dangerously-skip-permissions` regardless of what a project's own
  config says, which is not a new safety mechanism — it is the existing,
  pre-Safe-Mode headless-Claude default (auto-deny writes) that any project
  with no `permissionMode` set already gets today, now forceable
  machine-wide. **Deliberately scoped to `ClaudeDriver` only** — the
  generic `cli` driver has no standardized permission concept for Safe Mode
  to override, and `mock` writes nothing regardless. Not a partial
  implementation of a wider promise; Safe Mode only ever claimed to govern
  the one driver that has a permission concept to govern.
- **New event type**: `operator.safemode-changed` (`src/events/eventTypes.js`).
  `/import all` needed no new event type — it reuses the existing
  `project.imported`, once per project actually imported.

## 3. What was deliberately not built

- **Phase 12 M4** — recommendation only, per the directive's own
  instruction not to implement it this pass. `PHASE_12_PLAN.md` already
  says M4 gets re-evaluated once Phase 13 finishes; M9 is next and
  process-only, so M4's re-evaluation is deferred again, to fold into the
  Phase 14 planning the directive asks for after M9.
- **`/git`, `/log`** — still the two real gaps identified in the
  2026-07-29 consolidation review, unaffected by this pass. Candidates for
  Phase 14.
- **Safe Mode for the `cli` driver** — see above; there is nothing to
  override there today. If a future CLI-based project config grows a
  standardized permission concept, this is where it would plug in.

---

## 4. Verification

**1194/1194 backend tests** (was 1178 after M8; +16 this pass —
`liveConfig.test.js`'s existing allowlist-iteration test automatically
covers the new `operator.safeMode` entry with no edit needed):

- `claudeDriver.test.js` (+4): `buildArgs()` forwards a project's own
  permission settings unchanged with no `safeModeProvider` wired at all
  (regression) and with it explicitly false; strips both flags when true,
  even for a project that explicitly asked for write access; the closure
  is read fresh per call, so a toggle mid-session never touches an
  already-returned args array.
- `driverRegistry.test.js` (+3): `safeModeProvider` forwarding mirrors the
  existing `defaultModelProvider` coverage exactly — forwarded to `claude`,
  harmless to pass to `mock`/`cli`, and absent-by-default behaves as if
  Safe Mode never existed.
- `commandRouter.test.js` (+9): three `/import all` tests (proposes then
  confirms; "nothing to import" when `/scan` is empty; skips a candidate
  claimed between proposal and confirmation) and six `/safemode` tests
  (default off; on/off round trip live with no restart; already-on is a
  no-op that writes no event; an invalid argument is refused; refused when
  `operator.liveConfig` is disabled).

Full suite: `npm test` — 1194/1194, zero regressions across every prior
phase's test file.

**Live validation against the real Core Service** (daemon restarted,
pid 11248 v3.8.0 → pid 3852 v3.9.0, via PowerShell — not Git Bash, per this
project's own documented leading-`/`-rewrite gotcha, same precaution M8's
report disclosed learning the hard way):

1. `/projects classify` against the real 6-project registry reproduced the
   identical table `PHASE_13_M3_REPORT.md` recorded at `v3.3.0`; confirmed
   via `/confirm RHNJ`; `classification` verified written to all 6 real
   `config/projects/*.json` files by direct read after the command
   returned.
2. `/scan` against the real `C:\Users\Admin\Music` root found the same 17
   candidates this pass's earlier investigation found manually, byte-for-
   byte matching names and paths.
3. `/import all` proposed those same 17, confirmed via `/confirm M6CU`,
   returned "Imported 17 project(s)"; `config/projects/` directory count
   verified 6 → 23 by direct listing; a follow-up `/scan` confirmed "No new
   projects found — everything under your roots is already registered."
4. `/safemode` defaulted to off; `/safemode on` returned live confirmation
   text and was verified written to `config/local.json` on disk (the
   live-config mechanism's actual persistence target); `/safemode off`
   restored it afterward — left off, since turning it on was this pass's
   validation step, not an owner request to make every future mission
   read-only by default.

Event count: 297 → 339 across this validation run (6 `project.classified`,
17 `project.imported`, 2 `project.discovered`, 2
`operator.safemode-changed`, plus the `command.received`/`command.confirmed`
pairs for each). Nothing was cancelled or corrected mid-run — no defect
found during this pass's own live validation, unlike M1/M6/M7/M8.

---

## 5. What's next

`/help` now lists 30 commands (was 29). `docs/OPERATOR_CONSOLE.md` updated
to match, plus its "last audited" line and command count. `PROJECT_CONTEXT.md`
and `CHANGELOG.md` updated in the same commit as this report.

Phase 13 M9 — Public Release Prep now audits `v3.9.0` rather than `v3.8.0`
(a direct consequence of this pass landing code before M9 started, not a
scope change to M9 itself). Recommend M9 proceeds unchanged otherwise. See
[PHASE_13_PLAN.md](PHASE_13_PLAN.md).

After M9, per the owner's own directive: fold Phase 12 M4's re-evaluation
into formal Phase 14 planning (Remote Engineering, Remote Code Review,
Repository Analysis, Symbol Search, Diff Review, Test Review, Documentation
Generation, Architecture Review) — planning only, no implementation, per
the directive's own instruction.
