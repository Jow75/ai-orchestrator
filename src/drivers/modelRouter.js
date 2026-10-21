/**
 * modelRouter.js — Intelligent task-aware model routing and fallback.
 *
 * Implements Section 8 of Mission 2:
 * 1. Provider capability & health registry with circuit breakers.
 * 2. Task-aware model selection matching agent role and task type.
 * 3. Structured failure classification (transient vs persistent).
 * 4. Resilient multi-provider fallback chains with loop prevention.
 * 5. Independent verification model separation.
 */

import { DRIVER_CAPABILITIES } from './capabilities.js';
import { AGY_DEFAULT_MODEL } from './agyDriver.js';

export const FAILURE_CATEGORIES = Object.freeze({
  RATE_LIMIT: 'rate-limit',
  NETWORK: 'network',
  CAPACITY: 'capacity',
  AUTH: 'authentication',
  MODEL_NOT_FOUND: 'model-not-found',
  TOOL_INCOMPATIBLE: 'tool-incompatible',
  TIMEOUT: 'timeout',
  UNRECOVERABLE: 'unrecoverable',
});

const DEFAULT_CIRCUIT_THRESHOLD = 3;
const DEFAULT_CIRCUIT_COOLDOWN_MS = 60_000;

export class ModelRouter {
  /**
   * @param {object} [options]
   * @param {object} [options.logger]
   * @param {import('./driverRegistry.js').DriverRegistry} [options.driverRegistry]
   * @param {number} [options.circuitThreshold]
   * @param {number} [options.circuitCooldownMs]
   */
  constructor({
    logger,
    driverRegistry,
    circuitThreshold = DEFAULT_CIRCUIT_THRESHOLD,
    circuitCooldownMs = DEFAULT_CIRCUIT_COOLDOWN_MS,
  } = {}) {
    this.logger = logger;
    this.driverRegistry = driverRegistry;
    this.circuitThreshold = circuitThreshold;
    this.circuitCooldownMs = circuitCooldownMs;

    // Per-provider health tracking
    this.health = new Map();
    for (const id of Object.keys(DRIVER_CAPABILITIES)) {
      this.health.set(id, {
        status: 'healthy',
        consecutiveFailures: 0,
        lastFailure: null,
        lastFailureCategory: null,
        lastSuccess: null,
        circuitTrippedUntil: 0,
      });
    }
  }

  /**
   * Classify an error string or Error instance into a standardized failure category.
   * @param {Error|string} error
   * @returns {string} One of FAILURE_CATEGORIES
   */
  classifyFailure(error) {
    const msg = String(error?.message || error || '');
    if (/\b429\b|rate.?limit|quota exceeded|too many requests/i.test(msg)) {
      return FAILURE_CATEGORIES.RATE_LIMIT;
    }
    if (/ETIMEDOUT|ESOCKETTIMEDOUT|timeout/i.test(msg)) {
      return FAILURE_CATEGORIES.TIMEOUT;
    }
    if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|network error/i.test(msg)) {
      return FAILURE_CATEGORIES.NETWORK;
    }
    if (/503|capacity unavailable|overloaded|server error/i.test(msg)) {
      return FAILURE_CATEGORIES.CAPACITY;
    }
    if (/\b401\b|unauthorized|invalid api key|forbidden|\b403\b/i.test(msg)) {
      return FAILURE_CATEGORIES.AUTH;
    }
    if (/model not found|unknown model|invalid model/i.test(msg)) {
      return FAILURE_CATEGORIES.MODEL_NOT_FOUND;
    }
    if (/tool use not supported|unsupported tool/i.test(msg)) {
      return FAILURE_CATEGORIES.TOOL_INCOMPATIBLE;
    }
    return FAILURE_CATEGORIES.UNRECOVERABLE;
  }

  /**
   * Whether a failure category is transient and safely retryable.
   * @param {string} category
   * @returns {boolean}
   */
  isRetryable(category) {
    return (
      category === FAILURE_CATEGORIES.RATE_LIMIT
      || category === FAILURE_CATEGORIES.NETWORK
      || category === FAILURE_CATEGORIES.CAPACITY
      || category === FAILURE_CATEGORIES.TIMEOUT
    );
  }

  /**
   * Record a successful execution for a provider.
   * Resets failure counters and clears circuit breakers.
   */
  recordSuccess(driverId) {
    const state = this.health.get(driverId);
    if (!state) return;
    state.status = 'healthy';
    state.consecutiveFailures = 0;
    state.lastSuccess = new Date().toISOString();
    state.circuitTrippedUntil = 0;
  }

  /**
   * Record a failure for a provider.
   * Tripping circuit breaker when consecutive failures reach threshold.
   */
  recordFailure(driverId, error) {
    const state = this.health.get(driverId);
    if (!state) return;
    const category = this.classifyFailure(error);
    state.consecutiveFailures += 1;
    state.lastFailure = new Date().toISOString();
    state.lastFailureCategory = category;

    if (state.consecutiveFailures >= this.circuitThreshold) {
      state.status = 'degraded';
      state.circuitTrippedUntil = Date.now() + this.circuitCooldownMs;
      this.logger?.warn?.(`Circuit breaker tripped for driver "${driverId}"`, {
        consecutiveFailures: state.consecutiveFailures,
        category,
      });
    }
  }

  /**
   * Check if a driver is available and not in a tripped circuit state.
   */
  isDriverHealthy(driverId) {
    const state = this.health.get(driverId);
    if (!state) return false;
    if (state.circuitTrippedUntil > 0 && Date.now() < state.circuitTrippedUntil) {
      return false;
    }
    return true;
  }

  /**
   * Task-aware routing: select optimal driver and model for an agent role and task requirements.
   *
   * @param {object} params
   * @param {string} [params.role] - Agent role (e.g. 'diagnostic', 'architecture', 'implementation')
   * @param {object} [params.task] - Task object with { capabilities, requiresTools, independentReview }
   * @param {string} [params.implementationDriver] - If task is a verification task, driver that wrote the code
   * @returns {{ driverId: string, model: string, reason: string }}
   */
  routeTask({ role, task = {}, implementationDriver = null } = {}) {
    const requiresTools = task.requiresTools !== false;

    // Independent verification invariant (Section 8.4):
    // Verification should prefer a different driver than the one that implemented the change
    if ((role === 'verification' || task.independentReview) && implementationDriver) {
      if (implementationDriver === 'agy' && this.isDriverHealthy('claude')) {
        return { driverId: 'claude', model: 'sonnet', reason: 'independent-verification-alternative-to-agy' };
      }
      if (implementationDriver === 'claude' && this.isDriverHealthy('agy')) {
        return { driverId: 'agy', model: AGY_DEFAULT_MODEL, reason: 'independent-verification-alternative-to-claude' };
      }
    }

    // Role-specific routing policies:
    // 1. Diagnostic / Planning / Routing / Authorization -> High-reasoning Gemini 3.8 Flash High
    if (['diagnostic', 'architecture', 'provider-routing', 'remediation', 'authorization'].includes(role)) {
      if (this.isDriverHealthy('agy')) {
        return { driverId: 'agy', model: AGY_DEFAULT_MODEL, reason: `preferred-reasoning-for-${role}` };
      }
      if (this.isDriverHealthy('claude')) {
        return { driverId: 'claude', model: 'sonnet', reason: `fallback-reasoning-for-${role}` };
      }
    }

    // 2. Implementation -> Tool-capable model (Gemini 3.8 Flash High or Claude Code)
    if (role === 'implementation' || role === 'coding') {
      if (this.isDriverHealthy('agy')) {
        return { driverId: 'agy', model: AGY_DEFAULT_MODEL, reason: 'primary-implementation-driver' };
      }
      if (this.isDriverHealthy('claude')) {
        return { driverId: 'claude', model: 'sonnet', reason: 'fallback-implementation-driver' };
      }
    }

    // 3. Adversarial / Failure Investigation -> Claude Opus or Nemotron (read-only)
    if (role === 'adversarial' || role === 'review') {
      if (this.isDriverHealthy('agy')) {
        return { driverId: 'agy', model: 'claude-opus-4-6-thinking', reason: 'deep-adversarial-analysis' };
      }
      if (!requiresTools && this.isDriverHealthy('nvidia')) {
        return { driverId: 'nvidia', model: 'nvidia/nemotron-3-ultra-550b-a55b', reason: 'independent-adversarial-nim' };
      }
    }

    // Default priority chain: agy -> claude -> nvidia (if no tools needed)
    if (this.isDriverHealthy('agy')) {
      return { driverId: 'agy', model: AGY_DEFAULT_MODEL, reason: 'default-primary-driver' };
    }
    if (this.isDriverHealthy('claude')) {
      return { driverId: 'claude', model: 'sonnet', reason: 'default-secondary-driver' };
    }
    if (!requiresTools && this.isDriverHealthy('nvidia')) {
      return { driverId: 'nvidia', model: 'nvidia/nemotron-3-ultra-550b-a55b', reason: 'read-only-fallback-nim' };
    }

    // Everything tripped or unavailable — return agy with degraded reason
    return { driverId: 'agy', model: AGY_DEFAULT_MODEL, reason: 'all-circuit-breakers-tripped-last-resort' };
  }

  /**
   * Determine the next fallback driver and model when a primary driver fails.
   * Avoids infinite fallback loops by tracking previously visited drivers.
   *
   * @param {string} failedDriverId
   * @param {object} [options]
   * @param {Set<string>} [options.visited] - Set of driver IDs already tried
   * @param {boolean} [options.requiresTools] - Whether workspace/tool access is required
   * @returns {{ driverId: string, model: string, reason: string } | null}
   */
  getFallback(failedDriverId, { visited = new Set(), requiresTools = true } = {}) {
    visited.add(failedDriverId);

    // Candidates in priority order
    const candidateChain = requiresTools
      ? ['agy', 'claude']
      : ['agy', 'claude', 'nvidia'];

    for (const candidate of candidateChain) {
      if (!visited.has(candidate) && this.isDriverHealthy(candidate)) {
        const model = candidate === 'agy'
          ? AGY_DEFAULT_MODEL
          : (candidate === 'claude' ? 'sonnet' : 'nvidia/nemotron-3-ultra-550b-a55b');
        return {
          driverId: candidate,
          model,
          reason: `fallback-from-${failedDriverId}`,
        };
      }
    }

    return null; // No remaining untried healthy fallbacks
  }

  /**
   * Return structured health matrix for reporting and diagnostics.
   */
  getAvailabilityMatrix() {
    const report = [];
    for (const [id, state] of this.health.entries()) {
      const caps = DRIVER_CAPABILITIES[id] || {};
      report.push({
        driverId: id,
        label: caps.label || id,
        status: state.status,
        models: caps.models || [],
        consecutiveFailures: state.consecutiveFailures,
        lastFailure: state.lastFailure,
        lastFailureCategory: state.lastFailureCategory,
        lastSuccess: state.lastSuccess,
        toolUse: caps.toolUse,
        streaming: caps.streaming,
      });
    }
    return report;
  }
}

export default ModelRouter;

