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
  // ── Phase 10A: human-action situations ─────────────────────────────────
  // These categories match `approvals.humanActionCategories`, so when the
  // Approval Manager is active they pause gracefully and notify the owner
  // (what/why/action/where) instead of terminally blocking. Without the
  // Approval Manager they behave exactly like every other blocked category.
  {
    category: 'captcha',
    pattern: /\b(?:captcha|recaptcha|hcaptcha|prove (?:you(?:'| a)re|that you are) (?:not a robot|human))\b/i,
    hint: 'A CAPTCHA challenge needs a human. Complete it where the agent encountered it, then reply DONE.',
  },
  {
    category: 'authentication',
    pattern: /\b(?:log ?in|sign ?in|authenticate|authentication|2fa|two-factor|verification code|otp) (?:is )?(?:required|needed|expired|failed)\b/i,
    hint: 'Authentication is required. Log in / refresh credentials where needed, then reply DONE.',
  },
  {
    category: 'external-login',
    pattern: /\b(?:please|must|need to) (?:log ?in|sign ?in|authenticate)\b/i,
    hint: 'An external service needs an interactive login the agent cannot perform. Log in, then reply DONE.',
  },
  {
    category: 'browser-permission',
    pattern: /\bbrowser (?:permission|prompt|dialog|popup) (?:is )?(?:required|blocking|needs?)\b/i,
    hint: 'A browser permission prompt is blocking the agent. Accept/dismiss it, then reply DONE.',
  },
  {
    category: 'desktop-confirmation',
    pattern: /\b(?:desktop|system|os|uac) (?:confirmation|dialog|prompt) (?:is )?(?:required|blocking|waiting)\b/i,
    hint: 'A desktop/system dialog needs a human click. Confirm it on the machine, then reply DONE.',
  },
  {
    category: 'physical-interaction',
    pattern: /\b(?:physical(?:ly)?|manual(?:ly)?) (?:interaction|intervention|action|access) (?:is )?(?:required|needed)\b/i,
    hint: 'Physical interaction with the machine or a device is required, then reply DONE.',
  },
  // ── Original blocked-state patterns (P0) ────────────────────────────────
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
    category: 'missing-file',
    pattern: /\b(?:no such file or directory|file not found|could not find (?:the )?file|ENOENT)\b/i,
    hint: 'A required file or path is missing. Check the mission prompt and the working directory contents.',
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
 * The built-in patterns are generic English distress signals, so this works
 * for any engine. A driver may contribute engine-specific patterns via its
 * optional `blockedPatterns` property — keeping the detector AI-agnostic
 * while still allowing per-engine precision.
 *
 * @param {string} outputTail - Recent combined agent output (and/or result text).
 * @param {{category: string, pattern: RegExp, hint?: string}[]} [extraPatterns]
 *   Driver-supplied patterns, checked before the built-ins.
 * @returns {{blocked: boolean, category?: string, hint?: string, evidence?: string}}
 */
export function detectBlockedState(outputTail, extraPatterns = []) {
  const text = outputTail ?? '';
  for (const { category, pattern, hint } of [...extraPatterns, ...BLOCKED_PATTERNS]) {
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
