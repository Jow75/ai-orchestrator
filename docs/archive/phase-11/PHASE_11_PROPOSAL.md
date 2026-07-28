# Phase 11 — Onboarding & Operator Experience (Engineering Proposal)

**Status:** proposal only — no implementation. **Prereq:** Phase 10.5
complete (v2.3.1). **Theme:** reduce friction, do NOT add architectural
complexity.

Every item below is justified by something that actually cost time or
confused a new user during Phase 10.5. This is a UX phase: the engine is
already production-grade (see [PHASE_10.5_READINESS.md](../../PHASE_10.5_READINESS.md)).

---

## Guiding principle

> The engine is done. What's left is everything a human touches before the
> engine takes over.

Nothing in Phase 11 should change supervision behaviour. Wizards and
diagnostics WRITE the same config files an expert edits by hand; they never
become a required code path. The optional-collaborator invariant
(pre-Phase-10 configs behave byte-for-byte identically) must survive
Phase 11 untouched.

---

## Evidence → feature map

| Friction observed in 10.5 | Phase 11 response |
|---------------------------|-------------------|
| `projects add` created unwritable projects (fixed reactively in 10.5) | **Project creation wizard** that asks the questions and writes a correct, complete file |
| Telegram/email setup is a 7-step manual guide; chat-id discovery is fiddly | **Telegram & email onboarding wizards** that validate the token, discover the chat id by polling, send a test, and write `config/local.json` |
| Missing-engine error was a raw stack (fixed in 10.5) | **Better error messages** everywhere — audit every `throw` reaching the CLI |
| Two stale sessions confused project state (fixed with `--abandon`) | **Guided recovery**: `doctor`/status detect stale sessions and print the exact `--abandon`/`stop` command |
| `doctor` couldn't catch the write-permission trap (fixed in 10.5) | **Improved Doctor**: a `--fix` mode that offers to repair what it flags |
| Credentials risked landing in a tracked file (fixed with `local.json`) | **First-run setup wizard** that creates `config/local.json` from the start |
| Notification noise untuned (all channels, all events, `info`) | **Interactive notification tuning**: pick per-channel `minSeverity` |

---

## Workstreams

### 11A — First-run setup wizard (`ai-orchestrator init`)

A single guided flow for a brand-new install:

1. Check Node + the `claude` CLI (reuse `doctor`'s probes).
2. Offer to create the first project (delegates to 11B).
3. Offer to set up remote notifications (delegates to 11C/11D).
4. Offer to install the auto-resume task.
5. End with a live `notify test` and a one-line "you're ready" summary.

Idempotent and re-runnable; every step skippable. Writes only
`config/*.json` — no new runtime state.

### 11B — Project creation wizard (`projects add --interactive`)

Prompts for working directory (with existence check), prompt file vs.
task plan, engine, permission mode (defaulting to `acceptEdits` with the
risk explained inline), and allowed tools. Writes a complete, valid
project file and runs the project through `validateProject` before saving.
Removes the single biggest new-user failure at the source.

### 11C — Telegram onboarding wizard (`notify setup telegram`)

Automates the manual guide: prompt for the BotFather token → validate via
`getMe` → instruct the user to message the bot once → **poll `getUpdates`
until the chat id appears** (exactly the discovery this phase did by hand)
→ send a test message → write `notifications.telegram` +
`approvals.providers.telegram` into `config/local.json`. Pauses only for
the two unavoidable human steps (create the bot, press Start).

### 11D — Email onboarding wizard (`notify setup email`)

Prompt for provider/host/port/credentials (Gmail app-password path called
out explicitly) → send a real test email via `smtpClient.js` → on success
write `config/local.json`. Surfaces the common SMTP errors (535 auth, 465
vs 587) as plain-language fixes.

### 11E — Improved Doctor (`doctor --fix`)

Doctor already flags the write-permission gap, missing channels, and
incomplete channel config (added in 10.5). Phase 11 adds an opt-in
`--fix` that, for each flagged item, offers the concrete repair (set
`permissionMode`, abandon a stale session, run a setup wizard). Read-only
by default; every change confirmed.

### 11F — Guided recovery & better errors

- Audit every error that can reach the CLI; ensure each is a
  remedy-first, stack-free message (the pattern established for the
  missing-engine fix — flag `userFacing` on expected errors).
- When a mission blocks, print the two next commands (`tasks approve` /
  `tasks skip`) with the project/task already filled in.
- `status` surfaces a stale resumable session with the exact command to
  clear it.

### 11G — Startup & notification-tuning polish

- A concise startup banner: version, project, mode, enabled channels,
  "nothing will interrupt you except owner gates."
- Interactive `notify tune`: choose per-channel `minSeverity` so the phone
  only buzzes on what matters (the untuned-noise gap from 10.5).

### 11H — Documentation & new-user experience

- A single "Day 1" page that the wizards mirror, so CLI and docs never
  drift.
- Fold the now-manual setup guides into "if you'd rather do it by hand"
  appendices beneath each wizard.

---

## Explicitly OUT of scope (defer)

- New notification providers (WhatsApp/Discord/Slack/push) — architecture
  is ready; this is not an onboarding concern.
- Packaged desktop installer / Windows service mode — real, but heavier
  than a UX phase.
- Within-mission parallel task batches, driver conformance kit,
  cross-machine aggregation — engine backlog, not operator experience.

---

## Success criteria

A new user, on a clean machine, reaches their first completed mission
**and** a working phone approval **without hand-editing a single JSON
file** — using only `init` and the wizards it launches. Measured by
walking the flow end-to-end (the way 10.5 walked the manual flow), plus
regression tests proving every wizard writes config identical to what an
expert would write by hand, and that a config with no wizard-authored keys
still behaves byte-for-byte as before.

## Sequencing

11A/11B first (the create path is the most-trodden), then 11C/11D (remote
setup), then 11E/11F (diagnostics + errors), then 11G/11H (polish + docs).
Each cut as its own commit; the phase ships as `v2.4.0`.
