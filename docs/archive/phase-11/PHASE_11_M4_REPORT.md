# Phase 11 M4 — UX Consistency, Remote Polish & Documentation: Completion Report

**Date:** 2026-07-27 · **Version:** 2.7.0 · **Verdict:** COMPLETE — **Phase 11 done**

Per `docs/PHASE_11_PLAN.md` §7, refocused per the owner's explicit M4 brief:
prioritize consistency, clarity, and operator confidence over new platform
capabilities. Three commits (`5d8c10b`, `1928447`, `615bec0`), each small,
logical, and independently reviewable, followed by this report + the version
tag.

This document also serves as the **final Phase 11 retrospective** requested
alongside M4's own results — see §8–§10.

---

## 1. Implementation summary

### Shared terminology contract (commit `5d8c10b`)

A terminology audit across the CLI, `notificationEngine.js`, and
`missionCard.js` found **real, confirmed drift**: the identical "mission
succeeded" outcome rendered as **three different icons** depending which
surface you were looking at — the CLI's `start` command printed a plain
checkmark (✔), the notification-title builder printed a party emoji (🎉),
and Mission Cards printed a green-check emoji (✅). An `approval:resolved`
notification title also interpolated the raw status string
(`Approval approved — project`) inconsistently with how every other surface
phrased a decision.

New `src/shared/vocabulary.js` is now the single source for:
- **Outcome icon/label** (`complete`/`blocked`/`cancelled`/`failed`/
  `incomplete`) — `missionCard.js`, `notificationEngine.js`, `cli/index.js`,
  and `onboarding/init.js` all read from it now. The fix: every surface
  agrees on ✅ for success (was ✔/🎉/✅ — now all three call
  `outcomeIcon('complete')`).
- **Decision label** (approved/rejected/modified/done/…) for approval
  notification titles.
- **Confidence label** (verified/partial/unverified) for Mission Cards.
- **Check mark** (ok/warn/fail) — `doctor.js`'s findings renderer, `notify
  test`'s per-channel result, `release apply`'s step marks, and `doctor
  --fix`'s "Recovered" mark all now read the same ✔/⚠/✘ from one place
  instead of four separate inline literals.

Also fixed in the same pass: the running **version** was hardcoded
separately in `package.json`, the CLI's `.version()` call, and
`statusManager.js`'s status snapshot — kept in sync by hand at every prior
release. New `src/infra/version.js` reads `package.json` once; both other
call sites now import it, so a version bump is one line, not three (this
report's own release is the first to exercise that: only `package.json` was
edited, see §6). And `REPORT_AVAILABLE_NOTE` (the line appended when a
diagnostic report/release notes exist) was reworded — the original text
("attached separately") was itself inaccurate for a channel with no
`sendDocument` support (email has none), asserting an attachment that would
never actually arrive for that channel.

### Startup banner + `notify tune` + CLI wiring (commit `1928447`)

- **New `src/cli/banner.js`**: prints once, before the log stream starts,
  when `start` launches — version, project(s), the *resolved* approval mode
  (per-project override honored via the existing `effectiveApprovalConfig`),
  and which notification channels are actually enabled. Purely
  informational and defensive: an unresolvable project name is swallowed
  (never blocks a real mission from starting) since this is cosmetic, not a
  gate.
- **New `notify tune`**: interactive per-channel `minSeverity` setting. The
  config key has existed since Phase 10F (E10) but only via hand-edited
  JSON — this is onboarding polish on an *existing* capability, reusing the
  exact M1 pattern (`prompts.js` + `ConfigManager.writeLocalConfig`) rather
  than introducing anything architecturally new.
- The CLI's own icon literals (start-command marks, `notify test`,
  `release apply`, `doctor --fix`) were rewired to the shared vocabulary
  module from commit `5d8c10b` — the actual fix landed here since it's all
  in `cli/index.js`.

### Cross-product consistency audit (commit `615bec0`)

Walked the full operator journey end to end — install → `init` → `doctor` →
create project → notifications → approvals → mission lifecycle → recovery
→ shutdown → resume — across every user-facing surface (CLI, desktop,
Telegram, email, and every doc the owner named). Two categories of finding:

1. **A real bug, not just stale docs.** The desktop app's in-app "create
   project" (`orchestratorBridge.js`'s `createProject()`) never set
   `claude.permissionMode` — unlike the CLI's `projects add`, which has
   defaulted it to `"acceptEdits"` since Phase 10.5/11 M1. An unattended
   headless engine cannot answer permission prompts, so a project created
   from the desktop app would silently accomplish nothing on its first real
   mission — **the exact "no-progress" new-user trap the CLI path was
   already fixed for**, just never ported to the desktop's own creation
   path. Fixed to match the CLI exactly; +2 regression tests pin it.
2. **Documentation gaps**, all fixed:
   - `docs/CLI_GUIDE.md` — billed as "every command," but was missing
     `init`, the entire `notify` command group (test/setup/tune/resend),
     `doctor --fix`, and `projects add --interactive` entirely, plus a
     stale instruction to hand-edit `claude.permissionMode` after
     `projects add` (automatic since 10.5).
   - `README.md`'s command table was frozen at a pre-Phase-10 state —
     missing `init`, `notify`, `approvals`, `lifecycle`, `schedules`,
     `doctor --fix`; expanded and now points to `CLI_GUIDE.md` for the full
     reference.
   - `docs/FAQ.md` had no entry at all for `init` (the flagship M1 command)
     or `notify tune`; both added.
   - `TROUBLESHOOTING.md`, `docs/TELEGRAM_SETUP.md`, `docs/DAY_ONE.md`,
     `CONFIGURATION.md`: added `notify tune`/`doctor --fix` pointers
     alongside the existing manual instructions, so the wizard is always
     offered next to the hand-edit route, never only the hand-edit route.

---

## 2. Usability improvements

- **One consistent success/blocked icon everywhere** a mission outcome is
  shown to a human — CLI, desktop-visible notification titles, Telegram,
  email, Mission Cards.
- **`notify tune`** removes the last remaining "must hand-edit JSON" gap in
  the notification-tuning path highlighted by the original evidence base
  (E10) — an operator can now quiet a noisy channel in three prompts.
- **The startup banner** answers, before any log line scrolls past, the
  question a returning operator actually has: *which* project, under
  *which* approval mode, reaching *which* channels. Confirmed live (see §4)
  against a real multi-channel configuration.
- **A newcomer following `CLI_GUIDE.md` or `README.md` no longer hits a
  wall of undocumented commands** — `init`, `notify setup/tune`, `doctor
  --fix`, and `projects add --interactive` (all real, all shipped in prior
  milestones) are now where a "every command" reference and the top-level
  README both said they'd be.
- **Desktop-created projects now work unattended on the first real
  mission**, exactly like CLI-created ones — previously the single most
  likely way a desktop-only user would silently hit the "no progress"
  breaker on their very first run.

---

## 3. Documentation audit

Audited: `README.md`, `docs/QUICKSTART.md`, `docs/DAY_ONE.md`,
`docs/CLI_GUIDE.md`, `docs/DESKTOP_GUIDE.md`, `docs/FAQ.md`,
`TROUBLESHOOTING.md`, `CONFIGURATION.md`, `ROADMAP.md`,
`docs/TELEGRAM_SETUP.md`. Also spot-checked `ARCHITECTURE.md`, `API.md`,
`INSTALL.md` for hardcoded version numbers or command lists (none found —
no changes needed there).

| Doc | Finding | Fix |
| --- | --- | --- |
| `docs/CLI_GUIDE.md` | Missing `init`, `notify` group, `doctor --fix`, `projects add --interactive`; one stale instruction | All four gaps closed; stale instruction corrected |
| `README.md` | Command table frozen pre-Phase-10 | Expanded; now points to CLI_GUIDE.md; Documentation table lists DAY_ONE.md/CLI_GUIDE.md explicitly |
| `docs/FAQ.md` | No `init` or `notify tune` entries | Both added |
| `docs/DESKTOP_GUIDE.md` | Stale + (it turned out) **factually wrong** instruction to manually add `permissionMode` after in-app project creation | Corrected to match the actual (now fixed) behavior |
| `TROUBLESHOOTING.md` | No entry for tuning notification noise | Added, pointing at `notify tune` |
| `docs/TELEGRAM_SETUP.md` | Only documented the hand-edit `minSeverity` route | Added a `notify tune` pointer alongside it |
| `docs/DAY_ONE.md` | `doctor` step didn't mention `--fix` | One-line addition |
| `CONFIGURATION.md` | `minSeverity` section didn't mention `notify tune` | One-line addition |
| `docs/QUICKSTART.md` | Reviewed — already accurate and current | No change needed |
| `ROADMAP.md` | Missing the v2.7.0/M4 row | Added (this commit's finalization step) |

No duplicated instructions were found and removed beyond the ones listed
above (the codebase's docs already follow a "wizard is demoted to an
appendix, never deleted" convention from M1 onward, so there was little
redundant prose to begin with — the gaps were *omissions*, not
duplication).

A formal glossary page (considered per the original `PHASE_11_PLAN.md`
§7 wording) was evaluated and **not built**: mission-lifecycle states are
already defined once in `ROADMAP.md`'s P2/10D sections and approval classes
once in `CONFIGURATION.md`; DAY_ONE.md's existing "mental model" section
already serves the newcomer-glossary purpose. A separate page would
duplicate rather than consolidate — the owner's own M4 brief asked to
*remove* duplicated instructions, not add a new one.

---

## 4. Live validation performed

- **`doctor`** — ran before and after every M4 change; output unchanged
  (still 4 real projects, all ✔) except reading from the centralized
  vocabulary/version modules — confirmed behavior-preserving.
- **`notify test`** — ran for real against the actual configured desktop/
  Telegram/email channels; all three ✔, confirming the centralized
  `checkMark` wiring works end to end.
- **Real Telegram sends** — constructed real `mission:complete` and
  `mission:blocked` notifications through `NotificationEngine` against the
  actual bot/chat id and sent them for real, then independently re-derived
  the exact title/message text via a fake-channel capture to confirm: the
  title icon is now ✅ (was 🎉), and the attachment note reads accurately
  regardless of the receiving channel's capabilities.
- **Startup banner** — rendered directly against the real `config/` for an
  actual configured project (`THE FINISHER`), confirming correct version,
  project, mode, and channel list.
- **A full real end-to-end mission** — created a throwaway `mock`-driver
  project, ran `ai-orchestrator start` as a real child process (not a unit
  test), and watched the banner print, the mission complete, and the CLI's
  own final line read `✅ Mission complete: completion marker found` — the
  three-icons-into-one fix confirmed in an actual running process, not just
  unit tests. Every artifact (project file, lifecycle/ledger/session-history
  state) was then deleted; `doctor` re-confirmed exactly the 4 real projects
  remained.
- **`notify tune`** — validated via its automated test suite (4 cases,
  using the same dependency-injected `ask()` harness every other wizard in
  this codebase is tested with). A live run through a **real, piped**
  (non-TTY) stdin was attempted and surfaced a **pre-existing** limitation
  of `onboarding/prompts.js`'s `createPrompter()`: a second sequential
  `question()` call can silently miss a 'line' event from fully-buffered
  piped input (a well-known Node `readline` race, not specific to this
  feature). This is not a regression — every other multi-question wizard
  in this codebase (`runTelegramSetup`, `runEmailSetup`, `projects add
  --interactive`) shares the identical harness and would exhibit the same
  behavior under piped input; all of them are, and always have been,
  validated live via a **real interactive terminal** (a human typing
  answers), which is unaffected — confirmed during M1's own live
  walkthrough. See §6.
- **Desktop `createProject` fix** — validated via its 2 new automated tests
  (real `ConfigManager`/`saveProject` over a temp root, asserting the
  written JSON) rather than a live Electron session, matching this test
  file's own established convention (every other bridge method is tested
  the same way; Electron itself is never loaded in this test file by
  design).

---

## 5. Regression results

**+31 tests** across 5 new/updated files:

| File | Tests | Covers |
| --- | --- | --- |
| `test/vocabulary.test.js` | 6 | Every outcome/decision/confidence/check-mark lookup, incl. graceful fallback for unknown keys |
| `test/version.test.js` | 1 | `VERSION` matches `package.json` exactly |
| `test/banner.test.js` | 10 | Project resolution/fallback, per-project mode override, multi-project mode display, approvals-disabled wording, channel listing, cosmetic-never-throws guarantee, renderer formatting |
| `test/onboarding.notifyWizard.test.js` (+4) | 4 | `notify tune`: nothing-to-tune, sets + preserves other fields, filters to enabled channels only, Enter-accepts-current-default |
| `desktop/test/orchestratorBridge.test.js` (+2) | 2 | `createProject()` now sets `claude.permissionMode` for a `claude` driver; leaves it unset for a non-claude driver |

**Backend suite: 608/608 passing** (585 pre-M4 + 23 new backend tests)
**+ 20/20 desktop** (18 pre-M4 + 2 new), all green at every commit.

---

## 6. Remaining known limitations

- **Piped/non-interactive automation of any multi-question onboarding
  wizard** (`init`, `projects add --interactive`, `notify setup`, `notify
  tune`) can silently drop an answer past the first question, due to a
  `readline`-under-piped-stdin race in the shared `createPrompter()`
  harness. Real interactive use (a human at a terminal) is unaffected —
  the only usage this harness was ever designed and validated for.
  Fixing piped-input automation would mean redesigning the prompt harness
  itself (e.g. reading all lines upfront rather than sequential
  `question()` calls) — an architecture change with no supporting evidence
  of real demand (nobody scripts these wizards non-interactively in
  practice), so it is flagged here rather than attempted speculatively.
- **`notify tune` has no non-interactive form** (no `--channel`/
  `--severity` flags) — deliberately matches every other M1/M3 wizard's
  interactive-only design; add flags only if a real scripting need
  surfaces.
- **No new "remote progress on request" feature** (a `status`-reply
  command mid-mission) was built, despite being sketched in the original
  `PHASE_11_PLAN.md` §7. Evaluated and set aside: it would be a genuinely
  new platform capability — a new inbound command type wired through the
  Telegram poller regardless of pending-approval state — and the owner's
  own M4 brief explicitly asked to prioritize consistency/polish over new
  capabilities. No M1–M3 validation session ever surfaced "I couldn't check
  status remotely" as a real friction point. Candidate for a future,
  evidence-based pass.
- **The desktop's in-app project creation is still legacy (single-prompt)
  only** — task-plan (mission-mode) project creation remains CLI/JSON-only,
  unchanged from Phase 8. Not touched in M4 (out of scope; the fix here was
  parity on the *existing* creation path, not expanding its scope).

---

## 7. Readiness assessment (M4 itself)

| Dimension | Verdict |
| --- | --- |
| Terminology consistency | **Verified** — one icon per outcome across CLI/notifications/Mission Cards, confirmed live on the real bot and in a real running mission |
| Version-source consistency | **Verified** — one literal (`package.json`) now backs all three surfaces |
| Startup banner | **Verified live** — rendered correctly against real config and in a real `start` run |
| `notify tune` | **Verified via automated tests**; live-TTY validation inherited from M1's proven harness, not independently re-run (see §6) |
| Cross-product consistency | **Verified** — full operator-journey walk found and fixed one real bug (desktop/CLI parity) plus 8 documentation gaps |
| Regression risk | **Low** — 608/608 + 20/20 green; no architecture changed; every icon/wording change is presentation-only |

**Phase 11 M4 is complete.**

---

## 8. Final Phase 11 retrospective

Phase 11 shipped in four incremental, independently-tagged milestones, each
live-validated before the next began — exactly the sequence approved in
`docs/PHASE_11_PLAN.md` §12:

| Milestone | Tag | Theme |
| --- | --- | --- |
| M1 | `v2.4.0` | Onboarding & first-run: `init`, `projects add --interactive`, `notify setup telegram\|email` |
| M2 | `v2.5.0` → `v2.5.1` | Phone & notification experience: dedup fixes, Mission Cards, safe Telegram formatting, real attachments — then a dedicated Operational Validation pass against the real bot and real missions, which found and fixed 2 more real bugs |
| M3 | `v2.6.0` | Doctor, recovery & guidance: `doctor --fix`, a remedy-first error catalogue, guided recovery hints |
| M4 | `v2.7.0` | UX consistency & polish: shared terminology, one version source, startup banner, `notify tune`, a full cross-product consistency audit |

**What held across all four milestones:**

- **Evidence before assumptions.** Every fix in every milestone traces to
  either a live-validation finding or a directly observed code-level defect
  (the E1–E11 evidence base in `PHASE_11_PLAN.md`, plus what M2/M3
  validation and this M4 audit each turned up independently). Nothing was
  spot-built on a guess.
- **Root-cause fixes, not symptom patches.** The clearest examples: E3's
  duplicate-approval bug was fixed by reusing a pending request, not by
  suppressing the second notification; the desktop `createProject` gap
  found in M4 was fixed at its source (the bridge method itself), not
  papered over in the docs alone (the docs fix came *in addition to*, not
  *instead of*, the code fix).
- **Full backward compatibility.** The optional-collaborator invariant
  (no Phase 10/11 config ⇒ byte-for-byte pre-existing behavior) was never
  touched across all four milestones; every new command and config key was
  additive.
- **No unnecessary architecture.** M4 in particular deliberately declined
  two speculative features (a non-interactive wizard mode, a remote
  "status" push command) in favor of consistency work the owner explicitly
  prioritized.
- **Live validation over theoretical correctness**, every milestone: M1's
  real walkthrough surfaced the feedback that shaped M2; M2's dedicated
  Operational Validation session (a first for this project) caught 2 bugs
  unit tests missed; M3's `doctor --fix` was proven against a genuine
  leftover corrupt file already sitting in this repo; M4's audit found a
  real desktop bug specifically *because* the audit insisted on reading
  actual code paths, not just doc prose.
- **Commit and test discipline.** Every milestone landed as small, single-
  concern commits, each with its own tests, ending in a docs+version commit
  and an annotated tag. Test count grew from 436 (pre-Phase-11) to **608
  backend + 20 desktop**, and the suite was green at every single commit
  along the way — never once red between milestones.

**What Phase 11 changed about the product**, end to end: a brand-new
operator now reaches a working project and a working phone approval without
touching a JSON file (M1); the phone experience reads like an executive
brief with no duplicate pings and no dead-link filenames (M2); every
failure states cause/impact/fix and `doctor --fix` repairs what it safely
can (M3); and every surface — CLI, desktop, Telegram, email, and the docs
themselves — now agree with each other on wording, icons, and which
commands exist (M4).

---

## 9. Overall product readiness assessment

| Dimension | Verdict |
| --- | --- |
| Core supervision engine (P0–P7) | **Stable** — unchanged and untouched through all of Phase 11; 436 tests from before this phase still pass unmodified |
| Autonomous project management (Phase 10) | **Stable** — approvals, lifecycle, intelligence, scheduling, coordination, releases all exercised live in 10.5 and again through Phase 11's own validation passes |
| Onboarding experience | **Strong** — a new user's full path (`init` → first mission → first phone approval) is wizard-driven, live-validated, and now consistently documented |
| Remote/phone operation | **Strong** — real bot, real attachments, real dedup, real Mission Cards, real severity tuning, all confirmed against production credentials |
| Operational reliability | **Strong** — `doctor --fix`, guided recovery, and remedy-first errors mean most self-inflicted problems are self-diagnosing |
| Cross-surface consistency | **Strong, newly verified** — this milestone's specific contribution; previously unaudited as a *whole* |
| Known gaps | Documented plainly throughout (see each milestone's own "remaining limitations"): no non-TTY wizard automation, no remote on-demand status push, single-project-at-a-time desktop UI, Windows-only auto-resume, no packaged installer |

**Overall: Phase 11 delivers a polished, production-quality operator
experience on top of the already-proven Phase 0–10 engine**, exactly the
goal stated when Phase 11 began.

---

## 10. Recommendation for Phase 12

Nothing in this report identifies an urgent defect or an unfinished Phase
11 obligation — every milestone's own "remaining limitations" section is a
deliberate, documented scope boundary, not a gap discovered too late to
close.

**Recommendation: let Phase 11 mature through real-world use before
committing to Phase 12's shape** — the same advice this project gave itself
after Phase 10 (`PROJECT_CONTEXT.md`, "What's next," 2026-07-13), which
proved out well: Phase 10.5's real-world maturation pass is exactly what
surfaced the E1–E11 evidence base Phase 11 was built from. Concretely:

1. Run the product as-is for real work for a while (this repo and/or THE
   FINISHER) — Phase 12 should be shaped by what actually goes wrong or
   feels missing, not by speculation.
2. When ready to plan Phase 12, the two items flagged-but-deferred across
   Phase 11 are the natural starting candidates *if* real usage validates
   them: a driver conformance kit / additional engines (Gemini, Codex,
   OpenCode — the `cli` driver already supports them, just unverified
   against the actual CLIs), and a packaged desktop installer. Neither is
   pre-approved scope — both need their own evidence pass first, per this
   project's own standing rule.

Nothing has been pushed to the remote — `v2.4.0` through `v2.7.0` are local
on `main`, exactly as after every prior milestone, awaiting the owner's own
push decision.
