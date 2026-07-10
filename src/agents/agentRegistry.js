/**
 * agentRegistry.js — Phase 9: the roster of available agents.
 *
 * Loads agent definitions from `config/agents.json` (global) and merges in a
 * project's optional `agents` block, validating each via `agentProfile.js`.
 * Every agent references a driver id; the registry resolves that to a real
 * driver instance through the existing `DriverRegistry` — it wraps that
 * registry, it does not replace it.
 *
 * THE BACKWARD-COMPATIBILITY GUARANTEE lives here: a project with no agents
 * configured (the vast majority, and every pre-Phase-9 project) gets a
 * single *implicit* agent that simply wraps `project.driver`. Routed through
 * `agentRouter`, that implicit agent handles every task — so an agent-less
 * project behaves byte-for-byte as it did before Phase 9.
 */

import fs from 'node:fs';
import { deepMerge } from '../config/configManager.js';
import { validateAgentList } from './agentProfile.js';

/** The synthetic agent an agent-less project runs everything on. */
export function implicitDefaultAgent(project) {
  return {
    id: 'default',
    role: 'general',
    driver: project.driver,
    capabilities: [],
    config: {},
    enabled: true,
    implicit: true,
  };
}

export class AgentRegistry {
  /**
   * @param {object} options
   * @param {import('../drivers/driverRegistry.js').DriverRegistry} options.driverRegistry
   * @param {object} options.logger
   * @param {string} [options.agentsFile] - Path to global `config/agents.json`.
   *   Absent/nonexistent → no global agents (every project uses its implicit
   *   default unless it declares its own `agents`).
   */
  constructor({ driverRegistry, logger, agentsFile }) {
    this.driverRegistry = driverRegistry;
    this.logger = logger;
    this.agentsFile = agentsFile;
    this._globalAgents = null; // lazily loaded + cached
  }

  /** Whether a driver id is registered (used to validate agent.driver). */
  isKnownDriver(driverId) {
    return this.driverRegistry.listDrivers().includes(driverId);
  }

  /**
   * The global agent definitions from `config/agents.json`, validated and
   * cached. Returns [] when the file is absent or empty. A malformed file is
   * logged and treated as empty — a bad agents file must never take down
   * supervision (which can always fall back to the implicit default).
   */
  globalAgents() {
    if (this._globalAgents) return this._globalAgents;
    this._globalAgents = [];
    if (!this.agentsFile || !fs.existsSync(this.agentsFile)) return this._globalAgents;

    try {
      const raw = JSON.parse(fs.readFileSync(this.agentsFile, 'utf8'));
      const rawAgents = Array.isArray(raw) ? raw : raw.agents;
      const { agents, problems } = validateAgentList(rawAgents, {
        isKnownDriver: (d) => this.isKnownDriver(d),
      });
      if (problems.length) {
        this.logger.warn('Problems in agents config (offending agents skipped)', {
          file: this.agentsFile, problems,
        });
      }
      this._globalAgents = agents;
    } catch (error) {
      this.logger.warn('Could not read agents config (continuing without global agents)', {
        file: this.agentsFile, error: error.message,
      });
    }
    return this._globalAgents;
  }

  /**
   * The effective, enabled agent roster for a project: the project's own
   * `agents` (if it declares any) merged over the global agents by id, else
   * the global agents, else the single implicit default. Always non-empty.
   *
   * @param {object} project - Validated project config.
   * @returns {object[]}
   */
  agentsFor(project) {
    const byId = new Map(this.globalAgents().map((a) => [a.id, a]));

    if (Array.isArray(project.agents) && project.agents.length) {
      const { agents, problems } = validateAgentList(project.agents, {
        isKnownDriver: (d) => this.isKnownDriver(d),
      });
      if (problems.length) {
        this.logger.warn('Problems in project agents (offending agents skipped)', {
          project: project.name, problems,
        });
      }
      for (const agent of agents) byId.set(agent.id, agent); // project overrides global
    }

    const roster = [...byId.values()].filter((a) => a.enabled);
    return roster.length ? roster : [implicitDefaultAgent(project)];
  }

  /** One agent by id within a project's roster, or null. */
  getFor(project, id) {
    return this.agentsFor(project).find((a) => a.id === id) ?? null;
  }

  /** Every agent in a project's roster filling a given role. */
  byRoleFor(project, role) {
    return this.agentsFor(project).filter((a) => a.role === role);
  }

  /**
   * The project's default agent: an explicit agent whose id is `default` or
   * whose role is `general`, else the first in the roster, else the implicit
   * default. Used when a task names no agent/role.
   */
  defaultFor(project) {
    const roster = this.agentsFor(project);
    return (
      roster.find((a) => a.id === 'default')
      ?? roster.find((a) => a.role === 'general')
      ?? roster[0]
      ?? implicitDefaultAgent(project)
    );
  }

  /** The concrete driver instance backing an agent. */
  driverFor(agent) {
    return this.driverRegistry.getDriver(agent.driver);
  }

  /**
   * The project as the agent's driver should see it: the base project config
   * with the agent's own `config` block deep-merged over it. Lets an agent
   * override engine settings (e.g. a different `claude.model`, or the `cli`
   * command block) without a separate project. An implicit/empty-config
   * agent returns the project unchanged (byte-for-byte legacy behavior).
   */
  effectiveProject(project, agent) {
    if (!agent.config || !Object.keys(agent.config).length) return project;
    return deepMerge(project, agent.config);
  }
}

export default AgentRegistry;