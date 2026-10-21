# MISSION 2 — AGENT TWO: CHIEF ARCHITECT & ENGINEERING PLAN

**Date:** 2026-10-21  
**Lead:** Agent Two (Chief Architect and Engineering Planner)  
**Input:** `orchestration_mission/MISSION_2_AGENT_ONE_DIAGNOSTIC.md`  
**Reviewers:** Agent One, Agent Three, Agent Four, Agent Five, Agent Six, Agent Eight, Agent Nine  

---

## 1. Architectural Strategy & Mission Objectives

The purpose of Mission 2 is to transform AI-Orchestrator into a permanent, multi-model, nine-agent autonomous engineering platform. We build directly upon the existing, modular architecture (`AIDriver`, `AgentRegistry`, `AgentRouter`, `AgentMessageBus`, `ConfigManager`), preserving 100% backward compatibility while making the nine agents and intelligent model routing permanent, durable, and verifiable.

---

## 2. Work Breakdown Structure (WBS)

### Workstream 1: Permanent Nine-Agent Architecture (M2)
- **Component 1.1 (`src/agents/agentProfile.js`):**
  - Add the 9 canonical roles to `ROLES`:
    `'diagnostic'`, `'architecture'`, `'implementation'`, `'verification'`, `'provider-routing'`, `'adversarial'`, `'remediation'`, `'auditor'`, `'authorization'`.
  - Export `CANONICAL_ROLES` and `CANONICAL_NINE_AGENTS` definition catalog with explicit responsibilities, capabilities, and default driver bindings.
  - Preserve `name` and `responsibilities` attributes on normalized agent objects in `validateAgentProfile`.
- **Component 1.2 (`config/agents.json`):**
  - Create the canonical global agents definition file `config/agents.json` on disk, configuring all 9 canonical agents with explicit roles, drivers, and capabilities.
- **Component 1.3 (`src/agents/agentRegistry.js`):**
  - Add helper methods `canonicalAgents()`, `getCanonicalAgent(idOrRole)`, and `ensureCanonicalAgents(filePath)`.
- **Component 1.4 Tests:**
  - Create `test/canonicalAgents.test.js` validating all 9 agents, their roles, responsibilities, round-trip loading, and persistence.

### Workstream 2: Antigravity CLI Driver & Model Capabilities (M3)
- **Component 2.1 (`src/drivers/agyDriver.js`):**
  - Implement `AgyDriver` extending `AIDriver` and `AgyRun` extending `AgentRun`.
  - Invokes `C:\Users\Admin\.gemini\bin\agy.exe` with `-p`, `--model <id>`, `--mode accept-edits`, `--dangerously-skip-permissions`.
  - Full output streaming and exit classification.
- **Component 2.2 (`src/drivers/capabilities.js`):**
  - Register `agy` in `DRIVER_CAPABILITIES` with verified models:
    `gemini-3.8-flash-high`, `gemini-3.8-flash-medium`, `gemini-3.8-flash-low`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`.
- **Component 2.3 (`src/drivers/driverRegistry.js` & `src/drivers/nvidiaDriver.js`):**
  - Register `agy: AgyDriver` in `BUILTIN_DRIVERS`.
  - Fix `nvidiaDriver.js` fallback to safely read `config/local.json` if `nvidiaConfigProvider` is unset, fixing the zero-arg construction bug.

### Workstream 3: Intelligent Model Router and Fallback (M3 & M4)
- **Component 3.1 (`src/drivers/modelRouter.js`):**
  - Create `ModelRouter` providing:
    - Provider capability and health registry.
    - Task-aware routing (`routeForRole(role, task)`): maps role to optimal model.
    - Automatic fallback chain: Primary (`gemini-3.8-flash-high`) -> Secondary (`claude/sonnet`) -> Fallback (`nvidia/nemotron-3-ultra-550b-a55b`).
    - Failure classification (`classifyFailure(error)`): rate-limit (429), timeout, network, auth (401), invalid model.
    - Bounded retries and circuit breaker.
- **Component 3.2 Tests:**
  - Create `test/modelRouter.test.js` and `test/agyDriver.test.js`.

### Workstream 4: Project Registry Review & Non-Destructive Remediation (M6)
- **Component 4.1 Audit:**
  - Table of all 25 registered projects.
  - Reversible action: leave files intact, document exact `/forget` or `projects remove` commands for the 7 nonexistent demo folders.
  - Heal `nsfw-ai-prompt-architect` missing prompt file.

### Workstream 5: Core Service & Telegram Verification (M7 & M8)
- **Component 5.1 Daemon Verification:**
  - Verify live HTTP health on port 4711.
  - Verify Telegram polling and command routing.
- **Component 5.2 Real Development Task:**
  - Execute real test task through the Orchestrator with real file output and verification.

### Workstream 6: Git Validation & Change Publication (M5)
- **Component 6.1 Clean Scoped Commit:**
  - Verify all tests pass (0 failures, 0 regressions).
  - Stage only verified files (never `config/local.json` or secrets).
  - Commit with descriptive message and check remote publication.

---

## 3. Explicit Acceptance Criteria

1. **AC-1 (Canonical Nine Agents):**
   - `config/agents.json` defines all 9 canonical agents.
   - `AgentRegistry` successfully loads all 9 agents.
   - Each agent has non-empty `id`, `name`, `role`, `driver`, `capabilities`, `responsibilities`.
2. **AC-2 (Agy Driver & Gemini 3.8 Flash High):**
   - `AgyDriver` runs `gemini-3.8-flash-high` live.
   - Driver passes installation check when `agy.exe` is present.
3. **AC-3 (Model Router & Fallback):**
   - Task-aware routing selects `gemini-3.8-flash-high` for diagnostic/planning/coding tasks.
   - Fallback correctly falls through when primary is simulated as down.
   - Rate limit (429) triggers backoff retry.
4. **AC-4 (NVIDIA Config Fallback):**
   - `NvidiaDriver` correctly loads API key from `config/local.json` even when constructed without an explicit provider.
5. **AC-5 (Zero Regressions):**
   - All 1,430 existing tests continue to pass (100% green).
   - New tests pass 100%.

Agent Two issues this plan to Agent Three for implementation.

