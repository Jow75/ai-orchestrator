/**
 * telegramSplit.js — Phase 13 M1: deterministic multi-part delivery for
 * Telegram text that exceeds the API's real per-message limit.
 *
 * Root cause of the owner's observed mid-report cutoffs (see
 * docs/PHASE_13_PLAN.md M1): NOT Telegram's real 4096-char limit (measured
 * against real mission data, actual reports stay in the low hundreds to low
 * thousands of characters — nowhere near it) and NOT a silently-swallowed
 * HTTP error (zero "Notification channel failed" warnings across every
 * available session log, despite warn-level logging demonstrably working).
 * The actual mechanism: `notificationEngine.js`'s `EVENT_MESSAGES` table
 * applied a flat, boundary-blind `truncate(text, N)` (300/400/1200/1500
 * chars depending on event) directly to the AGENT'S OWN free-form report —
 * a deliberate Phase 11 "keep it short for a phone" design choice, not a
 * transport bug, that silently discarded real content mid-sentence whenever
 * a report ran longer than the cap. Those flat caps are removed at the
 * source (`notificationEngine.js`); this module is what makes sending the
 * FULL text safe: one message when it fits, deterministic numbered
 * continuations when it doesn't — Telegram's real 4096 limit is a genuine
 * constraint even after fixing the real bug, so it still needs handling,
 * just no longer as the primary suspect.
 *
 * splitForTelegram() operates on already-`formatTelegramText()`-ed HTML, so
 * it must never cut inside an HTML tag (`<code>`) or entity (`&amp;`) —
 * doing so would send a malformed `parse_mode: 'HTML'` payload, which is
 * worse than the truncation this replaces.
 */

/** Telegram's real per-message character limit (sendMessage `text`). */
export const MAX_MESSAGE_CHARS = 4096;

// Reserved so a " (N/M)" continuation suffix always fits without a second
// measurement pass — generous enough for any realistic part count (a
// message needing 100 parts would be 400,000+ characters, not a real report).
const SUFFIX_RESERVE = 12;

/**
 * Precompute, for every slice position 0..text.length, whether cutting there
 * lands outside any open `<tag>` or `&entity;`. Computed once per split (not
 * per candidate position) so scanning a long text stays linear.
 */
function computeSafePositions(text) {
  const safe = new Array(text.length + 1);
  let inTag = false;
  let inEntity = false;
  safe[0] = true;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inTag) {
      if (ch === '>') inTag = false;
    } else if (inEntity) {
      // A well-escaped entity (formatTelegramText's own guarantee) always
      // closes with ';' within a few characters. Bailing out on '&', '<', or
      // whitespace guards against ever getting stuck "in an entity" forever
      // if that guarantee is ever violated.
      if (ch === ';' || ch === '&' || ch === '<' || /\s/.test(ch)) inEntity = false;
    }
    if (!inTag && !inEntity) {
      if (ch === '<') inTag = true;
      else if (ch === '&') inEntity = true;
    }
    safe[i + 1] = !inTag && !inEntity;
  }
  return safe;
}

/** 3 = paragraph break, 2 = line break, 1 = word break, 0 = not a boundary. */
function boundaryRank(text, i) {
  if (i <= 0 || i >= text.length) return 0;
  if (text[i - 1] === '\n' && text[i - 2] === '\n') return 3;
  if (text[i - 1] === '\n') return 2;
  if (text[i - 1] === ' ') return 1;
  return 0;
}

// A found boundary is only used if it fills at least this fraction of the
// available budget — otherwise a single early break (e.g. one newline right
// after a short title, followed by thousands of characters of unbroken text)
// would produce a tiny first part instead of a well-packed one. Below this
// fraction, a hard cut nearer the actual limit is preferred.
const MIN_FILL_RATIO = 0.5;

/**
 * The best position in `text[from, from+limit]` to end a part at: the
 * boundary (paragraph, then line, then word — `boundaryRank`'s own
 * priority at whichever position is used) closest to the limit, as long as
 * it fills a reasonable share of the budget, always at a `safe`
 * (non-tag, non-entity) position. Falls back to a hard cut at the limit,
 * retreating only as far as needed to land on a safe position.
 */
function findSplitPoint(text, safe, from, limit) {
  const end = Math.min(from + limit, text.length);
  const minAcceptable = from + Math.floor(limit * MIN_FILL_RATIO);
  for (let i = end; i > minAcceptable; i -= 1) {
    if (safe[i] && boundaryRank(text, i) > 0) return i;
  }

  let point = end;
  while (point > from && !safe[point]) point -= 1;
  return point > from ? point : end;
}

/**
 * Split already-HTML-formatted text into parts that each fit Telegram's real
 * message limit, never cutting inside a tag or entity. A single-part result
 * is returned unchanged (no numbering); a multi-part result gets a
 * `(n/total)` suffix on every part.
 *
 * @param {string} text - Output of `formatTelegramText()` (or plain text).
 * @param {{maxChars?: number}} [options]
 * @returns {string[]}
 */
export function splitForTelegram(text, { maxChars = MAX_MESSAGE_CHARS } = {}) {
  if (text.length <= maxChars) return [text];

  const safe = computeSafePositions(text);
  const effectiveMax = maxChars - SUFFIX_RESERVE;
  const parts = [];
  let from = 0;
  while (from < text.length) {
    const remaining = text.length - from;
    if (remaining <= effectiveMax) {
      parts.push(text.slice(from));
      break;
    }
    const point = findSplitPoint(text, safe, from, effectiveMax);
    parts.push(text.slice(from, point));
    from = point;
  }

  const total = parts.length;
  return total <= 1 ? parts : parts.map((part, index) => `${part}\n(${index + 1}/${total})`);
}

/** Best-effort plain-text fallback when Telegram rejects an HTML payload. */
export function stripHtml(text) {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/**
 * The one shared send path every Telegram text call site converges on.
 * Sends one message when `text` fits; splits and sends sequentially,
 * in order, when it doesn't. If Telegram rejects a part outright (a
 * malformed HTML payload — previously a silently logged-and-dropped
 * failure, see docs/PHASE_13_PLAN.md M1), retries that one part once with
 * formatting stripped rather than losing it.
 *
 * @param {object} params
 * @param {(part: string, opts?: {plain?: boolean}) => Promise<{messageId?: string}|void>} params.send -
 *   Sends ONE final string. Callers close over their own HTTP call and chat
 *   id; `plain: true` means "send without parse_mode" (the retry path).
 * @param {string} params.text - Fully composed, already-HTML-formatted text.
 * @param {number} [params.maxChars]
 * @returns {Promise<{messageId?: string}>} The first part's result, so
 *   existing single-message callers keep a stable `messageId` contract.
 */
export async function sendLongText({ send, text, maxChars = MAX_MESSAGE_CHARS }) {
  const parts = splitForTelegram(text, { maxChars });
  let first;
  for (const part of parts) {
    // eslint-disable-next-line no-await-in-loop -- parts must arrive in order
    const result = await sendOnePart(send, part);
    if (!first) first = result;
  }
  return first ?? {};
}

async function sendOnePart(send, part) {
  try {
    return (await send(part)) ?? {};
  } catch {
    return (await send(stripHtml(part), { plain: true })) ?? {};
  }
}

export default { MAX_MESSAGE_CHARS, splitForTelegram, stripHtml, sendLongText };
