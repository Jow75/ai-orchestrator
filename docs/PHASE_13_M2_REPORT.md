# Phase 13 M2 — Project Roots & Discovery

**Version:** `v3.2.0`
**Date:** 2026-07-29
**Plan:** [PHASE_13_PLAN.md](PHASE_13_PLAN.md)
**Predecessor:** [M1 — Long Message Reliability](PHASE_13_M1_REPORT.md)

The operator stops treating sample folders as permanent projects. Configurable
`operator.projectRoots` — defaulting to `C:\Users\Admin\Music`, where every
current project already lives — are scanned for real, unregistered projects
instead of anything being hardcoded.

---

## What shipped

- **`src/operator/projectDiscovery.js`**, `scanRoots()`: one level deep per
  configured root, marker-probed (`.git`, `package.json`, `requirements.txt`,
  `pyproject.toml`, `Cargo.toml`, `README.md`) up to 2 folder levels further.
  Never descends into `node_modules`/`.git`/`dist`/`build`/`.next`/`.venv`/
  `__pycache__`; a directory containing `.git` is a scan **leaf** so a nested
  repo or demo folder inside a real project never becomes a false candidate;
  AI-Orchestrator's own installation directory is unconditionally excluded;
  an already-registered `workingDirectory` is excluded case/slash-insensitively.
  Two different folders sharing a basename under different roots are both
  reported with full paths, never silently collapsed. Always recomputed
  live — no cache, no state file, matching `ConfigManager.getProject()`'s own
  "never stale" philosophy.
- **`/scan`** (aliases `rescan`, `discover`) — read-only report of every
  candidate found and any configured root missing on disk.
- **`/import <path> [as <name>]`** — registers a real folder as a new
  project. Registry-only: never touches the folder. Name defaults to the
  folder's basename; `as <name>` sets an explicit one. (Path and project
  name can both legitimately contain spaces in this system — `"THE
  FINISHER"` is a real registered project name — so `<path> [name]`
  couldn't be split on whitespace alone; `as` is an unambiguous separator.)
  Refuses a name collision outright rather than guessing which project the
  owner meant.
- **`ConfigManager.getRawProject()`** — the merged definition without
  validation, letting `ProjectRegistry` distinguish "the workingDirectory
  itself is gone" from "some other configuration problem."
- **New `missing` project status** — split out from `misconfigured` for
  exactly that reason: the definition is fine, only the folder moved,
  was renamed, or was deleted outside AI-Orchestrator.
- New event types `project.discovered` (one per scan) and `project.imported`.
- `operator.projectRoots` default: `[]` → `["C:\\Users\\Admin\\Music"]`,
  disclosed explicitly (not folded into "new feature" prose) since it's a
  security-relevant default — the same list Phase 12 M4 will consume for its
  write-safety check once that milestone resumes.

## A deliberate, honest limitation

An imported project has no mission defined yet. `saveProject()` writes only
`{driver: "claude", workingDirectory}` — there is no existing precedent in
this codebase for "register a project with no mission" (every creation path,
including the CLI's `projects add`, has always required a `promptFile` or
task plan). So a freshly-imported project correctly shows as `misconfigured`
("promptFile" is required) until the owner adds one by hand-editing
`config/projects/<name>.json`. This was a real design question during
implementation — the plan's `/import <path> [name]` bracket notation implied
an optional name, while one of its own sentences said "requires an explicit
name"; resolved in favor of the more ergonomic optional-name reading, with
`as <name>` added for the explicit case, since the plan's intent (`/scan`'s
output should map 1:1 onto `/import <path>`) pointed that way.

---

## Verification

- **1023/1023 backend tests** (was 992; +31: a new `projectDiscovery.test.js`
  covering the algorithm directly — self-exclusion, nested-repo boundaries,
  duplicate basenames, custom marker/ignore/depth configuration — plus
  `/scan`/`/import` integration tests against a real throwaway installation
  in `commandRouter.test.js`, `getRawProject` tests in `configManager.test.js`,
  render tests in `operatorRender.test.js`, and one existing
  `projectRegistry.test.js` assertion updated for the new `missing` status).
- **Live validation against the real installation** (not a throwaway temp
  dir): loaded the real `ConfigManager`, read the real 6 registered
  projects' raw `workingDirectory` values, and ran `scanRoots()` against the
  real, now-configured `C:\Users\Admin\Music`. Result: all 6 registered
  projects excluded correctly (including case-insensitive matching —
  `"THE FINISHER"`'s registered path `C:\Users\Admin\Music\The Finisher`
  matched despite the case difference), AI-Orchestrator's own checkout never
  appeared, and **17 real, genuinely unregistered project folders** were
  found. `/import` itself was validated through the isolated test harness
  only — deliberately not exercised against the real registry, since doing
  so would leave an uninvited persistent file in the owner's real
  `config/projects/` directory.

---

## What's next

Phase 13 M3 — Project Lifecycle & Registry Operations (`v3.3.0`). See
[PHASE_13_PLAN.md](PHASE_13_PLAN.md).
