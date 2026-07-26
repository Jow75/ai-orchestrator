/**
 * telegramFormat.js -- Phase 11 M2: never let a filename become a dead link.
 *
 * The concrete bug a live walkthrough found: Telegram sends every message
 * with NO `parse_mode` set, so its client-side auto-linkification runs
 * unrestricted -- and `.md` is coincidentally also a ccTLD (Moldova), so a
 * mission summary that merely MENTIONS "README.md" or "DiagnosticReport.md"
 * renders as a clickable link to a random/dead site. Tapping it on a phone
 * opens nothing useful.
 *
 * The fix: send every message with `parse_mode: 'HTML'` (see channels/
 * telegram.js and approvals/providers/telegramProvider.js) and run the text
 * through `formatTelegramText` first -- it HTML-escapes the text (required
 * once parse_mode is set, otherwise literal `<`/`>` in agent output would
 * be misread as tags) and wraps filename-like tokens in `<code>`, which
 * Telegram's official clients never auto-linkify.
 *
 * This is a heuristic over FREEFORM text (agent output, plan summaries) --
 * it cannot know every possible "this is a filename" case. A REAL file
 * should always be attached directly instead (see sendDocument) whenever
 * one is available; this only protects text that merely names one.
 */

/** HTML-escape text for use inside a Telegram `parse_mode: 'HTML'` message. */
export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Extensions treated as "artifact filenames" that must never render as a
 * clickable link. Deliberately the common report/doc/code-output kinds
 * seen in mission summaries and diagnostic reports -- not exhaustive.
 */
const FILENAME_EXTENSIONS = ['md', 'txt', 'log', 'json', 'diff', 'patch', 'zip', 'pdf'];

/** A bare filename/path (optionally with directories), not part of a real URL. */
const FILENAME_PATTERN = new RegExp(
  String.raw`\b[\w][\w./\\-]*\.(?:${FILENAME_EXTENSIONS.join('|')})\b`,
  'g'
);

/** A real URL -- never re-wrap a link that's already meant to be clickable. */
const URL_PATTERN = /\bhttps?:\/\/\S+/gi;

/**
 * Placeholder delimiters used while masking URLs during the filename pass
 * (see formatTelegramText). / are control characters that never
 * occur in normal text, so restoring them can never collide with an
 * unrelated number the original text already happened to contain.
 */
const MASK_START = '';
const MASK_END = '';
const MASK_PATTERN = new RegExp(`${MASK_START}(\\d+)${MASK_END}`, 'g');

/**
 * Prepare freeform text for a Telegram `parse_mode: 'HTML'` message:
 * HTML-escape it, then wrap filename-like tokens in `<code>` so they render
 * as inline code instead of a bogus link -- without touching genuine
 * `http(s)://` URLs, which stay real, clickable links.
 *
 * @param {string} text
 * @returns {string}
 */
export function formatTelegramText(text) {
  const escaped = escapeHtml(text);

  // Protect real URLs from the filename pass by masking them first, then
  // restoring -- a URL that happens to end in ".../report.pdf" must stay a
  // single plain link, not get a nested <code> tag splitting it apart.
  const urls = [];
  const masked = escaped.replace(URL_PATTERN, (m) => {
    urls.push(m);
    return `${MASK_START}${urls.length - 1}${MASK_END}`;
  });

  const withFilenames = masked.replace(FILENAME_PATTERN, (m) => `<code>${m}</code>`);

  return withFilenames.replace(MASK_PATTERN, (_, i) => urls[Number(i)]);
}

export default { escapeHtml, formatTelegramText };
