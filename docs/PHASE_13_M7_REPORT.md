# Phase 13 M7 — Mission Completion Messaging

**Version:** `v3.7.0`
**Date:** 2026-07-29
**Plan:** [PHASE_13_PLAN.md](PHASE_13_PLAN.md)
**Predecessor:** [M6 — Remote File System](PHASE_13_M6_REPORT.md)

The plan billed this milestone as a copy change: point a completed mission's
owner at the M6 file commands. The owner's own directive, written from a real
incident ("File | Purpose …" — a message that ended mid-table), widened that
into six concrete requirements: never truncate a completion message, make it
file-aware, report real created/modified/deleted artifacts with real paths,
preserve the honesty discipline, preserve the existing architecture, and add
regression coverage. All six are addressed below, plus one real, disclosed
defect the milestone's own live validation found and fixed at the root.

---

## What was built

- **`src/mission/checkpoint.js`** — `buildCheckpoint()` now records
  `filesCreated` and `filesModified` as their own fields, sourced from the
  same `progressEngine.analyze()` diff that has always fed the (unchanged)
  merged `filesTouched`. Every existing reader of `filesTouched`/`filesDeleted`
  is unaffected — this is additive, not a rename.
- **`src/notifications/missionCard.js`**:
  - `buildMissionCard()` aggregates `filesCreated`/`filesModified` across a
    mission's tasks (deduped, same `Set` discipline the existing
    `filesChanged` aggregation already used), and now exposes `filesDeleted`
    as its own array too (previously only visible baked into `filesChanged`'s
    `"(deleted)"`-suffixed entries). A checkpoint written before this
    milestone existed (no `filesCreated`/`filesModified` fields at all) never
    fabricates a split — the card simply omits those fields, exactly like
    every other optional field this module has always degraded gracefully
    for.
  - New `renderArtifactSummary(card)` — the FULL, real-path breakdown under
    `Created:`/`Modified:`/`Deleted:` headings, deliberately **uncapped**
    (deliberately *not* reusing `renderMissionCardText()`'s existing 8-file
    cap): a one-time completion report must not silently drop paths the way
    the compact card view legitimately does for a repeating `/status` check.
    Falls back to a neutral `Changed:` heading — never an invented
    created/modified split — when a card carries only the legacy merged
    `filesChanged` data.
- **`mission:complete`'s message** (`notificationEngine.js`) now composes,
  in order: the existing compact Mission Card, the new full artifact
  breakdown, the agent's own summary, and a new footer:

  ```
  📂 Inspect the results:
  /project <name>
  /files
  /file <a real created/modified path from THIS mission>
  /download_project <name>
  ```

  `/project <name>` is included first and unconditionally: `/files`/`/file`
  only ever read the *active* project (M6's own deliberate design — a path
  and a project name are both free-form strings with no way to disambiguate
  them), and the notification has no way to know what a given channel's
  active project currently is. Re-selecting an already-active project is a
  harmless no-op, so this is the one line that makes every line below it
  correct regardless of context. The `/file` example uses a REAL path from
  this mission (`filesCreated[0]` first, then `filesModified[0]`) when one
  exists, falling back to a generic `README.md` only when nothing changed.
- **Reachability gating.** The footer is worthless — worse than worthless,
  actively misleading — if nothing is listening for the commands it
  advertises. `NotificationEngine` gained an optional `operatorConfig`
  constructor option (the same "optional collaborator, omit for old
  behavior" pattern `approvalsConfig` already established) consulted only to
  decide whether to show the footer:
  - The **daemon** (`daemon.js`) passes its real `operator` config — it
    genuinely owns a live `CommandRouter`.
  - A **daemon-forked worker** (`app.js`, `workerMode === true`, the existing
    `--worker`/`AI_ORCHESTRATOR_DAEMON_PID` plumbing from Phase 12 M1) passes
    the real `operator` config too — a live daemon forked it moments ago,
    and daemons in this architecture are long-running by design.
  - A **bare interactive `ai-orchestrator start`** (no daemon, `workerMode
    === false`) passes `{ enabled: false }`. This process has no
    `CommandRouter` at all — `app.js`'s own module header already states the
    governing rule ("`ai-orchestrator start` never consults \[the operator\]
    block") — so advertising `/files` here would point the owner at a
    command nothing on the machine is listening for.

---

## Real defect found during live validation, fixed at the root

Building the footer and artifact breakdown required a real, completing
mission to validate against. The obvious zero-cost choice was a `mock`-driver
fixture scripted to create one file and modify another (see Verification
below) — and doing that surfaced a genuine, previously-latent bug that
predates this milestone entirely:

**`SIMULATION_NOTICE_PAST` ("no code was written, no tests were run") is not
true in general.** It was written to describe `validation-sandbox`, which is
deliberately configured to write nothing — but the mock driver has always
supported scripted `writeFile`/`appendFile` (`mockDriver.js`, added
specifically "so the progress engine can be exercised end-to-end"), so a
project can legitimately be `simulated: true` while a scripted run writes
real files. Every prior milestone's simulated-mission fixture happened to
write nothing, so this never surfaced. Live-validating M7 against a fixture
that *does* write scripted files produced a real message that said, verbatim:

```
🧪 Simulated project — this mission was a rehearsal. The engine was a
scripted fixture: no code was written and no tests were run.
...
Created:
• src/calculator.js
```

A direct, visible self-contradiction one screen tall — the opposite failure
mode from the M2.2 incident this module's own history is built on (there, a
mission hid real emptiness behind "Verified"; here, the notice would have
hidden real content behind "nothing happened"). Fixed narrowly, in
`renderMissionCardText()` only (the one call site with concrete after-the-fact
evidence to check the claim against): a simulated mission whose card shows
real file changes gets an accurate variant of the notice instead ("...any
files listed below were part of that script, not independent judgment"); a
simulated mission that wrote nothing keeps the original, still-correct
wording. The pre-run `SIMULATION_NOTICE` (shown before anything has executed)
is untouched — "no code is written yet" is still an accurate forward-looking
statement there.

This is disclosed here rather than folded silently into "new feature" prose,
matching this project's standing practice (see M6's four defects, M4's
`deepMerge` bug, M2's classification heuristic notes).

---

## How the six directive requirements map to what shipped

1. **Complete mission messages, never truncated.** Already structurally
   guaranteed by M1's `sendLongText()` at the channel level — this milestone
   adds no new truncation anywhere (the new artifact breakdown and footer are
   plain, unbounded string concatenation) and a regression test sends a
   250-file real breakdown through the actual `TelegramChannel` to prove the
   whole composed message still splits cleanly with nothing lost.
2. **File-aware completion summaries.** The footer's `/file` example uses a
   REAL path from the mission, not a placeholder, whenever one exists.
3. **Real artifact reporting (created/modified/deleted, real paths).**
   `renderArtifactSummary()` — see above.
4. **Preserve honesty.** No new field is ever invented: legacy checkpoints
   fall back to a neutral "Changed" heading rather than a guessed split; the
   footer is suppressed rather than shown when it would point at an
   unreachable command; the simulation-notice defect above is exactly this
   requirement, applied to code that predates the requirement being written
   down.
5. **Preserve architecture.** Nothing new sits between Worker and Telegram —
   the message is still built and sent entirely inside the worker's own
   `NotificationEngine` → `TelegramChannel`, exactly as before. No new event
   types were added; no new command was added; `CommandRouter`/`fileAccess.js`
   (M6) are untouched.
6. **Regression protection.** See below.

---

## Verification

**1155 → 1173 backend tests** (+18): `checkpoint.test.js` (+1, the
created/modified split), `missionCard.test.js` (+8: aggregation split,
legacy-fallback, `renderArtifactSummary`'s three shapes, and the two
simulation-notice tests for the defect above), `notificationEngine.test.js`
(+9, the directive's own regression list):
- a real project name and a REAL path substituted into the footer;
- the generic fallback example when nothing changed;
- the footer suppressed under `operator.files.enabled: false`;
- the footer suppressed under `operator.enabled: false` (the bare-standalone
  case);
- the footer shown by default when no `operatorConfig` is passed at all
  (`notify test`/`notify resend`'s existing calling convention);
- **large file lists**: 15 created + 1 deleted path, all present, uncapped,
  with an explicit assertion that no `…` ever appears;
- **legacy checkpoints**: a `filesChanged`-only card renders under `Changed:`,
  never inventing a created/modified split;
- **simulated missions**: the simulation notice stays above the fold with the
  new content correctly ordered beneath it;
- **multi-part Telegram responses**: a real `TelegramChannel` (fake `fetch`,
  real `formatTelegramText`/`sendLongText`/`splitForTelegram` code paths) sent
  a 250-file real breakdown, confirmed to split into more than one part, every
  file present somewhere across the parts, and every part independently
  well-formed HTML (equal open/close tag counts — no split mid-tag).

Binary attachment references and real-driver-mission coverage are
unaffected by this milestone (no code in `fileAccess.js`/`commandRouter.js`
changed) and remain covered by M6's own suite — confirmed by the fact that
`npm test`'s full 1173/1173 run includes every M1–M6 test file unmodified
and green.

**Live validation, against the real Core Service (pid 8940, no restart
needed — see below) and the real Telegram bot:**

- A throwaway, disclosed-as-such fixture (`config/projects/m7-validation.json`,
  `driver: mock`, `simulated: true`, two tasks, scripted `writeFile`/
  `appendFile`) was started via `ai-orchestrator daemon start m7-validation`
  — a REAL forked worker (pid 25676), not a simulated harness call. The real,
  persisted `state/tasks/m7-validation.json` shows exactly what was designed:
  `T1.checkpoint.filesCreated: ["src/calculator.js"]`,
  `T2.checkpoint.filesModified: ["README.md"]` — the new checkpoint fields
  working correctly end to end in a real (forked, supervised) mission, not
  just under unit tests.
- The real orchestrator log (`logs/orchestrator-2026-07-29.log`) confirms:
  `changes":{"created":1,...}` for run 1, `"modified":1` for run 2, "Mission
  complete (all tasks done)", and a clean worker shutdown — zero warnings,
  zero "Notification channel failed" entries.
- A dedicated live-send harness (the same evidence technique M6 used for its
  `sendDocument()` proof: the real, production `NotificationEngine` +
  `TelegramChannel`, wired to the real bot token/chat id in
  `config/local.json`, fed the REAL card built from the real persisted
  checkpoint above) sent the actual composed `mission:complete` message
  through the real Telegram Bot API. **Two genuine returned message ids**
  (`166`, then `167` after the simulation-notice fix), not simulated:
  message `166` is the one that caught the self-contradiction described
  above; message `167` confirms the fix, showing `Created: • src/calculator.js`
  and `Modified: • README.md` with an accurate simulation notice and the
  full footer (`/project m7-validation`, `/files`, `/file src/calculator.js`,
  `/download_project m7-validation`).
- **Every footer command was then tapped through the real live
  `POST /api/operator/command` API** (the same real, loopback-only,
  token-authenticated endpoint M6 validated), against the real result:
  `/project m7-validation` selected it; `/files` listed the real 3 entries
  (`src/`, `prompt.md`, `README.md`); `/file src/calculator.js` returned the
  exact real file content the mock driver wrote
  (`export const add = (a, b) => a + b;`); `/download_project m7-validation`
  produced a real 213-byte, 3-file ZIP (confirmed present on disk at
  `state/operator/downloads/`).
- The daemon's own version string (`v3.6.0`) never needed to change for any
  of this: the worker is freshly forked from the current files on disk every
  time `daemon start` runs, so it already ran this milestone's code without a
  daemon restart. The long-running daemon process was restarted once, after
  this milestone was committed and tagged, purely so `daemon status` reports
  the correct `v3.7.0` going forward — not because any functional path
  required it (no command-handling code in `commandRouter.js`/`fileAccess.js`
  changed).
- **Cleanup**: the throwaway project's config, working directory, and every
  generated state file (`state/{ledger,lifecycle,progress,sessions,tasks,
  timeline}/m7-validation.*`, the generated ZIP) were removed after
  validation; `daemon status` confirms the registry is back to exactly the 6
  real projects. The append-only event log's record of this validation run is
  left in place, matching the existing "never delete history, only the
  throwaway workspace" convention.

---

## Deliberately deferred

- **A per-channel "active project" lookup for the footer.** The notification
  layer has no visibility into which project is currently selected on any
  given Telegram chat (that state lives in `operatorContext.js`, read only by
  `CommandRouter`) — including `/project <name>` unconditionally is the
  correct, simpler fix; a smarter "only show it if not already active" would
  require threading channel/chat context into a layer that has never needed
  it and, per the owner's own architecture preference, should not start now.
- **A live-detected "is the daemon that forked me still alive" check for
  workers.** A worker could in principle outlive the daemon that forked it
  (Phase 12 M1's detached-process design is explicitly built to allow this)
  and complete after that daemon has shut down, in which case the footer
  would advertise commands nothing is listening for. Building real cross-
  process liveness detection for this narrow window is new architecture the
  plan explicitly scoped this milestone to avoid ("nothing structurally
  new"); `workerMode` (correct in the overwhelming majority of real cases,
  since daemons are long-running by design) is the deliberate, disclosed
  approximation.
- **`docs/OPERATOR_CONSOLE.md`** — not touched, consistent with M2 through
  M6; a full pass is M8's explicit scope.

---

## What's next

Phase 13 M8 — Bot Experience & Discoverability (`v3.8.0`): categorized
command metadata and a grouped `/help`, auditing the final command surface
across M2/M5/M7 once. See [PHASE_13_PLAN.md](PHASE_13_PLAN.md).
