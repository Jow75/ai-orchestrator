# Phase 13 M8 — Bot Experience & Discoverability

**Version:** `v3.8.0`
**Date:** 2026-07-30
**Plan:** [PHASE_13_PLAN.md](PHASE_13_PLAN.md)
**Predecessor:** [M7 — Mission Completion Messaging](PHASE_13_M7_REPORT.md)

The command surface grew from the 15 commands Phase 12 M2 shipped with
(confirmed against that milestone's own commit, `e18c2da`) to 29 today, each
later milestone adding its own commands without ever revisiting how the whole
set reads together. `/help` was still the original flat list — 29 entries
deep by this milestone — and `docs/OPERATOR_CONSOLE.md` documented only 16 of
those 29, last touched in Phase 12 M2/M2.2. M8 is the audit pass the plan
scoped for exactly this: organize the *existing* surface, add no new command,
and bring the docs current.

---

## What was built

- **`src/operator/commandGrammar.js`** — every `COMMANDS` entry gains a
  `category` (one of `General`, `Projects`, `Missions`, `Decisions`,
  `System`, `Registry`, `Configuration`, `Files`) and, for commands whose
  `usage` hint alone doesn't show a concrete value, an `examples` array of
  realistic invocations (`/import C:\Users\Admin\Music\new-project as "New
  Project"`, `/roots add D:\Development`, and so on). Both fields are
  additive metadata only, added to the same array `parseCommand()` already
  reads — never consulted by it. A category typo can misfile a command in
  `/help`; it cannot change what the command does, because the parser never
  looks at `category` or `examples` at all.
- **`src/operator/render.js`** — `renderHelp()` now sections its output by
  category, in the category's first-seen order *within the array it is
  given* — not a second, hand-kept list of section names that could drift
  from the grammar. `commands` is now an injectable parameter (default
  `COMMANDS`, matching the pattern `buildCommandMenu()` already established
  for the same testability reason). If any command in that array is missing
  a `category` — the exact shape a revert of the metadata commit above would
  leave behind — `renderHelp()` falls back to the pre-M8 flat list rather
  than rendering a broken or partial section.
- **The "Decisions" naming collision.** Grouping `/approvals`, `/missions`,
  `/confirm`, `/cancel` under a `Decisions` heading put that word two lines
  above the pre-existing `Decisions: APPROVE A7 · REJECT A7 …` footer line —
  same word, two unrelated meanings, in one message. Caught while manually
  inspecting the rendered output (below), not by a test. Fixed by relabelling
  the footer `Decision grammar: APPROVE A7 · …` — a one-line, non-breaking
  change (no test asserted the old string) that removes the ambiguity
  without touching the category name itself.
- **`docs/OPERATOR_CONSOLE.md`** — full pass. The command table now covers
  all 29 commands, grouped into the same eight sections `/help` uses:
  `/scan`, `/import`, `/archive`, `/restore`, `/hide`, `/unhide`, `/forget`,
  `/roots` (Phase 13 M2/M3), `/provider`, `/model` (M5), and `/files`,
  `/file`, `/download-project` (M6) were all live and working but
  undocumented here since their own milestones shipped — this page had not
  been touched since Phase 12 M2. Two real inconsistencies found during the
  pass and corrected in the same commit:
  - The "Not yet" section still described `operator.projectRoots` as
    defaulting to empty; it has defaulted to `C:\Users\Admin\Music` since M2
    (`src/config/defaults.js:370`).
  - The same section described project deletion as entirely unimplemented,
    which stopped being precisely true once `/forget` shipped in M3 —
    `/forget` removes a project from the *registry* only and never touches
    its files, so it is a different capability from the file-level deletion
    that section is actually about; the bullet now says so explicitly
    instead of silently overlapping with a command that already exists.
- **Localization scaffolding — documented, not built**, matching the plan's
  own framing. `menuDescription()` in `commandMenu.js` was already, before
  this milestone, the one function every Telegram-menu string flows through;
  M8 adds nothing here because there was nothing to add — a future
  localization pass has exactly one function to change, and that was already
  true.

## What was deliberately left alone

`commandMenu.js` — the Telegram tappable-menu builder — is **byte-for-byte
unchanged**. It read only `command.name`/`command.usage`/`command.description`/
`command.destructive` before this milestone and reads the same four fields
now; `category` and `examples` are invisible to it by construction, not by a
new filter that could later be forgotten. Confirmed by a new regression test
and by a live `--dry-run` (see Verification).

---

## Verification

**1173 → 1178 backend tests** (+5):

- `commandGrammar.test.js` (+2): every `COMMANDS` entry has a non-empty
  `category`, and the parser genuinely never consults it (`/status` parses
  identically with or without the field examined); every `examples` string
  parses back to the exact command it illustrates — a broken example would
  teach the owner a command that fails.
- `commandMenu.test.js` (+1): every published menu entry is
  `{command, description}` and nothing else — `category`/`examples` never
  leak into the object Telegram receives.
- `operatorRender.test.js` (+2): `/help` renders a heading line for every
  distinct category, in first-seen order, with commands sharing a category
  (`/help` and `/whoami`, both `General`, defined 15 array entries apart)
  grouped together despite that distance; a second test passes `renderHelp()`
  a `commands` array with `category`/`examples` stripped (the shape a
  revert of the metadata commit leaves) and confirms it falls back to the
  exact pre-M8 flat rendering — no thrown error, no empty section, no
  category heading with nothing under it.

Full suite: `npm test` — 1178/1178 passing, zero regressions across every
M1–M7 test file.

**A real, disclosed link-checker pass** (not new to this milestone, but run
again as part of the docs audit): every relative link across all 43 `.md`
files in the repository — including this report and the updated
`OPERATOR_CONSOLE.md`, both still uncommitted at the time of the check —
resolves. Zero broken.

**Live validation, against the real Core Service, not a simulation:**

The daemon (pid 25008, `v3.7.0`, 0 missions running) was stopped and
restarted (`daemon stop` → `daemon ensure`, now pid 11248, `v3.8.0`) — a real
restart was required here, unlike M7's cosmetic one, because `/help`'s
rendering runs inside the daemon's own long-lived `CommandRouter`, not a
freshly-forked per-mission worker; the old process would have kept serving
the pre-M8 flat list until it reloaded the code from disk. Telegram inbound
re-acquired exclusive ownership immediately on restart, confirmed by
`daemon status`.

`operator "/help"` was then run through `ai-orchestrator operator`, which the
project's own docs describe as "the same router your phone talks to" — a
real HTTP round trip to the live daemon's API, the exact `CommandRouter` code
path a Telegram message reaches, not a unit-test harness. The output matched
the grouped, eight-section shape exactly, including the corrected
"Decision grammar" footer line.

**A real incident during this check, disclosed rather than glossed over:**
the first attempt was run from a Git Bash shell, which — per this project's
own documented gotcha ("Git Bash on Windows rewrites a leading `/` into a
path") — silently rewrote `/help` into `C:/Program Files/Git/help`. The
router correctly treated that as free text rather than a recognized command
(exactly the designed behavior: an unrecognized string is never guessed
into a command), which made it a mission objective for the active project
(`calculator-proof`) and created a real mission request, `M9`. This is not a
defect in code this milestone touched — it is the exact, previously
documented shell interaction the docs already warn about — but it was a
real, live side effect against the real registry, so it is recorded here
rather than silently cleaned up: event `#285` (`mission.created`,
`{"id":"M9","objective":"C:/Program Files/Git/help"}`) followed immediately
by `#287` (`mission.cancelled`, `{"id":"M9"}`) once caught, run via
`operator "cancel M9"`. `M9` was never approved; no worker was ever forked;
nothing was written to `calculator-proof`. The corrected check was re-run
from PowerShell, which does not rewrite a leading `/`, and produced the
output above. The append-only event log's record of both the mistake and its
cancellation is left in place, matching this project's standing "never
delete history" convention.

A `notify commands --dry-run` (builds the real menu payload, prints it,
makes no network call) confirmed all 29 commands publish with descriptions
byte-for-byte identical to the pre-M8 menu — the regression test's claim,
independently confirmed against the real `buildCommandMenu()` output rather
than only a test fixture.

---

## Deliberately deferred

- **`/git` and `/log`** — recommended in
  [PHASE_13_CONSOLIDATION_REVIEW.md](PHASE_13_CONSOLIDATION_REVIEW.md) §2/§7d
  as real, distinct-value future commands. Explicitly not this milestone's
  scope: M8 organizes the *existing* surface, and adding either would be new
  grammar, not discoverability. Both would slot into the `System` or a new
  category cleanly given the structure this milestone just built, whenever
  they are taken up.
- **Actual localization** — the scaffolding note above stands; no second
  language, no i18n library, no config key. Nothing asked for this to be
  more than documented.
- **Reordering the `COMMANDS` array itself** to group entries contiguously
  by category was considered and rejected: the plan calls for additive
  fields only, grouping already happens correctly at render time via
  `category` regardless of array position (proven directly by `/help` and
  `/whoami` rendering together despite sitting 15 entries apart in the
  array), and reordering a frozen, widely-imported array for purely cosmetic
  reasons is exactly the kind of unnecessary churn this project's own
  conventions argue against.

---

## What's next

Phase 13 M9 — Public Release Prep (`v3.8.0`, process checkpoint, no code):
repeats the process run for `v3.0.0` — full regression, a `docs/` staleness
audit (this milestone already completed the operator-console piece of that),
README/QUICKSTART spot-checked against the real command surface, tags
verified — then presented for approval. See
[PHASE_13_PLAN.md](PHASE_13_PLAN.md).
