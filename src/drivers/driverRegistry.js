/**
 * driverRegistry.js — Driver registry and factory.
 *
 * Central lookup from driver id (the `driver` field of a project config) to
 * a driver instance. Adding support for a new AI engine is exactly:
 *
 *   1. Implement the AIDriver interface (see aiDriver.js).
 *   2. Register it below (or from a plugin via registerDriver()).
 *
 * Nothing else in the application changes.
 */

import { childLogger } from '../infra/logger.js';
import ClaudeDriver from './claudeDriver.js';
import MockDriver from './mockDriver.js';
import CliDriver from './cliDriver.js';

/** Built-in driver constructors, keyed by driver id. */
const BUILTIN_DRIVERS = {
  claude: ClaudeDriver,
  mock: MockDriver,
  // Phase 9: one generic, config-driven driver for any CLI engine (Gemini,
  // Codex, OpenCode, local LLMs) — configured per-agent, no class per engine.
  cli: CliDriver,
};

export class DriverRegistry {
  /**
   * @param {object} options
   * @param {object} options.logger - Root logger (children are derived per driver).
   * @param {() => string} [options.defaultModelProvider] - Phase 13 M5:
   *   forwarded to every driver instance this registry creates. Only
   *   `ClaudeDriver` currently reads it; passing it to drivers that don't
   *   (`mock`, `cli`) is harmless — their constructors simply ignore it.
   */
  constructor({ logger, defaultModelProvider }) {
    this.logger = logger;
    this.defaultModelProvider = defaultModelProvider;
    this.constructors = new Map(Object.entries(BUILTIN_DRIVERS));
    this.instances = new Map();
  }

  /**
   * Register an additional driver constructor (plugin extension point).
   *
   * @param {string} id - Driver id used in project configs.
   * @param {Function} DriverClass - Class implementing AIDriver.
   */
  registerDriver(id, DriverClass) {
    if (this.constructors.has(id)) {
      throw new Error(`Driver id "${id}" is already registered`);
    }
    this.constructors.set(id, DriverClass);
    this.logger.info('Driver registered', { driver: id });
  }

  /** All known driver ids. */
  listDrivers() {
    return [...this.constructors.keys()].sort();
  }

  /**
   * Get (lazily creating) the driver instance for an id.
   *
   * @param {string} id - Driver id.
   * @returns {import('./aiDriver.js').AIDriver}
   */
  getDriver(id) {
    if (this.instances.has(id)) return this.instances.get(id);

    const DriverClass = this.constructors.get(id);
    if (!DriverClass) {
      throw new Error(
        `Unknown driver "${id}". Known drivers: ${this.listDrivers().join(', ')}.`
      );
    }

    const instance = new DriverClass({
      logger: childLogger(this.logger, `${id}-driver`),
      defaultModelProvider: this.defaultModelProvider,
    });
    this.instances.set(id, instance);
    return instance;
  }
}

export default DriverRegistry;
