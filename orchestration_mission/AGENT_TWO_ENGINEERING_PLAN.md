# AGENT TWO: PRIORITIZED ENGINEERING IMPLEMENTATION PLAN

**Date:** 2026-10-20  
**Planner:** Agent Two (Implementation Planning & Engineering Design)  
**Input:** `orchestration_mission/AGENT_ONE_DIAGNOSTIC_REPORT.md`  
**Target:** AI-Orchestrator v3.19.0+ Hardening & Reliability Release  

---

## 1. Plan Overview & Engineering Philosophy

This engineering plan translates the findings of Agent One into targeted, verified code improvements. Every proposed change adheres to the project's load-bearing invariants:
- **Zero regressions:** The existing 1,387 backend tests and 41 desktop tests must remain 100% passing.
- **Fail-safe security:** Constant-time token comparisons prevent timing side-channels without altering the HTTP contract.
- **Durable persistence:** ConfigManager writes will utilize the project's standard `writeJsonAtomic` mechanism to guarantee atomic writes.
- **Resilient operator experience:** `/mission` will detect and heal broken or missing prompt files on disk rather than getting stuck in a false "already has a mission" state.
- **Clear remediation in diagnostics:** Doctor will provide clear, actionable instructions when working directories have vanished.

---

## 2. Prioritized Task Specifications

### Task 1: [SEC-1] Constant-Time Comparison in API Auth
- **Priority:** High (Security)
- **Component:** `src/api/apiAuth.js`, `test/apiAuth.test.js`
- **Problem:** `src/api/apiAuth.js:49` uses `provided !== token`. In standard JavaScript engines, string inequality checks return early on the first differing character, leaking information about token prefix matches via execution time.
- **Proposed Solution:**
  Implement a constant-time comparison helper `safeCompare(a, b)`:
  ```javascript
  function safeCompare(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const hashA = crypto.createHash('sha256').update(a).digest();
    const hashB = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(hashA, hashB);
  }
  ```
  Comparing fixed-length SHA-256 digests via `crypto.timingSafeEqual` prevents both timing leaks and buffer-length mismatch exceptions.
- **Acceptance Criteria:**
  - `requireAuth(token)` rejects invalid tokens without timing side-channels.
  - Matches valid tokens via Bearer and X-API-Token headers.
  - Handles undefined, null, non-string, differing lengths, and empty strings gracefully without throwing unhandled exceptions.
  - Passes all tests in `test/apiAuth.test.js` with new timing-safety edge cases.

---

### Task 2: [REL-1] Atomic Persistence in ConfigManager
- **Priority:** High (Reliability)
- **Component:** `src/config/configManager.js`
- **Problem:** `writeLocalConfig()`, `saveProject()`, and `updateProject()` use direct `fs.writeFileSync()`. If a crash, power outage, or concurrent mutation occurs mid-write, the target JSON file can be truncated or corrupted.
- **Proposed Solution:**
  Import `writeJsonAtomic` from `../state/statePersistence.js` and replace `fs.writeFileSync()` calls in `writeLocalConfig`, `saveProject`, and `updateProject` with `writeJsonAtomic()`.
- **Acceptance Criteria:**
  - `writeLocalConfig()`, `saveProject()`, and `updateProject()` perform atomic writes via temp file and rename.
  - All existing configuration and live-config tests in `test/configManager.test.js` and `test/liveConfig.test.js` pass cleanly.

---

### Task 3: [OPS-1] Heal Missing Prompt Files in `assignMission`
- **Priority:** Medium (Functional Correctness)
- **Component:** `src/operator/commandRouter.js`, `test/commandRouter.test.js`
- **Problem:** If a project config declares `promptFile: "prompt.md"` but the file on disk was deleted or never created (e.g. `nsfw-ai-prompt-architect`), `assignMission` currently returns `alreadyReady: true` ("already has a mission"), while `ConfigManager.validateProject()` throws `"promptFile" not found`. This leaves the project in an un-startable deadlock that the operator cannot heal with `/mission` or `/mission all`.
- **Proposed Solution:**
  In `assignMission(name, ctx, { via })`:
  Verify whether the declared `promptFile` exists on disk before declaring the project "alreadyReady":
  ```javascript
  const promptPath = raw.promptFile
    ? (path.isAbsolute(raw.promptFile) ? raw.promptFile : path.join(workingDirectory ?? '', raw.promptFile))
    : null;
  const promptExists = promptPath && fs.existsSync(promptPath);
  const hasTasks = Array.isArray(raw.tasks) && raw.tasks.length > 0;
  if ((raw.promptFile && promptExists) || hasTasks) {
    return { ok: false, alreadyReady: true, reason: 'already has a mission (a promptFile or task plan is set)' };
  }
  ```
  Update `commandMissionAll` candidate filter similarly so that projects with missing prompt files are included as candidates.
- **Acceptance Criteria:**
  - If `promptFile` is declared but absent on disk, `/mission <name>` writes a new prompt file and updates the stack metadata.
  - If a valid prompt file exists on disk, `/mission <name>` preserves it and refuses to overwrite.
  - Unit tests in `test/commandRouter.test.js` cover both scenarios.

---

### Task 4: [DIAG-1] Actionable Doctor Guidance for Vanished Project Folders
- **Priority:** Low (Usability)
- **Component:** `src/doctor/doctor.js`, `test/doctor.test.js`
- **Problem:** When a project's `workingDirectory` no longer exists, `doctor` returns a failure without an actionable remedy or fix object.
- **Proposed Solution:**
  In `doctor.js`:
  Detect when the failure is due to a missing working directory and provide an actionable fix description advising the user to remove or archive the dead project config (`ai-orchestrator projects remove <name>` or `/forget <name>`).
- **Acceptance Criteria:**
  - Doctor findings for missing working directories include a clear remedy description.
  - `test/doctor.test.js` passes.

---

### Task 5: [DOC-1] Phase 14 M5 & Acceptance Documentation
- **Priority:** Medium (Documentation)
- **Component:** `docs/PHASE_14_M5_REPORT.md`
- **Problem:** Phase 14 M5 was committed (`v3.19.0`) but lacks the standard milestone report in `docs/` summarizing the `/tests` implementation and its live validation.
- **Proposed Solution:**
  Author `docs/PHASE_14_M5_REPORT.md` documenting the purpose, implementation details, test coverage, and live validation results for Phase 14 M5.

---

## 3. Implementation Order & Ownership

1. **Step 1:** Implement SEC-1 (`apiAuth.js` timing-safe token check + test extension).
2. **Step 2:** Implement REL-1 (`configManager.js` atomic persistence).
3. **Step 3:** Implement OPS-1 (`commandRouter.js` prompt file existence check + tests).
4. **Step 4:** Implement DIAG-1 (`doctor.js` actionable findings).
5. **Step 5:** Author DOC-1 (`docs/PHASE_14_M5_REPORT.md`).
6. **Step 6:** Execute full test suite (`node --test`, `npm run test:desktop`) to verify zero regressions.

