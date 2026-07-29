# Phase 13 M5 — Provider Architecture Completion & Remote Model/Provider Management

**Version:** `v3.5.0`
**Date:** 2026-07-29
**Plan:** [PHASE_13_PLAN.md](PHASE_13_PLAN.md)
**Predecessor:** [M4 — Live Configuration Layer](PHASE_13_M4_REPORT.md)

Completes the provider/model layer and exposes it remotely — but most of
"provider architecture" turned out to already exist.

---

## What was already there (stated so scope stays honest)

`AIDriver`/`AgentRun` (`src/drivers/aiDriver.js`) is already an
`EventEmitter` — streaming already exists. `DriverRegistry.registerDriver()`
already lets a plugin add a new engine (Gemini, OpenAI, a local model) at
runtime with zero core changes. `CliDriver` already wraps any CLI-based
engine purely from per-project config. Execution and cancellation are
already covered by `AIDriver.launch()` and Phase 12 M1's worker stop-file +
escalation machinery. Planning is already the mission-planning/role-routing
layer's job. Authentication: every built-in driver authenticates via the
wrapped CLI's own ambient login — this milestone deliberately adds no
credential vault; a future driver that genuinely needs orchestrator-managed
secrets follows the pattern already proven for SMTP/Telegram (a field in
git-ignored `config/local.json`).

## What was actually missing, built here

- **`src/drivers/capabilities.js`** — `DRIVER_CAPABILITIES`, a plain data
  map. `cli`'s `toolUse: 'unknown'` is deliberate: a generic wrapper cannot
  introspect an arbitrary engine's real capabilities.
- **A machine-wide default model.** Threaded into `ClaudeDriver` via an
  optional `defaultModelProvider` closure, resolved once per launch inside
  `buildArgs()` — `project.claude.model || defaultModelProvider()`.
- **`/provider`** and **`/model [name|default]`**.

## The process-boundary argument for "never interrupts an active mission"

The owner's directive required that changing the model never interrupt a
running mission, and that new missions inherit the change. This didn't need
new logic — it falls out of an architectural fact Phase 12 M1 already
established: a mission runs inside a **worker process**, and a worker loads
its own `ConfigManager` once, at construction, and never reloads it (the
same pattern every other worker-side setting already follows — Phase 12's
own "files are the source of truth, IPC/memory is advisory" principle,
applied one level further). A `/model` change lands in the **daemon's**
live config immediately (M4), but an already-running worker's
`defaultModelProvider` closure reads that **worker's own**, separate,
unchanged snapshot — so its in-flight launch is untouched regardless of
what the daemon does. A brand-new worker (the next mission) constructs its
`ConfigManager` fresh, which reads `config/local.json` from disk — where
`/model` actually persisted the change — so it picks it up automatically.

---

## Verification

- **1100/1100 backend tests** (was 1074; +26): `buildArgs`/
  `defaultModelProvider` coverage in `claudeDriver.test.js` (including a
  test that the closure is read fresh on every call, so a value change
  between two launches affects only the second, never retroactively); new
  `driverRegistry.test.js` — previously untested at the unit level,
  covering both pre-existing behaviour (`listDrivers`, `getDriver` caching,
  `registerDriver`) and the new forwarding; new `capabilities.test.js`;
  `/provider`/`/model` integration tests in `commandRouter.test.js`.
- **Live validation against the real 6 project configs**: built the actual
  `--model` args `ClaudeDriver.buildArgs()` would produce for every real
  project, with and without a simulated machine-wide default (`opus`).
  Projects with no explicit model (`THE FINISHER`, `calculator-proof`,
  `example`, `validation-sandbox`) correctly inherited the simulated
  default; `phone-demo` and `validation-demo` (both explicitly configured
  to `haiku`) correctly ignored it in both cases. Read-only — no config was
  actually written.

---

## What's next

Phase 13 M6 — Remote File System (`v3.6.0`). See
[PHASE_13_PLAN.md](PHASE_13_PLAN.md).
