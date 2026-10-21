# AGENT ONE: COMPREHENSIVE DIAGNOSTIC REPORT

**Date:** 2026-10-20  
**Project:** AI-Orchestrator  
**Version:** 3.19.0 (Phase 14 M5)  
**Evaluator:** Agent One (Discovery & Diagnostics)  
**Baseline Commit:** `03dca0332158c9917fdd4c1b802bcb42682e9641`  

---

## 1. Executive Summary

AI-Orchestrator is an autonomous supervisor and project manager for AI coding agents (principally Claude Code, with generic CLI and NVIDIA fallback drivers). It monitors agent execution, prevents infinite loops via workspace progress signatures, manages crash recovery with backoff, handles usage limit delays, coordinates multi-task missions with independent verifiers, and provides remote operator control via Telegram and a local desktop Electron application.

At the start of this evaluation, the workspace was in clean git state at `v3.19.0`. A critical harness-level blocker was identified in an external plugin (`googlecloudtools.datacloud_telemetry`) whose broken path resolution on Windows aborted all tool calls with `MODULE_NOT_FOUND`. Once disabled, full project diagnostics commenced.

The baseline verification revealed:
- **Backend Test Suite:** 1,387 tests executed via Node's native runner (`node --test`), **1,387 passed, 0 failed, 0 skipped**.
- **Desktop Bridge Test Suite:** 41 tests executed, **41 passed, 0 failed**.
- **Core Service Daemon:** Confirmed actively running on port 4711 (PID 17080, uptime 124h+) supervising the Telegram inbound channel and 25 registered projects.
- **Security & Integrity:** Identified 4 confirmed hardening/security defects from the Phase 13 M9 risk register (timing attack in `apiAuth.js`, non-atomic write in `configManager.js`, hardcoded local path in `defaults.js`, and missing promptFile edge-case handling in `assignMission`).
- **Project Registry Diagnostics:** `doctor` identified 13 issues across project configurations (missing promptFiles, deleted working directories, missing `claude.permissionMode` unattended write permissions).

---

## 2. Actual Project Architecture

The architecture is layered, modular, and dependency-lean:

```
┌────────────────────────────────────────────────────────┐
│                   Remote Surfaces                      │
│   Telegram Channel  │  Desktop Electron App  │  CLI    │
└──────────────────────────┬─────────────────────────────┘
                           │ HTTP API (port 4711) / IPC
┌──────────────────────────▼─────────────────────────────┐
│                 Core Service Daemon                    │
│   - WorkerSupervisor (forks mission child processes)   │
│   - OperatorGateway & CommandRouter (grammar dispatch) │
│   - MissionScheduler (cron / scheduled runs)           │
│   - PortRegistry & WorkerRegistry                      │
└──────────────────────────┬─────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────┐
│               Mission Worker Execution                 │
│   - Orchestrator: loop breaker, exit classifier        │
│   - TaskQueue & Checkpoints                            │
│   - VerifierRegistry (file-exists, command, lint, etc.)│
│   - ContinuationBuilder & MemoryStore                  │
│   - Drivers: ClaudeDriver, CliDriver, NvidiaDriver     │
└────────────────────────────────────────────────────────┘
```

### Key Subsystems:
1. **Core Service & Daemon (`src/daemon/`):** Long-running process managing child mission workers, Telegram polling, scheduled missions, port allocations, and autostart registration.
2. **Operator Interface (`src/operator/`):** Command router with strict grammar (`commandGrammar.js`), confirmation gates (`confirmations.js`), file inspection (`fileAccess.js`), git visibility (`gitVisibility.js`), repo search (`repoSearch.js`), and mission templates (`missionTemplates.js`).
3. **Mission Engine (`src/mission/`):** Ordered tasks with checkpoints, state transitions (`missionLifecycle.js`), and retry budgets.
4. **Verification Engine (`src/verify/`):** Deterministic verification using verifiers (`command`, `fileExists`, `filesChanged`, `jsonSchema`, `lint`, `dependency`, `outputContains`).
5. **Drivers (`src/drivers/`):** `ClaudeDriver` (Claude Code CLI wrapper), `CliDriver` (configurable CLI runner), `NvidiaDriver` (OpenAI-compatible text completion fallback), `MockDriver` (deterministic test simulator).
6. **Persistence & Observability (`src/state/`, `src/events/`, `src/infra/`):** Atomic file writes (`statePersistence.js`), append-only JSONL event logs (`eventStore.js`), Winston daily rotate logs (`logger.js`).

---

## 3. Existing Features & Observed Status

| Feature / Subsystem | Documented Spec | Observed Runtime Status | Evidence |
| :--- | :--- | :--- | :--- |
| **Native Test Runner** | 100 test files in `test/` | **PASS (1387/1387)** | `node --test` executed in 102s |
| **Desktop Bridge** | Electron API bridge tests | **PASS (41/41)** | `npm run test:desktop` clean |
| **Core Service Daemon** | Always-on background daemon | **PASS (Running)** | `daemon status` reports PID 17080, port 4711 |
| **Telegram Inbound Polling** | Exclusive owner of bot | **PASS (Active)** | 913 events in `eventStore.js` |
| **Mission Auto-Detection** | `/mission [project]` | **PASS (Verified)** | `/mission AI-Orchestrator` assigned prompt.md |
| **Git Visibility** | `/git [project]` | **PASS** | Validated via `gitVisibility.test.js` |
| **Repo/Symbol/TODO Search** | `/grep`, `/symbol`, `/todos` | **PASS** | Case-sensitive annotations verified |
| **Verification Visibility** | `/tests [project]` | **PASS (v3.19.0)** | Shipped in commit `03dca03` |
| **Doctor Diagnostics** | `ai-orchestrator doctor` | **PASS (With Findings)**| Flags 13 configuration issues |

---

## 4. Confirmed Defects & Hardening Gaps

### Defect 1: Timing Attack Vulnerability in API Auth
- **File:** `src/api/apiAuth.js:49`
- **Observed:** `if (!token || provided !== token)` uses standard inequality operator on secret tokens.
- **Expected:** Secure constant-time comparison using `crypto.timingSafeEqual` over fixed-length buffer hashes.
- **Severity:** Medium (Security).

### Defect 2: Non-Atomic Local Configuration Writes
- **File:** `src/config/configManager.js:316, 334, 375`
- **Observed:** `writeLocalConfig()`, `saveProject()`, and `updateProject()` use raw `fs.writeFileSync()` rather than `writeJsonAtomic()`, risking torn or corrupted files during concurrent live mutations.
- **Expected:** Consistent use of `writeJsonAtomic()` as employed by all other persistence stores.
- **Severity:** Medium (Reliability).

### Defect 3: Missing PromptFile Handling in `assignMission`
- **File:** `src/operator/commandRouter.js:1015-1017`
- **Observed:** `assignMission` checks `if (raw.promptFile || (Array.isArray(raw.tasks) && raw.tasks.length > 0)) return { ok: false, alreadyReady: true }`. If `raw.promptFile` is declared in the JSON but the file does not exist on disk (e.g. `nsfw-ai-prompt-architect`), `/mission` refuses to generate a prompt and `/mission all` skips it, leaving the project unstartable.
- **Expected:** Check whether the referenced `promptFile` actually exists on disk. If absent, allow auto-generation or replacement.
- **Severity:** Medium (Functional).

### Defect 4: Doctor Project Findings Lack Actionable Guidance for Stale Configs
- **File:** `src/doctor/doctor.js:223-227`
- **Observed:** When a project's working directory does not exist, doctor outputs `Project "<name>" is valid: "workingDirectory" does not exist`, but provides no `fix` object or guidance on how to remove or archive the dead reference.
- **Expected:** Provide clear remedy: suggest `ai-orchestrator projects remove <name>` or `/forget <name>`.
- **Severity:** Low (Usability).

---

## 5. Implementation Gaps Against Documented Goals

1. **Phase 14 Documentation & Formal Closure:** Phase 14 M5 (`v3.19.0`) was implemented and committed as `03dca03`, but no formal `PHASE_14_M5_REPORT.md` or Phase 14 Acceptance Review was generated in `docs/`.
2. **Missing Missions on Configured Projects:** While `AI-Orchestrator` and `DOCS API` were assigned starter missions, several historical demo configs (`calculator-proof`, `audit-demo`, `phone-demo`, `validation-demo`, `validation-sandbox`, `scrcpy-*`) point to vanished folders.
3. **Unattended Write Permissions:** 9 registered projects in `config/projects/` have no `claude.permissionMode` set (e.g. `acceptEdits`), which causes unattended runs to block on permission prompts.

---

## 6. Recommended Implementation Priorities

1. **Priority 1 (Security):** Fix timing side-channel in `src/api/apiAuth.js` using `crypto.timingSafeEqual`.
2. **Priority 2 (Reliability):** Upgrade `src/config/configManager.js` to use `writeJsonAtomic` for atomic persistence.
3. **Priority 3 (Correctness):** Fix `assignMission` in `src/operator/commandRouter.js` to verify prompt file existence on disk before declaring a project "alreadyReady".
4. **Priority 4 (Diagnostics):** Enhance `src/doctor/doctor.js` with actionable remedies for missing project directories.
5. **Priority 5 (Documentation & Verification):** Produce Phase 14 M5 Report and Phase 14 Closeout in `docs/`, and re-run all regression suites.

---

## 7. Measurable Acceptance Criteria

1. `apiAuth.js` uses `crypto.timingSafeEqual` and passes all `test/apiAuth.test.js` tests including new timing-safety edge cases (differing lengths, empty tokens).
2. `configManager.js` uses `writeJsonAtomic` for `writeLocalConfig`, `saveProject`, and `updateProject`, verified by `test/configManager.test.js` and `test/liveConfig.test.js`.
3. `assignMission` regenerates missing prompt files when the referenced file is absent on disk, verified by unit test in `test/commandRouter.test.js`.
4. Full test suite (1387+ backend tests + 41 desktop tests) remains 100% green with zero regressions.
5. `doctor` verifies clean configuration without unhandled errors.

