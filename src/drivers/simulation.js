/**
 * simulation.js — Phase 12 M2.1: which drivers only PRETEND to work.
 *
 * Born from a real incident (2026-07-28 live validation). A project configured
 * with `"driver": "mock"` was asked, from a phone, to "create a simple
 * calculator desktop application with React and Electron". The operator console
 * reported the mission complete, 1/1 tasks done, tests passed, verified — and
 * the workspace contained nothing but the README it started with.
 *
 * Nothing had malfunctioned. The mock driver replayed its scripted output
 * exactly as configured, and every layer above it faithfully reported what it
 * was told. The defect was that NO SURFACE EVER SAID THE WORK WAS SIMULATED.
 * An owner reading "Mission complete · Verified" on a phone has no way to know
 * the engine behind it was a fixture, and the only remedy on offer was to walk
 * to the machine and open a JSON file.
 *
 * So simulation stops being a private property of the driver layer and becomes
 * a fact the whole system carries and every surface must disclose. The rule
 * this module exists to enforce:
 *
 *     A simulated mission must never be indistinguishable from a real one.
 *
 * WHY A LIST RATHER THAN A DRIVER FLAG. Callers need the answer from a project
 * CONFIG (`{driver: 'mock'}`), long before any driver is instantiated — the
 * mission proposal is rendered before a run exists, and the project registry
 * describes projects that have never launched. A pure function over the driver
 * id answers all of them; drivers additionally expose `simulated` (see
 * AIDriver) so a plugin driver can declare itself without editing this file.
 */

/**
 * Built-in driver ids that do not perform real work.
 *
 * `cli` and `claude` are absent deliberately: both drive a real engine against
 * a real working directory. A `cli` driver pointed at a no-op command is a
 * misconfiguration, not a simulation, and this module must not paper over the
 * difference by guessing.
 */
export const SIMULATED_DRIVERS = Object.freeze(['mock']);

/**
 * Does this driver id only simulate work?
 *
 * @param {string} driverId - The `driver` field of a project config.
 * @returns {boolean}
 */
export function isSimulatedDriver(driverId) {
  return SIMULATED_DRIVERS.includes(String(driverId ?? '').toLowerCase());
}

/**
 * Does this PROJECT only simulate work?
 *
 * Accepts a project config (or any object carrying `driver`), so callers can
 * pass what they already hold. An explicit `simulated` field wins over the
 * driver id in both directions: it lets a plugin driver declare itself
 * simulated, and lets a future real driver named like a mock opt out.
 *
 * @param {{driver?: string, simulated?: boolean}|null} project
 * @returns {boolean}
 */
export function isSimulatedProject(project) {
  if (!project) return false;
  if (typeof project.simulated === 'boolean') return project.simulated;
  return isSimulatedDriver(project.driver);
}

/** The one-word badge every list and header uses. */
export const SIMULATION_BADGE = '🧪 SIMULATED';

/**
 * The full disclosure line, for any surface with room for a sentence.
 *
 * Phrased as a statement of consequence rather than a label, because the
 * consequence is the part the owner actually needs: not "this is a mock" but
 * "no files will be written". The incident above happened to someone who knew
 * perfectly well what a mock driver is.
 */
export const SIMULATION_NOTICE =
  'Simulated project — the engine is a scripted fixture. ' +
  'No code is written, no tests are run, and any result below is a rehearsal, not work.';

/** Past-tense form, for a mission that has already "finished". */
export const SIMULATION_NOTICE_PAST =
  'Simulated project — this mission was a rehearsal. ' +
  'The engine was a scripted fixture: no code was written and no tests were run.';

export default {
  SIMULATED_DRIVERS, isSimulatedDriver, isSimulatedProject,
  SIMULATION_BADGE, SIMULATION_NOTICE, SIMULATION_NOTICE_PAST,
};
