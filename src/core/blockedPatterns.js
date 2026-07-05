/**
 * blockedPatterns.js — Blocked-state & permission-denied detection.
 *
 * Some agent runs finish with exit code 0 yet accomplished nothing because
 * the agent was *blocked*: it needed a permission it did not have, lacked
 * access to a resource, or declared it could not proceed. In headless mode
 * an agent cannot pause for input — it explains the blocker and exits
 * "successfully". The exit classifier sees COMPLETED; only the *content* of
 * the output reveals the truth.
 *
 * This module scans an agent's final output for those distress signals. It
 * is the fast path that would have stopped the overnight incident on run #1:
 * Claude printed "you haven't granted permission" 1,203 times while the
 * supervisor relaunched it 343 times.
 *
 * Pure logic, no I/O. Patterns are intentionally specific so that a mission
 * merely *discussing* permissions is not mistaken for one *blocked* by them;
 * the orchestrator further guards against false positives by only treating a
 * match as fatal when the run also made no measurable progress.
 */

/**
 * Known "the agent is blocked" phrasings, each tagged with a category and a
 * human-facing hint about the likely fix. Ordered most-specific first.
 * @type {{category: string, pattern: RegExp, hint: string}[]}
 */
export const BLOCKED_PATTERNS = [
  {
    category: 'permission-denied',
    // Claude Code's headless permission-denial phrasing.
    pattern: /requested permissions to [^\n]*? but you haven't granted it yet/i,
    hint:
      'The agent tried to use a tool it was not permitted to use. For unattended ' +
      'runs set claude.permissionMode ("acceptEdits") or claude.allowedTools in the ' +
      'project config (see CONFIGURATION.md).',
  },
  {
    category: 'permission-denied',
    pattern: /\b(?:haven't|have not) granted (?:it|permission|access)\b/i,
    hint:
      'A tool permission was never granted. Configure claude.permissionMode or ' +
      'claude.allowedTools for unattended operation.',
  },
  {
    category: 'permission-denied',
    pattern: /\b(?:permission|access) denied\b/i,
    hint: 'A permission or access check failed. Review the run output and grant what is needed.',
  },
  {
    category: 'no-access',
    pattern: /\bI (?:don't|do not) have (?:access|permission) to\b/i,
    hint: 'The agent lacks access to a required resource. Check paths, credentials, and tool allow-lists.',
  },
  {
    category: 'cannot-proceed',
    pattern: /\b(?:cannot|can't|unable to) (?:proceed|continue|complete)(?: this)?(?: without| until| because)\b/i,
    hint: 'The agent reported it is blocked. Read its explanation in the run output and remove the blocker.',
  },
  {
    category: 'awaiting-input',
    pattern: /\b(?:waiting for|awaiting|need|require)(?: your| user)? (?:input|confirmation|approval|permission)\b/i,
    hint:
      'The agent is waiting for interactive input it cannot receive in headless mode. ' +
      'Make the mission self-contained or grant the needed permissions up front.',
  },
];

/**
 * Detect whether an agent's final output indicates a blocked state.
 *
 * @param {string} outputTail - Recent combined agent output (and/or result text).
 * @returns {{blocked: boolean, category?: string, hint?: string, evidence?: string}}
 */
export function detectBlockedState(outputTail) {
  const text = outputTail ?? '';
  for (const { category, pattern, hint } of BLOCKED_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      return {
        blocked: true,
        category,
        hint,
        // A short excerpt around the match, for the diagnostic report.
        evidence: excerptAround(text, match.index ?? 0),
      };
    }
  }
  return { blocked: false };
}

/** Return a compact single-line excerpt centred on a match index. */
function excerptAround(text, index, radius = 120) {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`;
}

export default { BLOCKED_PATTERNS, detectBlockedState };
