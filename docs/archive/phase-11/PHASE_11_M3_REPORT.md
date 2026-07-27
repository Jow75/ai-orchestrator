# Phase 11 M3 — Doctor, Recovery & Operator Guidance: Completion Report

**Date:** 2026-07-27 · **Version:** 2.6.0 · **Verdict:** COMPLETE, ready for M4

Per `docs/PHASE_11_PLAN.md` §6. No new architecture — the existing engine
and every prior guarantee (optional-collaborator invariant, supervision
behavior, backward compatibility) are untouched. Three commits, each small,
logical, and independently reviewable, followed by docs + the version tag.

---

## 1. Implementation summary

### `doctor` → structured findings + `--fix` (commit `3007856`)

`doctor` was an inline sequence of `console.log` calls with no return
value and nothing else could reuse its logic. It is now built from a
typed findings array:

```
{ id, status: 'ok'|'warn'|'fail', label, detail, cause?, impact?, fix? }
```

- **`buildDoctorFindings()`** (`src/doctor/doctor.js`) runs every check —
  Node version, global config, every project's validity/engine/write
  permissions, state-dir writability, notification channels, the running
  instance, the Windows auto-resume task — in the *same order and under
  the same conditions* as the pre-M3 doctor, including its early return
  when global config fails to load. This was verified, not assumed: a real
  `doctor` run before and after the refactor produced **identical output**
  for every existing check (see §4).
- **`renderDoctorFindings()`** is now the *only* place that prints —
  `doctor` and `doctor --fix` share it, so nothing is special-cased between
  the two modes.
- **`doctor --fix`**: read-only by default. With `--fix`, each finding that
  has a `fix` is explained (cause → impact → the repair) and confirmed
  individually — **every** fix is confirmed, "safe" only changes *what kind*
  of repair it is, never whether it's asked about. Safe, direct repairs
  (this process applies them itself): set `claude.permissionMode`, delete an
  already-useless quarantined corrupt file, install the auto-resume
  scheduled task. Fixes needing real human input (a bot token, a mailbox
  password, a first project) launch the matching Phase 11 M1 wizard
  instead — reusing work already built and validated, not duplicating it.
  The closing summary reports **recovered / skipped / manual-follow-up**
  counts — the three-way "recovery confidence" distinction requested.

### Two new findings (both evidence-based, neither invented)

1. **Quarantined corrupt state files.** `statePersistence.js`'s
   `readJsonSafe` already quarantines a damaged JSON file to
   `<file>.corrupt-<timestamp>` and falls back to defaults — this was
   already self-healing, just invisible outside the logs. `doctor` now
   surfaces it, with a safe delete fix.
2. **A resumable session nobody is currently supervising.** Deliberately
   informational, no auto-fix: continuing (`start`) vs. discarding
   (`sessions --abandon`) is a real operator decision, not something safe
   to automate. Both exact commands are printed.

### Remedy-first error catalogue (commit `5159f1d`)

Audited every `error.userFacing = true` throw reaching the CLI (5 sites,
confirmed by grep — not a guess) and rewired them through one new helper,
`userFacingError({cause, impact, fix})` (`src/infra/errors.js`), so every
expected error states what happened, why, and the fix in the same
consistent shape instead of five different hand-rolled message strings.
One of the five (`notify resend`'s unknown-id case) also gained a small
guided-recovery upgrade: it now points at `approvals list <project>` to
find a valid id, rather than just stating the id was wrong.

### Guided recovery in existing commands (same commit)

- **`tasks list`** now prints the exact `tasks approve <project> <id>` /
  `tasks skip <project> <id>` command when the current task is
  blocked/failed.
- **`approvals list`** now prints the exact reply grammar (or `DONE <id>`
  for a human-action request) plus the CLI equivalent, next to each
  *pending* request — matching `ApprovalManager`'s own wording, so the two
  surfaces never say it differently.

Both were extracted as small, pure, exported functions
(`taskRecoveryHint`/`approvalReplyHint`) rather than tested through a new
CLI/Commander harness — a deliberate choice matching this codebase's own
convention (confirmed: **zero** existing tests exercise `buildProgram()`
directly anywhere; behavior is always tested at the module level, and the
CLI stays a thin shell around it).

---

## 2. Bugs found

**None as functional defects during M3 itself.** M3 was a net-new-capability
milestone (making `doctor` fixable, consolidating error wording, adding
guided-recovery hints) rather than a fix-forward validation pass like M2 —
so the "bugs found" category here is empty by design, not by omission. The
one real finding — a genuine leftover quarantined corrupt file sitting in
this repo's own `state/` directory since a Phase 10.5 failure simulation —
was exactly what the new `doctor` check is *for*: not a bug in M3's code,
but a real, previously-invisible piece of state it correctly surfaced and
then correctly repaired.

## 3. Fixes applied

N/A in the "regression fix" sense — see §2. All work in M3 is additive
capability, not corrective.

---

## 4. Live validation performed

- **`doctor` output equivalence**: ran the real CLI against this repo
  before and after the refactor; every existing check line matched
  exactly (Node version, global config, all 4 real projects' validity/
  engine/permissions, state-dir writability, notification channels, the
  auto-resume task).
- **`doctor --fix` end-to-end, for real**: found a genuine quarantined file
  (`state/tasks/sim-reject.json.corrupt-1783961554038`, literal content
  `{ GARBAGE not json !!!` — confirmed as the deliberately-injected garbage
  from Phase 10.5's own corruption-containment test) via a real spawned
  CLI process, confirmed the fix (`y`), watched it delete the file, then
  re-ran plain `doctor` and confirmed zero warnings remained.
- **`tasks list` guided recovery**: created a throwaway mock-driver project
  with a task designed to fail verification, ran it to a real `blocked`
  state via the actual CLI, confirmed `tasks list` printed the exact
  `tasks approve`/`tasks skip` command with the real project/task ids
  filled in — then cleaned up every artifact.
- **`approvals list` guided recovery**: created real pending owner-gate and
  human-action requests via `ApprovalStore`, confirmed the correct reply
  grammar for each, and confirmed the hint correctly disappeared once a
  request was resolved.

## 5. Regression coverage

**+29 tests** across 4 new/updated files:

| File | Tests | Covers |
|---|---|---|
| `test/doctor.test.js` | 18 | Golden healthy-path (only `ok` findings), early-return on bad config, per-project isolation of one bad project, both write-permission fix paths, telegram/email-incomplete + wizard fixes, both new guided-recovery findings, fix-application error handling, the renderer's exact marks/format (incl. the preserved `running-instance` special case) |
| `test/errors.test.js` | 4 | `userFacingError`'s cause/impact/fix combination rules |
| `test/cli.guidedRecovery.test.js` | 7 | `taskRecoveryHint`/`approvalReplyHint`'s every branch |

**Backend suite: 585/585 passing** (556 pre-M3 + 29 new) **+ 18 desktop**,
all green at every commit.

## 6. Remaining limitations

- `doctor --fix` still requires an interactive terminal (uses the same
  `prompts.js` harness as the M1 wizards) — no `--yes`/non-interactive
  auto-apply mode exists. Not requested by the plan or the operator;
  flagged here rather than silently decided.
- The "resumable session, no supervisor" finding is intentionally
  informational only (no `fix`) — continuing vs. discarding is a real
  operator judgment call this phase does not attempt to automate.
- No new findings were added for "crashed workers" (an orphaned agent
  subprocess with a dead orchestrator parent) — investigated during
  planning and set aside as unproven by real usage within this project's
  own history; a candidate for a future evidence-based pass if it's ever
  actually observed.

## 7. Readiness assessment

| Dimension | Verdict |
|---|---|
| Behavior preservation | **Verified** — `doctor`'s pre-M3 output reproduced exactly |
| `--fix` safety | **Verified** — every fix confirmed individually; live-tested against a real, previously-unknown issue in this repo |
| Error consistency | **Verified** — all 5 existing user-facing throws now share one wording contract |
| Guided recovery | **Verified live** — both new hints tested against real blocked-task and pending-approval state |
| Regression risk | **Low** — 585/585 + 18/18 green; no architecture changed |

**Phase 11 M3 is complete.**

## 8. Recommendation

Proceed to **Phase 11 M4 — UX consistency, remote polish & documentation**
(`docs/PHASE_11_PLAN.md` §7): a shared terminology contract across CLI/
desktop/Telegram/email, a startup banner, interactive `notify tune`, and
the final Phase 11 report. This is the last milestone in the Phase 11 arc
— M4 ships as `v2.7.0`.
