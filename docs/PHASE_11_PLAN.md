# Phase 11 — Operator Experience: Implementation Plan (v2.4.0 → v2.7.0)

**Status:** APPROVED 2026-07-14 (see §12). Implementation in progress — M1.
**Prereq:** Phase 10.5 committed + tagged (`v2.3.1`, commit `6db6c5b`).
**Supersedes for execution:** `PHASE_11_PROPOSAL.md` (kept as the origin
evidence). This document is the approved-scope, sequenced build plan that
reconciles three sources:

1. The **master engineering vision** (11A–11J + the "Additional
   Improvements": notification dedup, attachments, executive reports,
   progress visibility, recommendations).
2. The **Phase 10.5 Operational Validation** findings
   (`PHASE_10.5_READINESS.md`) — onboarding 7/10, operator-experience
   7.5/10, untuned notification noise.
3. The **evidence-based proposal** (`PHASE_11_PROPOSAL.md`).

**Guiding rule (unchanged):** only solve problems demonstrated by live
testing or that directly improve the proven workflow. Every item below is
anchored to a confirmed defect or a documented 10.5 friction point — see
§2. Nothing is invented.

---

## 1. Invariants this phase must not break

These are load-bearing and every milestone is checked against them:

- **Optional-collaborator invariant.** A config with no Phase-10/11 keys
  behaves byte-for-byte as pre-Phase-10. Wizards only *write* the same
  config an expert edits by hand; no wizard is ever on a required code
  path. (Tested today; must stay green.)
- **Supervision behaviour is frozen.** Phase 11 changes nothing about how
  missions are launched, recovered, or resumed. It changes what a *human*
  touches around them.
- **Fail-safe notifications.** Deduplication may never *drop* a
  genuinely new alert; when in doubt it sends. A missed owner-gate is worse
  than a duplicate.
- **Fail-safe fixes.** `doctor --fix` is read-only by default, every change
  is confirmed, and it only writes config an expert would — never runtime
  state, never secrets into tracked files.
- **Backward-compatible surfaces.** Existing CLI commands, API endpoints,
  and config keys keep working. New behaviour is additive (new flags, new
  subcommands, new optional keys).
- **Green suite gate.** 436 backend + 18 desktop stay green at every commit;
  new tests are added with the code that needs them.

---

## 2. Evidence base (confirmed in code, 2026-07-14)

| # | Problem | Confirmed at | Milestone |
| --- | --- | --- | --- |
| E1 | Onboarding is hand-edited JSON; `projects add` non-interactive; no `init`; `notify` has only `test` | `cli/index.js:624,670`; 10.5 readiness §5 | M1 |
| E2 | Telegram chat-id discovery is a manual `getUpdates` poll | `telegramProvider.js:77`; done by hand in 10.5 | M1 |
| E3 | **Duplicate approval pings on resume/crash** — gate re-creates a *new* pending request instead of reusing the existing one | `orchestrator.js:1056` (+1165,1226) → `approvalManager.js:108` always `store.create`; `approvalStore.listPending` unused | M2 |
| E4 | **No notification idempotency** — every emitted event sends; no sent/messageId/reminder state | `notificationEngine.js:192` | M2 |
| E5 | **Filenames become dead links** — Telegram send has no `parse_mode`; `README.md` linkifies (`.md` ccTLD) | `telegram.js:28`, `telegramProvider.js:55` | M2 |
| E6 | **No attachment path** — only `sendMessage`; no `sendDocument`; message_id discarded | `telegram.js`, `telegramProvider.js` | M2 |
| E7 | **Mission-complete is a flat string** — no duration/files/tests/commit/next | `orchestrator.js:314,598,829`; `notificationEngine.js:87` | M2 |
| E8 | **No `doctor --fix`** — `runDoctor` prints inline, no structured findings/fix actions | `cli/index.js:1555` | M3 |
| E9 | Blocked/stale states don't hand the owner the exact recovery command | `orchestrator.js` block(); 10.5 used `--abandon` reactively | M3 |
| E10 | Untuned notification noise (all channels, all events, `info`); per-channel `minSeverity` exists but unset | `notificationEngine.js:144`; 10.5 readiness §5 | M4 |
| E11 | No remote mid-mission progress; no cross-surface terminology contract | status/lifecycle exist but aren't pushed; wording drifts CLI/desktop/Telegram | M4 |

---

## 3. Milestone roadmap

Priority order is the owner's: Onboarding → Phone/Notifications →
Doctor/Recovery → remaining. Each milestone is independently shippable,
backward-compatible, and tagged as a minor release.

| Milestone | Theme (priority) | Tag | Est. commits | New tests (approx) |
| --------- | ---------------- | --- | :---: | :---: |
| **M1** | Onboarding & first-run (P1 / 11A–11D) | `v2.4.0` | 4–5 | ~35 |
| **M2** | Phone & notification experience (P2) | `v2.5.0` | 5–6 | ~45 |
| **M3** | Doctor, recovery & guidance (P3 / 11E–11F) | `v2.6.0` | 3–4 | ~25 |
| **M4** | UX consistency, remote polish, docs (11G–11J) | `v2.7.0` | 3–4 | ~20 |

**Versioning rationale.** Each milestone adds backward-compatible features
⇒ a minor bump, matching the repo's phase-per-tag convention (Phase 8→
v2.1, 9→v2.2, 10→v2.3). Phase 11 "complete" = `v2.7.0`. *Alternative if you
prefer one snapshot:* ship the whole phase as a single `v2.4.0` at the end;
I recommend the incremental tags so each block delivers value and can be
verified live before the next begins.

**Cross-milestone dependencies.**

- M1 → M2: the Telegram wizard (M1) makes M2's live attachment/card
  verification trivial to re-run, but M2 does not *depend* on M1 code.
- M2 mission-card data assembly (E7) reuses the existing
  `projectIntelligence` next-work-item for the "next recommendation" line —
  no new intelligence, just surfacing.
- M3 `doctor --fix` reuses M1 wizards as its repair actions (e.g. "Telegram
  incomplete → run `notify setup telegram`"). So M1 lands first by design.
- M4 terminology contract touches all surfaces ⇒ last, after the vocabulary
  has stabilised through M1–M3.

---

## 4. M1 — Onboarding & first-run experience → `v2.4.0`

**Goal (success test):** a new user reaches a working project **and** a
working phone approval without hand-editing a single JSON file, using only
`init` and the wizards it launches.

### 4.1 Deliverables

- **`projects add --interactive`** (11B). Prompts: working directory (with
  existence check + offer to create), prompt-file vs. task-plan, engine,
  permission mode (default `acceptEdits`, risk explained inline), allowed
  tools. Runs the result through the existing `validateProject` before
  writing. Writes the *same* file shape `projects add` writes today.
- **`ai-orchestrator init`** (11A). Idempotent, re-runnable, every step
  skippable: (1) probe Node + `claude` CLI (reuse doctor's probes); (2)
  offer project creation (delegates to 11B); (3) offer remote notifications
  (delegates to 11C/11D); (4) offer the auto-resume logon task; (5) finish
  with a live `notify test` and a one-line "you're ready" summary.
- **`notify setup telegram`** (11C). Prompt for BotFather token → validate
  via `getMe` → ask the owner to message the bot once → **poll `getUpdates`
  until the chat id appears** (automates E2) → send a test → write
  `notifications.telegram` + `approvals.providers.telegram` into
  `config/local.json`.
- **`notify setup email`** (11D). Prompt provider/host/port/credentials
  (Gmail app-password path called out) → send a real test via
  `smtpClient.js` → on success write `config/local.json`. Common SMTP errors
  (535 auth, 465 vs 587) surfaced as plain-language fixes.
- **Interrupt/resume.** Every wizard is safe to Ctrl-C and re-run; each
  writes only on confirmed success, so a half-finished wizard leaves a valid
  (unchanged) config. "Resume" = re-run; the wizard detects what's already
  configured and offers to skip it.

### 4.2 Design notes

- New module `src/onboarding/` with one pure `*Wizard.js` per flow plus a
  tiny `prompts.js` (readline wrapper, injectable input stream for tests —
  the wizards must be testable without a TTY). No new runtime dependency.
- Wizards are **config writers only**. A `writeLocalConfig(patch)` helper
  deep-merges into `config/local.json` (the same merge `ConfigManager`
  already does on load), never clobbering unrelated keys.
- `getMe`/`getUpdates`/SMTP calls go through injectable `fetchFn`/client so
  tests run offline; a live path is exercised only in manual verification.

### 4.3 Tests / docs / commits

- **Tests:** each wizard's writer produces byte-identical config to the
  hand-written reference; validation rejects bad input; chat-id poller
  parses a `getUpdates` fixture; the optional-collaborator invariant test
  still passes (a config with none of these keys is unchanged).
- **Docs:** new `docs/DAY_ONE.md` (the single "0→first mission" page the
  wizards mirror); fold `TELEGRAM_SETUP.md`/`EMAIL_SETUP.md` manual steps
  into "prefer to do it by hand?" appendices under each wizard; update
  `QUICKSTART.md`, `README.md`, CHANGELOG, ROADMAP.
- **Commits:** (1) prompts harness; (2) project wizard; (3) init; (4)
  telegram+email wizards; (5) docs + version bump + tag.

### 4.4 Risks

- *TTY testing.* Mitigated by injecting the input stream; no wizard reads
  `process.stdin` directly.
- *Windows readline quirks.* Verified live on this machine before tagging.
- *Scope creep into a GUI.* Out of scope — CLI wizards only; desktop
  onboarding is a later consideration, not M1.

---

## 5. M2 — Phone & notification experience → `v2.5.0`

The highest-impact operational milestone. Three problems, three fixes.

### 5.1 Deduplication & idempotency (E3, E4) — root cause first

**Layer 1 — approval reuse (the real fix for E3).** Before creating a
request, the gate looks up an existing *pending* request for the same
`(project, taskId, category)` via `approvalStore.listPending` and, if
found, **waits on it** instead of minting a new id and re-publishing. This
is the actual cause of duplicate pings on stop/resume and crash-recovery.
Applied to all three gates (`gateTaskApproval`, implementation-review,
human-action).

**Layer 2 — notification idempotency (E4).** A machine-owned
`state/notifications/<project>.json` records, per dedupe key
(`event + entityId`, e.g. `approval:required + A20`):
`{ notificationSent, notificationTime, telegramMessageId, emailMessageId,
lastReminder, status }`. The engine skips a resend unless:

- an explicit **reminder interval** has elapsed (config
  `notifications.reminderMs`, default off), or
- the previous delivery **failed**, or
- the operator **requested a resend**, or
- the **entity state changed** (pending → resolved is a new, distinct
  notification).

This is the master prompt's exact contract ("do not notify again unless…").
Capturing `telegramMessageId`/`emailMessageId` (from the send response, not
discarded as today) enables reminders to *edit* rather than repost.

### 5.2 Mission Cards (E7)

- New `src/notifications/missionCard.js` — a pure builder that assembles a
  structured card from existing mission/session/verification/git/timeline
  data (no new tracking): **mission · status · required action · risk ·
  files changed · tests · commit · duration · next recommendation
  (reusing `projectIntelligence` next-work-item) · reply commands**.
- The orchestrator enriches the `mission:complete` payload (and
  approval/blocked payloads) with the fields the card needs; channels render
  the *same* card object their own way (Telegram formatted text + optional
  artifact; email as HTML; desktop as a concise toast). Rendering stays
  per-channel; assembly is central.
- Reply commands / buttons: Telegram inline keyboard for
  APPROVE/REJECT/MODIFY where a decision is needed; text reply grammar
  remains the fallback (unchanged, still parsed by `telegramProvider`).

### 5.3 Attachments & safe formatting (E5, E6)

- New `src/notifications/attachments.js` — a transport selector. Given an
  artifact `{path, kind, purpose}` it chooses, in priority order:
  1. **Telegram document** (`sendDocument`) for a real file within limits.
  2. **Rendered/monospace preview** for short text/markdown (fenced, so no
     accidental linkifying).
  3. **Git diff / patch** for code changes.
  4. **ZIP bundle** for multi-file sets.
  5. **Filesystem location, non-hyperlinked**, only if nothing else works.
- **Fix E5 now:** all Telegram sends use a deliberate format (MarkdownV2 or
  HTML with proper escaping, or plain text with entities suppressed) so
  `README.md` and Windows paths are never auto-linked. A small escaping
  helper with unit tests covers the ccTLD-filename and path cases
  explicitly.
- Telegram channel + approval provider both gain `sendDocument`; the 50 MB
  bot document limit is enforced with a graceful fallback to preview/ZIP.
- **PDF export** (master prompt's "executive report"): evaluated but
  **deferred within M2 to a stretch** — a dependency-free PDF is heavy and
  real document attachment already removes the dead-link problem. If pursued
  it becomes its own commit with a justified, audited dependency; otherwise
  reports attach as Markdown documents + a text card. Flagged as a decision
  point, not a silent drop.

### 5.4 Tests / docs / commits

- **Tests:** approval-reuse (resume does not create a second request —
  integration against a fake store + orchestrator); idempotency store
  (skip/allow matrix incl. reminder-elapsed, prior-failure, state-change);
  attachment selector (each branch); Telegram formatting escaping
  (`README.md`, `C:\path`, urls); mission-card builder (fields from
  fixtures); channel renderers; all existing notification/approval tests
  stay green.
- **Docs:** update `REMOTE_APPROVALS.md`, `TELEGRAM_SETUP.md`, `FAQ.md`,
  `CONFIGURATION.md` (new `reminderMs`, dedupe behaviour), CHANGELOG,
  ROADMAP; a "what a mission card looks like" example.
- **Commits:** (1) approval reuse; (2) notification idempotency store +
  engine wiring; (3) mission-card builder + payload enrichment + renderers;
  (4) attachments + safe formatting + `sendDocument`; (5) inline
  keyboards; (6) docs + version bump + tag.

### 5.5 Risks

- *Dedup dropping a real alert.* Mitigated by the fail-safe rule (§1) and an
  explicit "state changed ⇒ always send" branch; the test matrix asserts
  every legitimate resend still fires.
- *Telegram formatting escaping bugs* (MarkdownV2 is finicky). Mitigated by
  a dedicated escaping helper with adversarial unit tests and a live send to
  the real bot before tagging.
- *Mission-card data gaps* (a field unavailable for a given mission).
  Mitigated: every field is optional; the card degrades to what's known.

---

## 6. M3 — Doctor, recovery & operator guidance → `v2.6.0`

**Goal:** every failure tells the owner what happened, why, and the single
next command — and `doctor` can offer to fix what it flags.

### 6.1 Deliverables

- **Refactor `runDoctor` to structured findings.** Each check yields
  `{ id, status: ok|warn|fail, label, detail, cause, impact, fix? }` where
  `fix` is an optional `{ description, apply(), safe }`. The current inline
  printing becomes a renderer over the findings list — no check is lost.
- **`doctor --fix`** (11E). Read-only by default. With `--fix`, for each
  finding that has a `fix`, prints cause/impact/solution and asks to apply;
  safe automatic repairs (set `permissionMode`, create `config/local.json`,
  abandon a stale session) apply on confirmation; anything needing human
  steps launches the relevant M1 wizard. Approval-aware, never silent.
- **Remedy-first errors (11F).** Audit every `throw` that can reach the CLI;
  extend the existing `error.userFacing` pattern so each expected error is
  `cause · impact · fix`, stack suppressed. A catalogue in
  `src/infra/errors.js` keeps wording consistent.
- **Guided recovery.** When a mission blocks, print the exact
  `tasks approve <project> <id>` / `tasks skip …` with fields filled.
  `status` and `doctor` detect a stale resumable session and print the exact
  `sessions <project> --abandon`. Approval recovery: `approvals list` shows
  the exact reply/`approvals approve` line.

### 6.2 Tests / docs / commits

- **Tests:** findings builder returns the right status/fix per seeded
  condition; `--fix` apply functions mutate config correctly and are no-ops
  when already healthy; error catalogue renders remedy-first; guided-recovery
  strings include the correct filled-in command.
- **Docs:** rewrite `TROUBLESHOOTING.md` around "symptom → what doctor says
  → one command"; update `FAQ.md`, CHANGELOG, ROADMAP.
- **Commits:** (1) doctor findings refactor (behaviour-preserving); (2)
  `--fix`; (3) error catalogue + guided recovery; (4) docs + version + tag.

### 6.3 Risks

- *`--fix` making an unwanted change.* Mitigated by confirm-per-change,
  read-only default, and `safe` gating; nothing destructive is ever
  auto-applied.
- *Doctor refactor regressing output.* Mitigated by a golden-output test of
  the healthy path before refactoring.

---

## 7. M4 — UX consistency, remote polish & documentation → `v2.7.0`

Phase 11 "complete." Cross-cutting, done last so vocabulary is stable.

### 7.1 Deliverables

- **Terminology contract (11H).** One `src/shared/vocabulary.js` (or a doc +
  lint) defining canonical mission-lifecycle names, statuses, and icons;
  desktop, CLI, Telegram, email, and docs all reference it. Fix any drift
  found in the audit.
- **Startup banner (11G).** Concise: version, project, mode, enabled
  channels, "nothing will interrupt you except owner gates."
- **`notify tune` (11G, E10).** Interactive per-channel `minSeverity` so the
  phone only buzzes on what matters; writes `config/local.json`.
- **Remote progress visibility (11G/E11).** Opt-in: mission cards can carry
  current task · progress · elapsed · est. remaining · running agent · queue
  position · health, pulled from existing status/lifecycle — surfaced on
  request (`status` reply command) rather than pushed as noise.
- **Product polish (11J).** Better defaults, fewer prompts, remove friction
  found while walking M1–M3 live.
- **Documentation (11I).** Convert reference docs to teaching material for a
  reader who has never seen the system; ensure CLI ↔ docs ↔ desktop never
  contradict.

### 7.2 Tests / docs / commits

- **Tests:** vocabulary references resolve; `notify tune` writes correct
  `minSeverity`; banner renders expected fields; progress fields assemble
  from a status fixture.
- **Docs:** finalise `DAY_ONE.md`; a "glossary/vocabulary" page; refresh all
  affected guides; CHANGELOG, ROADMAP, PROJECT_CONTEXT; the **Phase 11
  report** + readiness assessment.
- **Commits:** (1) vocabulary + banner; (2) `notify tune` + remote progress;
  (3) polish; (4) docs + Phase 11 report + version + tag.

---

## 8. Cross-cutting strategies (summary)

- **Testing.** Per-module unit tests written with each feature; integration
  tests for the two behavioural fixes (approval reuse on resume; dedup
  across repeated events); the optional-collaborator invariant test rerun at
  every milestone; **live verification before each tag** (real wizard walk,
  real Telegram attachment + mission card on the actual bot, real
  `doctor --fix` on a broken config) — the 10.5 discipline that caught the
  livelock. Every fix that stems from a bug gets a regression test.
- **Documentation.** Docs move from reference to teaching; each milestone
  updates its guides in the same commit as the code (never a trailing "docs
  later"); manual setup steps survive as "by hand" appendices so nothing is
  removed, only demoted.
- **Commit strategy.** Small, single-concern commits; behaviour-preserving
  refactors land separately from behaviour changes; each milestone ends with
  a docs+version commit and an annotated tag; nothing is pushed (repo
  convention — owner pushes).
- **Versioning.** `v2.4.0` (M1) · `v2.5.0` (M2) · `v2.6.0` (M3) · `v2.7.0`
  (M4, Phase 11 complete). Annotated tags, per the existing scheme.
- **Backward compatibility.** New flags/subcommands/keys only; the invariant
  test guards the "no new keys ⇒ identical behaviour" contract each
  milestone.

---

## 9. Out of scope / explicitly deferred

- New notification providers (WhatsApp/Discord/Slack/push) — the
  abstraction is ready; not an onboarding/experience concern.
- Packaged desktop installer / Windows service mode — heavier than a UX
  phase.
- Within-mission parallel task batches, driver conformance kit,
  cross-machine aggregation — engine backlog.
- Dependency-heavy PDF generation — evaluated in M2; pursued only if a
  clean, audited dependency is justified, otherwise reports attach as
  Markdown documents.

---

## 10. Expected deliverables (whole phase)

- New `src/onboarding/` wizards; `src/notifications/{missionCard,
  attachments}.js` + idempotency store; `doctor` findings + `--fix`;
  `src/infra/errors.js` catalogue; shared vocabulary; `notify tune`.
- New CLI: `init`, `projects add --interactive`, `notify setup
  telegram|email`, `notify tune`, `doctor --fix`.
- Desktop + API updates where a surface applies (mission cards in the
  desktop notification/approvals views; approval-reuse reflected in the
  Approvals view).
- ~125 new tests; 436+18 existing stay green.
- Docs: `DAY_ONE.md` + glossary; rewritten `TROUBLESHOOTING.md`; updated
  QUICKSTART/README/TELEGRAM/EMAIL/REMOTE_APPROVALS/FAQ/CONFIGURATION/
  CHANGELOG/ROADMAP/PROJECT_CONTEXT; the **Phase 11 report** + readiness
  assessment.
- Four annotated tags (`v2.4.0`…`v2.7.0`).

---

## 11. Success criteria (and how each is verified)

1. A brand-new user reaches a first completed mission **and** a working
   phone approval **without hand-editing JSON** → walked end-to-end live via
   `init` + wizards (M1).
2. No duplicate approval/notification on resume, crash, or a polling tick →
   integration tests (E3/E4) + a live stop/resume on the real bot (M2).
3. A referenced artifact opens directly from the phone; no `README.md`
   dead-links, no meaningless Windows paths → live Telegram attachment +
   formatting tests (M2).
4. Notifications read like an executive brief → mission-card renderers +
   live sample (M2).
5. Every failure yields cause · impact · one next command; `doctor --fix`
   repairs what it flags → M3 tests + a live broken-config walk.
6. Consistent vocabulary across all surfaces; useful reports; confident
   operation without reading source → M4 audit + the Phase 11 report.

---

## 12. Locked decisions (owner-approved 2026-07-14)

1. **Milestone sequence & versioning: APPROVED** — M1→M4 shipped as four
   incremental minor releases (`v2.4.0` → `v2.7.0`), each live-verified
   before the next begins.
2. **M2 executive reports: Markdown + text card** — attach the real report
   as a Markdown document via `sendDocument` plus a formatted mission card.
   **No new dependency; PDF export is not pursued** in Phase 11.
3. **M1 wizard surface: CLI-first** — `init`, `projects add --interactive`,
   `notify setup telegram|email`, `notify tune` are CLI flows. Desktop
   onboarding parity is deferred beyond Phase 11.

Implementation begins at **M1, commit 1** (the prompts harness); progress is
reported at each commit/tag boundary.
