/**
 * infra/errors.js — Phase 11 M3: the remedy-first error contract.
 *
 * Every error that can reach the CLI's top-level `fail()` handler (see
 * cli/index.js) either:
 *   - carries `error.userFacing = true` (or is a ConfigError) → rendered as
 *     a plain, remedy-first message with the stack suppressed — this is an
 *     expected, user-fixable situation, not a bug; or
 *   - anything else → a real defect, so the stack IS shown. Never hide an
 *     actual bug behind a friendly message.
 *
 * `userFacingError()` builds the first kind consistently: `cause` (what
 * happened and why — required), `impact` (what it actually affects, when
 * not obvious), and `fix` (the exact next command or step). Keeping the
 * shape in one place is what stops the wording from drifting error-to-error
 * as new ones are added — every expected error should answer the same
 * three questions in the same order.
 */

/**
 * Build a user-facing Error with a consistent, remedy-first message.
 *
 * @param {object} parts
 * @param {string} parts.cause - What happened, and why (required).
 * @param {string} [parts.impact] - What this actually affects, when it
 *   isn't already obvious from `cause`.
 * @param {string} [parts.fix] - The exact next command or step to resolve it.
 * @returns {Error} `error.userFacing` is set; `.message` combines the parts.
 */
export function userFacingError({ cause, impact, fix }) {
  const lines = [cause];
  if (impact) lines.push(impact);
  if (fix) lines.push(`Fix: ${fix}`);
  const error = new Error(lines.join(' '));
  error.userFacing = true;
  return error;
}

export default { userFacingError };
