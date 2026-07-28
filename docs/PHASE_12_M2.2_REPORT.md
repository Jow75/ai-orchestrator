# Phase 12 M2.2 — The Artifact Investigation, Closed; and a Command Menu

**Version:** `v2.11.0`
**Date:** 2026-07-28
**Predecessor:** [M2.1 — Residency, Honesty, and Ports](PHASE_12_M2.1_REPORT.md)

Two pieces of work, from the same live-operator session:

1. A demanded **full trace** of the mission that reported success over an empty
   workspace — no assumptions, every question answered from evidence — and the
   closing of the disclosure gaps that trace exposed.
2. **Automatic Telegram command registration**, so the owner sees a menu
   instead of memorizing a grammar.

---

## Part 1 — What actually happened to mission M4

The report asked for the complete execution path with no assumptions. Here it
is, reconstructed entirely from files this system wrote at the time.

### The trace

Mission **M4**, project **m2-validation**, requested from Telegram by `Jowgei`.
Every line below comes from `state/events/events.jsonl`, `state/operator/
missions.json`, `state/tasks/m2-validation.json` and
`state/approvals/m2-validation.json`.

| Time (UTC) | Event | Evidence |
| --- | --- | --- |
| 10:42:37 | `project.selected` m2-validation | `actor: telegram:Jowgei` |
| 10:43:47 | `mission.created` M4 | objective: *"Create a simple calculator desktop application with React and Electron."* |
| 10:45:17 | `mission.approved` M4 → `worker.started` | `pid: 33736` |
| 10:45:21 | `approval.required` **A28** | `implementation-review`, **4.7 s after start** |
| 10:46:07 | `approval.accepted` A28 | `by: Jowgei, via: telegram` |
| 10:46:21 | `mission.progress` → `executing` | |
| 10:46:28 | `worker.completed` | `code: 0` |
| 10:46:36 | `mission.completed` | `tasksDone: 1, tasksTotal: 1` |

Total elapsed: **79 seconds**, of which the "engine" accounted for two scripted
runs of 50 ms each.

### The six questions, answered

**Was the mission executed against a mock or validation driver?**
Mock. `config/projects/m2-validation.json` carried `"driver": "mock"`.
`status.json` recorded `"agent": {"driver": "mock"}` and
`"engineSessionId": "mock-session-100001"` — a fabricated id the mock driver
mints from its own fake pid.

**Did Claude actually receive the request?**
No. No Claude process was ever spawned. The mock driver is in-process: its
`launch()` pushes the prompt onto an array and replays a scripted string from
the project config. The prompt file was built correctly and completely —
`state/operator/prompts/m2-validation-M4.md` still exists and contains the real
objective and the plan-then-implement instructions — and it was never delivered
to an engine.

**Was code generated but never written?**
No. No code was generated. There was nothing to write.

**Was the workspace intentionally simulated?**
Yes. The project was configured as a fixture on purpose, so the operator path
(free text → mission request → approval → supervised worker → plan gate →
completion) could be exercised without spending engine credits.

**Was the completion notification emitted without artifacts?**
Yes, and the mechanism deserves naming. The completion notification did not
lie about anything it was told. The task's own checkpoint records:

```json
"filesTouched": [],
"verify": { "passed": true,
            "results": [{ "type": "marker", "passed": true,
                          "detail": "Completion marker found" }] },
"summary": "MISSION COMPLETE"
```

`filesTouched: []` — the truth was recorded. Nothing rendered it.

**Is this expected behaviour, or a genuine defect?**
**Both, and separating them is the whole answer.** The mock driver replaying a
fixture is expected — that is what a fixture is for. Every layer reporting what
it was told is expected. The defect was that **no surface disclosed it**, so
"expected behaviour" and "a real engine that silently failed" were rendered
identically on a phone.

### The single most damning artifact

The plan the owner approved from their phone, `A28`, reads in full:

```text
Objective: add the requested capability to the validation workspace
Estimated files changed: 3
Tasks:  • Create the module  • Add a test for it  • Update the README
Files:  payroll.js, test.js, README.md
```

The owner had asked for a **React and Electron calculator**. The plan they
approved proposed editing **`payroll.js`** — left over from an earlier fixture
scripted for a payroll dashboard. The plan text was canned, bore no relation to
the request, and the approval gate presented it as if it had been earned.

Nothing in the system was capable of noticing. That is the defect, stated
precisely.

### What v2.10.0 already fixed, and what it missed

The disclosure work shipped in M2.1 (`src/drivers/simulation.js`) is sound and
covers every **remote** surface: the `/projects` badge, `/status`, the mission
proposal, the implementation-review gate, and the Mission Card. It also fixed
two sub-defects, one of which affected real missions: the completion marker was
being counted as a passing verifier, producing *"Tests: 1/1 · Verified"* for
work nothing had checked.

Re-auditing every surface for this report found the fix had stopped at the
phone. **Five surfaces still said nothing**, and they are now closed:

| Surface | Was | Now |
| --- | --- | --- |
| `projects list` (CLI) | bare name | `🧪 SIMULATED` badge |
| `projects status` (CLI) | rendered the same record the phone gets, minus this field | badge **and** full notice |
| `/approvals` | no badge | badge per request |
| `/missions` | no badge | badge per request |
| `doctor` | silent | `warn` finding, with the remedy |

The CLI pair matters most. `printRegistryRecord` is the terminal twin of
`/status`; it was already handed `record.simulated` and was simply not printing
it. An owner standing at the machine — the person most likely to be debugging an
empty workspace — got strictly less than the phone.

`doctor` matters for a different reason: it is where an owner goes *after* a
mission "worked" and the workspace is empty. It now answers that question
directly instead of leaving them to read a project file.

### One deliberate non-change

`/approvals` and `/missions` derive the badge from the **live config**
(`ProjectRegistry.simulatedNames()`), not from the `simulated` flag frozen into
each stored record. A request raised while a project was a fixture, then pointed
at a real engine, must stop claiming to be a rehearsal — and the reverse.
Regression-tested in both directions.

Nothing was added to make a real mission *fail* when it writes no files.
Missions that legitimately produce no artifacts exist (investigations, reviews),
and turning "wrote nothing" into a failure would break them. The honest report —
`confidence: unverified`, plus *"Files changed: none — this mission completed
without writing anything"* — remains the right answer.

### Validated against a real engine

An investigation that ends in "the fixture was a fixture" is worth exactly as
much as the control that proves it. So the **identical objective** was run again
against a real engine, through the identical operator path:

- **Project:** `calculator-proof` — `"driver": "claude"`,
  `"permissionMode": "acceptEdits"`, an empty workspace containing one README.
- **Path:** `/project calculator-proof` → free text → **M8** → `APPROVE M8` →
  implementation review → approve → completion. The same seven steps M4 took.

**Result — mission M8, 13 m 13 s, complete.** The workspace now holds a real,
runnable application:

```text
.gitignore   electron/main.cjs   electron/preload.cjs   index.html
package.json   package-lock.json   vite.config.js
src/App.jsx   src/calculator.js   src/main.jsx   src/styles.css
test/calculator.test.js          dist/  node_modules/
```

`npm test` in that workspace: **16 passing** — the engine wrote its own tests
for chained operations, divide-by-zero, decimal handling, sign toggle, percent
and backspace, and they pass.

The decisive comparison is the single field the investigation turned on:

| | M4 (mock) | M8 (claude) |
| --- | --- | --- |
| `filesTouched` | `[]` | **12 files** |
| Plan at the gate | canned; proposed `payroll.js` | real; React, Electron, Vite, a pure engine |
| `details.simulated` | *(absent — pre-fix)* | `false` |
| Engine time | 2 × 50 ms scripted | 13 minutes |
| Mission Card | *"Files changed: none"* | *"Files changed (12): …"* |

The Mission Card for M8, rendered from the real record:

```text
Mission: calculator-proof
Status: ✅ Complete
Duration: 13m 13s
Tasks: 1/1 done
Confidence: Unverified (no checks ran)
Files changed (12): .gitignore, electron/main.cjs, … +4 more
```

Note the confidence line. Twelve real files were written and the card still
says **Unverified**, because the operator mission declared no verifiers and the
completion marker is not evidence. That is the M2.1 honesty fix working on a
*real* mission, and it is the correct answer: the system knows what was written,
and it does not know whether it is right.

**The investigation is closed.** The original mission produced nothing because
the project behind it was a fixture, and the defect was that nothing said so.

### A defect this validation found

Parsing the first REAL plan exposed a bug that only a real engine could have
surfaced: engines write plans in **markdown**, and none of the section headings
matched. `**Objective:**` left its closing `**` glued to the text, so the
approval gate showed the owner:

```text
Objective: ** Deliver a real, runnable simple calculator…
```

Worse, `**Tasks (in order):**`, `**Files:**` and `**Risks:**` matched nothing, so
every bullet in the plan accumulated under whichever heading *had* matched —
producing eight "tasks", zero risks and zero files at the gate where the owner
decides. Fixed in `implementationSummary.js` with a bullet-safe emphasis
stripper (`* item` and `**bold**` both start with an asterisk, and collapsing
the first would turn every list item into a heading). Three regression tests,
including one that pins a value legitimately starting with `*`.


---

## Part 2 — Telegram command registration

**Request:** the system owns the bot token, so it should publish its own command
list via `setMyCommands` and let the owner see a menu instead of memorizing one.

### The rule

> **The menu is derived from the parser, never maintained beside it.**

`src/operator/commandMenu.js` reads `COMMANDS` from `commandGrammar.js` and
nothing else. A hand-kept list would drift, and drift here is worse than
absence: a menu offering `/deploy` teaches a command that will be refused, and
one omitting `/service` hides a command that works. The regression test asserts
set-equality between the published menu and the parser's own table, so adding a
command to the grammar adds it to every phone menu automatically.

All **16** commands are published: `/help`, `/projects`, `/project`, `/status`,
`/start`, `/stop`, `/tasks`, `/approvals`, `/missions`, `/service`, `/events`,
`/reset`, `/shutdown`, `/confirm`, `/cancel`, `/whoami` — the thirteen the
directive named, plus `/service`, `/confirm` and `/cancel`, which the grammar
also accepts.

### Three decisions worth stating

**Scoped to the owner's chat, not to the bot.** `BotCommandScopeChat`, not the
default global scope. The provider has dropped every message from any other chat
since Phase 10C, so a global menu would advertise a control surface to strangers
that the system then refuses — an invitation to probe, and a misleading one. The
menu now matches the permission: the one person who can use these commands is
the one person who can see them.

**Descriptions carry the argument, and the warning.** Tapping a menu entry
inserts the bare command, so `/project` shows `<name> — Select the active
project`; without the hint it is a button that does nothing. Destructive
commands append *"(asks you to confirm first)"* — `/shutdown` in a tappable list
is a button that stops the service, and an owner is entitled to know from the
menu that a second step exists.

**Published at three moments, none of them blocking.**

| Moment | Behaviour |
| --- | --- |
| `notify setup telegram` | The one instant the token is known good and the chat id known right |
| Every Core Service start | Compares against `getMyCommands` first; skips the write when already current |
| `notify commands` | On demand, with `--force` and `--dry-run` |

The daemon call is deliberately **not awaited**. The service owns this machine's
only inbound channel and must be listening whether or not `api.telegram.org` is
reachable in that second. A menu is a convenience; the inbound channel is not.

### Live validation

The Core Service was restarted and published the menu to the real bot
unprompted:

```json
{"message":"Command menu published","channel":"telegram","commands":16}
```

Read back from Telegram, scoped to the owner's chat:

```text
ok: true   count: 16
  /help        Show every command.
  /projects    Every project, with status, branch and health.
  /project     <name> — Select the active project. Later commands apply to it.
  …
  /shutdown    Stop the Core Service itself. … (asks you to confirm first)
  /whoami      Which project this conversation is currently pointed at.
```

Re-running `notify commands` correctly declined:

```text
✔ Telegram already shows all 16 commands — nothing to do.
```

---

## Verification

| | |
| --- | --- |
| Backend tests | **948 passing** (+29) |
| Desktop tests | 20 passing |
| Phase 12 Invariant | holds — standalone `start` is untouched |

New coverage: `test/commandMenu.test.js` (17), plus simulation-disclosure
regressions in `commandRouter`, `operatorRender`, `projectRegistry`, `doctor`,
and command-menu coverage in `onboarding.notifyWizard`.

---

## Files

**New**
- `src/operator/commandMenu.js` — the grammar, in Telegram's BotCommand shape
- `config/projects/calculator-proof.json` — the real-engine control project
- `test/commandMenu.test.js`

**Changed**
- `src/approvals/providers/telegramProvider.js` — `registerCommands`, `fetchRegisteredCommands`
- `src/operator/operatorGateway.js` — `publishCommandMenu`
- `src/daemon/daemon.js` — publish on start, unawaited
- `src/onboarding/notifyWizard.js` — publish during setup
- `src/cli/index.js` — `notify commands`; simulation badge in `projects list` / `projects status`
- `src/operator/projectRegistry.js` — `simulatedNames()`
- `src/operator/render.js` — badges in `/approvals` and `/missions`
- `src/operator/commandRouter.js` — supplies the simulated set
- `src/doctor/doctor.js` — simulated-project finding
