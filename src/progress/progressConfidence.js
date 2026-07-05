/**
 * progressConfidence.js — How much do we trust the progress verdict?
 *
 * The circuit breaker asks a yes/no question ("did the workspace change?").
 * But not all "yes" answers are equally trustworthy, and the orchestrator
 * will increasingly make autonomous decisions on them. This module attaches
 * a confidence level and the list of corroborating signals to every
 * progress verdict, so later phases (and the future dashboard) can weigh it.
 *
 * `method` is treated as a quality tier, matched by substring so any
 * caller's naming works: a method mentioning "git" is git-aware (whether
 * or not it also scans the filesystem, e.g. `progressEngine.js`'s
 * `'git+scan'`), a method mentioning "scan" without git is a plain
 * filesystem scan, `'skipped'` means progress wasn't consulted this run,
 * and anything else (including `'none'`) means unmeasurable.
 *
 * P1 (`progressEngine.js`) is the only in-tree caller today and supplies
 * its own `extraSignals` (e.g. `'git-commit'`) computed from its own change
 * facts — this module does not infer commit state from `detail` itself, to
 * avoid two components disagreeing about what "clean tree" means. P6's
 * verification signals (`'tests-passed'`, `'build-ok'`, `'verified'`) will
 * append to `signals` the same way — this function is the single place
 * that maps evidence → confidence for the whole platform.
 *
 * Pure logic, no I/O.
 */

/** @enum {string} */
export const Confidence = Object.freeze({
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
});

/**
 * Assess confidence in a run's progress verdict.
 *
 * @param {object} params
 * @param {boolean} params.progressed - Did the workspace change?
 * @param {string} params.method - Measurement method. Matched by substring:
 *   anything mentioning "git" is git-aware, anything mentioning "scan"
 *   (without "git") is a plain filesystem scan, `'skipped'` means progress
 *   wasn't consulted this run, anything else means unmeasurable.
 * @param {object} [params.detail] - Reserved for future evidence not yet
 *   captured by `extraSignals` (unused today — see the module docstring).
 * @param {string[]} [params.extraSignals] - Additional corroborating signals
 *   supplied by the caller (e.g. 'git-commit', 'tests-passed', 'build-ok',
 *   'verified').
 * @returns {{level: string, score: number, signals: string[]}}
 */
// eslint-disable-next-line no-unused-vars -- detail is a reserved extension point
export function assessConfidence({ progressed, method, detail = {}, extraSignals = [] }) {
  const signals = [...extraSignals];
  const tier = methodTier(method);

  if (tier === 'git') signals.push('git');
  else if (tier === 'scan') signals.push('filescan');
  else if (tier === 'unmeasurable') signals.push('unmeasurable');

  if (progressed) signals.push('workspace-changed');
  else if (tier !== 'skipped') signals.push('workspace-unchanged');

  const score = scoreFrom(signals, tier);
  return { level: levelFrom(score), score, signals };
}

/** Classify a method name into a measurement-quality tier. */
function methodTier(method) {
  if (method === 'skipped') return 'skipped';
  if (method?.includes('git')) return 'git'; // 'git', 'git+scan', ...
  if (method?.includes('scan')) return 'scan'; // 'filescan', 'scan', ...
  return 'unmeasurable'; // 'none', undefined, or anything else
}

/** Combine signals into a 0..1 confidence score. */
function scoreFrom(signals, tier) {
  // Base score is the measurement quality; verification signals add to it.
  const BASE_SCORE = { git: 0.8, scan: 0.55, skipped: 0.5, unmeasurable: 0.2 };
  let score = BASE_SCORE[tier];

  if (signals.includes('git-commit')) score = Math.max(score, 0.9);
  if (signals.includes('tests-passed')) score = Math.min(1, score + 0.1);
  if (signals.includes('build-ok')) score = Math.min(1, score + 0.05);
  if (signals.includes('verified')) score = Math.min(1, score + 0.1);
  return Math.round(score * 100) / 100;
}

function levelFrom(score) {
  if (score >= 0.75) return Confidence.HIGH;
  if (score >= 0.45) return Confidence.MEDIUM;
  return Confidence.LOW;
}

export default { Confidence, assessConfidence };
