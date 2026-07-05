/**
 * progressConfidence.js — How much do we trust the progress verdict?
 *
 * The circuit breaker asks a yes/no question ("did the workspace change?").
 * But not all "yes" answers are equally trustworthy, and the orchestrator
 * will increasingly make autonomous decisions on them. This module attaches
 * a confidence level and the list of corroborating signals to every
 * progress verdict, so later phases (and the future dashboard) can weigh it.
 *
 * In P0 the only evidence is the workspace signature. As P1/P6 add test,
 * build, and verification signals, they append to `signals` and raise the
 * level — this function is the single place that maps evidence → confidence.
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
 * @param {string} params.method - Signature method: 'git' | 'filescan' | 'none' | 'skipped'.
 * @param {object} [params.detail] - Signature detail (e.g. git head, dirty count).
 * @param {string[]} [params.extraSignals] - Additional corroborating signals
 *   from later phases (e.g. 'tests-passed', 'build-ok', 'verified').
 * @returns {{level: string, score: number, signals: string[]}}
 */
export function assessConfidence({ progressed, method, detail = {}, extraSignals = [] }) {
  const signals = [...extraSignals];

  // How well could we measure at all?
  if (method === 'git') signals.push('git');
  else if (method === 'filescan') signals.push('filescan');
  else if (method === 'none') signals.push('unmeasurable');

  if (progressed) {
    signals.push('workspace-changed');
    // A moved HEAD means committed work — the strongest workspace signal.
    if (method === 'git' && detail.dirty === 0) signals.push('git-commit');
  } else if (method !== 'skipped') {
    signals.push('workspace-unchanged');
  }

  const score = scoreFrom(signals, method);
  return { level: levelFrom(score), score, signals };
}

/** Combine signals into a 0..1 confidence score. */
function scoreFrom(signals, method) {
  // Base score is the measurement quality; verification signals add to it.
  let score;
  if (method === 'git') score = 0.8;
  else if (method === 'filescan') score = 0.55;
  else if (method === 'skipped') score = 0.5; // progress not consulted this run
  else score = 0.2; // 'none' — we could not measure

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
