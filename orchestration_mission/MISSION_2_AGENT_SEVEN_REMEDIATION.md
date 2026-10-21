# MISSION 2 — AGENT SEVEN REMEDIATION DECISION
**Author:** Agent Seven — Remediation & Decision Authority  
**Mission:** Mission 2 — Platform Hardening, Permanent Nine-Agent Architecture, Intelligent Model Routing  
**Date:** 2026-10-21  
**Status:** ALL DECISIONS RECORDED & EXECUTED  

---

## 1. Executive Summary

Agent Seven has reviewed the adversarial findings presented by Agent Six (`MISSION_2_AGENT_SIX_ADVERSARIAL_REVIEW.md`). Under the authority delegated to the engineering leadership team and validated by Agent Nine, the following binding remediation decisions have been rendered and executed.

---

## 2. Remediation Decisions

### Decision REM-01: Remove `shell: true` and Normalize Parameter Ordering in `AgyDriver`
* **Target Finding:** ADV-01 (Windows CLI Spawning and Argument Escaping)
* **Decision:** **ACCEPT & IMPLEMENT IMMEDIATELY**
* **Rationale:**
  `agy.exe` is a native Windows PE binary. Invoking it via `shell: true` in Node.js routes execution through `cmd.exe /d /s /c`. On Windows, `cmd.exe` does not support multi-line arguments and will misinterpret quotes, pipes, and control characters inside code prompts. Placing flags before `-p` and setting `shell: false` passes arguments verbatim via the Win32 `CreateProcessW` API, completely eliminating command injection risks and argument corruption.
* **Execution Record:**
  - Modified `src/drivers/agyDriver.js`:
    - Reordered CLI arguments: `--model`, `--mode`, `--effort`, `--dangerously-skip-permissions`, `--disable-slash-commands`, `-p`, `prompt`.
    - Set `shell: false` on child process spawn options.
  - Verification: `test/agyDriver.test.js` passes 100%.

### Decision REM-02: Manage Remote MCP Discovery Latency
* **Target Finding:** ADV-02 (Remote MCP Discovery Latency)
* **Decision:** **ACCEPT & MITIGATE**
* **Rationale:**
  Headless batch CLI turns should not hang on unauthenticated remote MCP servers (e.g. remote Clickhouse or Gitlab Orbit). Adding `--disable-slash-commands` eliminates extraneous skill expansion overhead during automated non-interactive runs. In addition, unauthenticated remote endpoints were disabled in the local CLI profile.

### Decision REM-03: Preserve Secret Hygiene
* **Target Finding:** ADV-03 (Secret Hygiene Verification)
* **Decision:** **MAINTAIN AS INVARIANT**
* **Rationale:**
  Zero credentials, API tokens, or bot passwords may ever be staged, committed to version control, or exposed in public reports. `config/local.json` remains strictly untracked.

### Decision REM-04: Circuit Breaker Error Surface
* **Target Finding:** ADV-04 (Circuit Breaker Fallback Exhaustion)
* **Decision:** **ACCEPT & HARDEN**
* **Rationale:**
  When all secondary providers are unhealthy or exhausted, `ModelRouter` throws a descriptive error informing the operator that all configured fallback providers have tripped their circuit breakers, preventing silent failure.

### Decision REM-05: Maintain Independent Verification Model Separation
* **Target Finding:** ADV-05 (Verification Independence Invariant)
* **Decision:** **MAINTAIN AS MANDATORY ARCHITECTURAL PRINCIPLE**
* **Rationale:**
  Self-grading by the same AI model instance leads to correlated blind spots. Agent Four and Agent Eight are permanently bound to independent verification models.

---

## 3. Decision Matrix

| Finding ID | Title | Decision | Execution Status |
|---|---|---|---|
| ADV-01 | Remove `shell: true` from `AgyDriver` | ACCEPT | **EXECUTED & VERIFIED** |
| ADV-02 | Add `--disable-slash-commands` to `AgyDriver` | ACCEPT | **EXECUTED & VERIFIED** |
| ADV-03 | Secret Hygiene Invariant | MAINTAIN | **VERIFIED CLEAN** |
| ADV-04 | Circuit Breaker Exhaustion Hardening | ACCEPT | **EXECUTED & VERIFIED** |
| ADV-05 | Verification Model Separation | MAINTAIN | **VERIFIED ENFORCED** |
