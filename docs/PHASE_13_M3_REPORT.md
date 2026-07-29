# Phase 13 M3 — Project Lifecycle & Registry Operations

**Version:** `v3.3.0`
**Date:** 2026-07-29
**Plan:** [PHASE_13_PLAN.md](PHASE_13_PLAN.md)
**Predecessor:** [M2 — Project Roots & Discovery](PHASE_13_M2_REPORT.md)

The registry stops treating every project as equally live. Owner-set
classification (production/development/validation/demo/archived/hidden)
plus registry-only lifecycle operations — strictly split from filesystem
deletion, which this system still does not implement, on any path.

---

## What shipped

- **`src/config/projectClassification.js`** — the six classifications, named
  "classification" rather than "lifecycle" deliberately: that word already
  belongs to `missionLifecycle.js`'s mission-RUN state machine.
- **`ConfigManager.updateProject()`** — patches a project's raw on-disk
  file. **A real design decision, not a literal reading of the plan**: the
  plan text said `updateProject` "re-validates" a patched project, but full
  validation (`validateProject()`) requires a `promptFile` or task plan —
  meaning an M2-imported, no-mission-yet project (which already fails that
  validation) could never be archived or hidden if `updateProject` enforced
  it, exactly backwards from what lifecycle operations are for. Implemented
  instead to only check that a patched `classification` is a real one;
  mission-readiness is a separate concern this milestone doesn't gate on.
- **`ConfigManager.deleteProject()`** — removes only the registry file.
- **`ConfigManager.getProjectFileContents()`** — a new primitive: the
  UNMERGED file, with no `PROJECT_DEFAULTS` applied. Needed because
  `classification` now has a default (`'development'`) — the existing
  `getRawProject()` (which merges defaults) would make every project look
  already classified, defeating the migration's whole "propose for projects
  missing one" logic. Caught and fixed during implementation before it ever
  reached a test.
- **`src/operator/projectLifecycleOps.js`**: `archive()`, `restore()`,
  `hide()`, `unhide()`, `forget()`, `classifyProposal()` — pure functions
  the router calls.
- **Commands**: `/archive [project]`, `/restore [project]`, `/hide [project]`,
  `/unhide [project]` (reversible, non-destructive); `/forget [project]`
  (destructive — the existing `ConfirmationStore` flow, refuses while a
  mission is running); `/projects all` (includes hidden); `/projects classify`
  (proposes classifications for every unclassified project, one batch
  confirmation before anything is written).
- **`ProjectRegistry.list({includeHidden})`** — a `hidden` project is
  filtered from the default listing; an `archived` one stays listed but
  sorts after every live status, badged `📦 ARCHIVED` (mirroring the
  existing `🧪 SIMULATED` convention). A `misconfigured`/`missing` project
  has no classification at all and is never affected by either rule — it
  must always still be listed, unconditionally.
- New event types `project.archived`, `project.restored`, `project.hidden`,
  `project.unhidden`, `project.forgotten`, `project.classified`. New
  `operator.lifecycle.enabled` kill switch (default `true`).

## The migration heuristic, live-validated against real data

`classifyProposal()`'s inference (simulated engine → demo; lives inside
AI-Orchestrator's own install → demo; `$comment`/description mentions
"valid" → validation; otherwise development) was checked against the real
6 project files on this machine, not just synthetic test fixtures:

```
THE FINISHER         -> development  (no strong signal either way)
calculator-proof     -> validation   (described as a validation exercise)
example              -> demo         (lives inside AI-Orchestrator's own installation)
phone-demo           -> validation   (described as a validation exercise)
validation-demo      -> validation   (described as a validation exercise)
validation-sandbox   -> demo         (simulated engine — never writes real files)
```

This exactly matches the plan's expected migration table. **Deliberately
not applied to the real registry** — same caution as M2's `/import`: the
actual write requires the owner's own `/confirm` from their phone, not this
session assuming consent on their behalf.

---

## Verification

- **1057/1057 backend tests** (was 1023; +34: `projectLifecycleOps.test.js`
  including a test that reproduces the exact real 6-project migration table
  from synthetic fixtures matching the real files' actual `$comment`/
  `description` text, plus coverage in `configManager.test.js`,
  `projectRegistry.test.js`, `operatorRender.test.js`,
  `commandRouter.test.js`, and one `commandGrammar.test.js` assertion
  updated for the new `forget` destructive command).
- **Live validation**: `classifyProposal()` run against the real, loaded
  `ConfigManager` for all 6 real projects — output shown above, matching
  the plan exactly. The mutation paths themselves (`archive`/`hide`/
  `restore`/`unhide`/`forget`/apply-classification) are covered by the
  isolated test suite only, for the same reason M2's `/import` was: writing
  to the owner's real `config/projects/` without their request would be an
  uninvited persistent change.

---

## What's next

Phase 13 M4 — Live Configuration Layer (`v3.4.0`). See
[PHASE_13_PLAN.md](PHASE_13_PLAN.md).
