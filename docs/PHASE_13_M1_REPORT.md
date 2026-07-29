# Phase 13 M1 — Long Message Reliability

**Version:** `v3.1.0`
**Date:** 2026-07-29
**Plan:** [PHASE_13_PLAN.md](PHASE_13_PLAN.md)

The owner had repeatedly observed mission-complete reports on Telegram ending
prematurely — cut off mid-sentence, not the complete report they expected.
The directive was explicit: don't just split messages, find the actual root
cause, and make sure nothing silently truncates again.

---

## What the evidence actually showed

Before writing any fix, two hypotheses were checked against real data.

**Hypothesis A — Telegram's real 4096-char message limit was being hit.**
Reconstructed the actual Mission Card + notification pipeline for a real
completed mission (`calculator-proof`, 12 real files) using the live
`buildMissionCard()`/`renderMissionCardText()`/`formatTelegramText()`
functions against real state on disk. Result: **493 characters**, fully
formatted — nowhere close to 4096. Every message type in
`notificationEngine.js` had its own cap (300/400 for `mission:complete`,
1200 for approvals, 1500 for daily/weekly summaries) — all comfortably under
Telegram's real limit even accounting for HTML-escaping growth. **This
hypothesis did not hold up.**

**Hypothesis B — an HTTP/HTML parse failure was being silently swallowed.**
`NotificationEngine.notify()` logs `"Notification channel failed"` on any
channel-send exception. Searched every available session log
(2026-07-15 through 2026-07-29, 6 days of real operation) for that string:
**zero matches**, despite warn-level logging demonstrably working (26+ other
warnings logged in the same window — unclean shutdowns, worker kills, port
conflicts). **This hypothesis did not hold up either.**

**What actually explained it.** Reading `notificationEngine.js`'s
`EVENT_MESSAGES['mission:complete']` directly: `truncate(summary, 300)` (when
a Mission Card exists) or `truncate(summary, 400)` (when it doesn't) is
applied to the **agent's own free-form final report** — a flat,
boundary-blind character slice with a trailing ellipsis. This is a Phase 11
"keep it short for a phone" design choice, not a transport bug. Whenever a
real agent's completion message ran past 300–400 characters — which is
routine for anything beyond a trivial task — the owner received an abrupt
stub instead of the report they were told to expect. The identical pattern
existed on `approval:required`/`human-action:required` (1200 chars) and the
daily/weekly summaries (1500 chars).

This is a materially different fix than "add a message splitter." The
splitter is still necessary — Telegram's real 4096 limit is a genuine
constraint once the artificial caps are gone — but it is the safety net, not
the primary fix. The primary fix is: **stop discarding the report in the
first place.**

---

## What shipped

- **`notificationEngine.js`**: the four flat `truncate()` calls on
  `mission:complete`'s summary, `approval:required`/`human-action:required`'s
  message, and `summary:daily`/`summary:weekly`'s text are gone. Full text
  goes out. (`approval:resolved`'s `decisionNote` cap and
  `task:verification-failed`'s `failedChecks` cap are untouched — those are
  short status echoes, not "the complete report," and were out of scope for
  this fix.)
- **New `src/notifications/telegramSplit.js`**: `MAX_MESSAGE_CHARS` (4096,
  the first place this codebase names the real limit),
  `splitForTelegram(text, opts)` (a tag/entity-aware scanner — never cuts
  inside a `<tag>` or `&entity;`, prefers paragraph → line → word breaks,
  and only accepts a boundary that fills at least half the available budget
  so one early newline can't produce a tiny first part followed by an
  almost-empty rest), and `sendLongText({send, text})` — the one shared send
  path.
- **`channels/telegram.js` and `telegramProvider.js`**: `send()`, `publish()`,
  and `sendText()` now route through `sendLongText`; each gained a
  `postMessage(text, {plain})` for sending exactly one part, `plain: true`
  omitting `parse_mode` for the retry-on-rejection path.

## A bug found and fixed during implementation

The first version of `splitForTelegram` picked whichever boundary had the
*highest rank* anywhere in the search window, regardless of position. For
`"Mission complete\n" + "x".repeat(5000)`, the single `\n` right after the
title outranked the one word-space inside "Mission complete" — so the
algorithm split at character 17, producing a nearly-empty first message and
dumping almost everything into the second and third. Fixed by only accepting
a boundary if it fills at least half the message budget (`MIN_FILL_RATIO`);
otherwise a hard cut nearer the real limit is used. Caught by the adversarial
test suite before it ever reached a real send.

---

## Verification

- **992/992 backend tests** (was 972; +20: `telegramSplit.test.js` — 14
  tests covering exact-boundary splits, tag/entity safety, boundary
  preference, an adversarial mixed-content generator, and the plain-text
  retry path — plus wiring/regression tests in `telegramChannel.test.js`,
  `approvalProviders.test.js`, and `notificationEngine.test.js`).
- **Live validation against the real bot**: a synthetic 7,091-character
  report (40 paragraphs, filenames, an ampersand) was sent through the real,
  configured `TelegramChannel` using `notify test`'s same credentials. The
  real Telegram API accepted every part with no errors — confirming the
  split payloads are valid HTML `sendMessage` calls against the actual API,
  not just against a fake `fetchFn` in tests.

---

## What's next

Phase 13 M2 — Project Roots & Discovery (`v3.2.0`). See
[PHASE_13_PLAN.md](PHASE_13_PLAN.md).
