/**
 * projectLifecycleOps.js — Phase 13 M3: the operations behind /archive,
 * /restore, /hide, /unhide, /forget, and the classification migration.
 *
 * Pure functions the router calls, mirroring how commandRouter.js already
 * delegates non-trivial logic to render.js/missionRequests.js rather than
 * inlining it. Strictly split along the owner's registry-vs-filesystem
 * line: every function here mutates ONLY config/projects/<name>.json (via
 * ConfigManager). None of them ever touches a project's actual code on
 * disk — deleting real files is a deliberate non-goal this system does not
 * implement, on any path (see forget()).
 */

import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../infra/paths.js';
import { isSimulatedProject } from '../drivers/simulation.js';
import { DEFAULT_CLASSIFICATION } from '../config/projectClassification.js';

/** Mark a project archived: reversible, registry-only. */
export function archive(configManager, name) {
  return configManager.updateProject(name, { classification: 'archived' });
}

/** Return an archived or hidden project to the default classification. */
export function restore(configManager, name) {
  return configManager.updateProject(name, { classification: DEFAULT_CLASSIFICATION });
}

/** Hide a project from the default /projects listing. */
export function hide(configManager, name) {
  return configManager.updateProject(name, { classification: 'hidden' });
}

/** Return a hidden project to the default classification. */
export function unhide(configManager, name) {
  return configManager.updateProject(name, { classification: DEFAULT_CLASSIFICATION });
}

/**
 * Remove a project from the registry. Files on disk are NEVER touched —
 * that is a different, much more dangerous capability this system does
 * not build at all (see docs/PHASE_13_PLAN.md M3).
 */
export function forget(configManager, name) {
  configManager.deleteProject(name);
}

function realOrResolved(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** Best-effort, evidence-based classification guess for one raw project. */
function inferClassification(raw) {
  if (isSimulatedProject(raw)) {
    return { proposed: 'demo', reason: 'simulated engine — never writes real files' };
  }
  if (raw.workingDirectory) {
    const dir = realOrResolved(raw.workingDirectory).toLowerCase();
    const self = realOrResolved(ROOT_DIR).toLowerCase();
    if (dir === self || dir.startsWith(`${self}${path.sep}`)) {
      return { proposed: 'demo', reason: "lives inside AI-Orchestrator's own installation (a template)" };
    }
  }
  const text = `${raw.$comment ?? ''} ${raw.description ?? ''}`;
  if (/valid/i.test(text)) {
    return { proposed: 'validation', reason: 'described as a validation exercise' };
  }
  return { proposed: DEFAULT_CLASSIFICATION, reason: 'no strong signal either way' };
}

/**
 * Propose (never apply) a classification for every project that doesn't
 * already have one. Mirrors `isSimulatedProject()`'s own precedent: an
 * explicit field the owner already set always wins; inference is only ever
 * the fallback for a project that has none yet.
 *
 * @param {import('../config/configManager.js').ConfigManager} configManager
 * @returns {{name: string, proposed: string, reason: string}[]}
 */
export function classifyProposal(configManager) {
  const proposals = [];
  for (const name of configManager.listProjects()) {
    // The UNMERGED file, deliberately: PROJECT_DEFAULTS.classification is
    // now 'development', so a defaults-merged read (getRawProject) would
    // make every project look already classified and propose nothing.
    const raw = configManager.getProjectFileContents(name);
    if (!raw || raw.classification) continue; // already classified — never overridden
    const { proposed, reason } = inferClassification(raw);
    proposals.push({ name, proposed, reason });
  }
  return proposals;
}

export default { archive, restore, hide, unhide, forget, classifyProposal };
