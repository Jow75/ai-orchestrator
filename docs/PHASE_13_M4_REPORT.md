# Phase 13 M4 — Live Configuration Layer

**Version:** `v3.4.0`
**Date:** 2026-07-29
**Plan:** [PHASE_13_PLAN.md](PHASE_13_PLAN.md)
**Predecessor:** [M3 — Project Lifecycle & Registry Operations](PHASE_13_M3_REPORT.md)

The first mechanism for the daemon to accept a config change without a
restart — the shared primitive M5's `/model`/`/provider` will build on next.

---

## What shipped

- **`src/config/liveConfig.js`**, `LiveConfigLayer`. `LIVE_MUTABLE_PATHS` is
  a closed allowlist (`operator.projectRoots`, `operator.defaultModel`,
  `operator.defaultProvider`, `notifications.minSeverity`,
  `approvals.mode`) — deliberately not "anything in config," which would
  silently turn restart-only settings into ones that look live but aren't.
  `applyPatch()` writes to disk first (`ConfigManager.writeLocalConfig()`,
  previously only ever called by one-shot setup wizards), then mutates the
  exact same in-memory object every subsystem already holds by reference —
  matching `daemon.js`'s existing `this.config = this.configManager.getAll()`
  pattern exactly.
- **`/roots`, `/roots add <path>`, `/roots remove <path>`** — not
  destructive: `ConfigManager.getProject()` never consults
  `operator.projectRoots` at all, so removing a root only ever affects
  `/scan`'s discovery, stated plainly in the reply when a registered project
  happens to live under the root being removed. New
  `operator.liveConfig.enabled` kill switch.
- New event type `config.changed` (logs the key changed, never the value).

## A real bug found while building this — not a hypothetical

Nothing before `LiveConfigLayer` ever mutated a merged config object in
place; every existing caller either read it or created a brand-new merged
object. That let a real bug in `ConfigManager.deepMerge()` sit latent: it
did `result = {...target}`, a **shallow** spread — so any branch the
`source` override never touched stayed the exact same object reference as
the one inside `target`. Since `ConfigManager.load()` calls
`deepMerge(ORCHESTRATOR_DEFAULTS, overrides)`, a section of config nothing
in `orchestrator.json`/`local.json` overrides — `operator`, on a machine
with no explicit override for it, which is every machine today — was
literally the shared, module-level `ORCHESTRATOR_DEFAULTS.operator` object.

The first test that exercised in-place mutation across two independently-
loaded `ConfigManager` instances caught it immediately: a mutation applied
through one instance leaked into the other, because they were quietly
sharing the same nested object. Fixed at the root — `deepMerge()` now
deep-clones every nested object *and array* from `target` (arrays needed
the same fix; `cloneDeep`'s first pass left them shared too, which the
regression test also caught) — rather than patched around in
`LiveConfigLayer`, so any future code that mutates a config object in place
is safe by construction, not by remembering a landmine exists.

---

## Verification

- **1074/1074 backend tests** (was 1057; +17: new `liveConfig.test.js`
  covering allowlist enforcement, all-or-nothing patching, in-place
  mutation of the shared reference, and restart survival; two new
  regression tests in `configManager.test.js` for the `deepMerge` bug
  itself (object AND array independence, plus a cross-`ConfigManager`-
  instance corruption test); `/roots` integration tests in
  `commandRouter.test.js`, including one that adds a real filesystem root
  and confirms `/scan` sees it on the very next command with no restart).
- **No live daemon restart against the real installation** — consistent
  with M2/M3's scoping: the mechanism is exercised end-to-end through the
  real `ConfigManager`/`LiveConfigLayer`/`CommandRouter` classes (not
  mocks), but never against the owner's actual `config/local.json` without
  their request. Confirmed `daemon.js` imports and wires `LiveConfigLayer`
  cleanly against the real installation (read-only), and confirmed the real
  `operator.projectRoots` value loads correctly.

---

## What's next

Phase 13 M5 — Provider Architecture Completion & Remote Model/Provider
Management (`v3.5.0`), which depends directly on this milestone's
`applyPatch()` for `/model`/`/provider`. See
[PHASE_13_PLAN.md](PHASE_13_PLAN.md).
