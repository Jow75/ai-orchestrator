# FAQ

**Q: I'm setting this up for the first time — where do I start?**
`node bin\ai-orchestrator.js init` — one guided command that creates a
project, connects your phone (Telegram/email), offers the auto-resume
task, and can start your first mission, all without hand-editing a JSON
file. See [DAY_ONE.md](DAY_ONE.md). Prefer to do it by hand? See
QUICKSTART.md instead — every wizard just writes the same config an
expert would.

**Q: Where do I start the whole thing from?**
The repo root: `node bin\ai-orchestrator.js start <project>`, or
double-click `START_AI.bat`. The desktop app (`cd desktop && npm start`)
can also start missions. There is no background service — nothing runs
until you (or the boot task / a schedule) start it.

**Q: How do I know it's running?**
`ai-orchestrator status`, the desktop's Live/Idle badge, or look at
`status.json` in the repo root (refreshed every 5 s while running).

**Q: How do I stop it? Will I lose progress?**
`ai-orchestrator stop` (or the desktop Stop button). Never any loss: the
session is preserved and the next `start` resumes the same conversation.

**Q: It's been silent for hours — is it stuck?**
Probably not. The orchestrator never interrupts a living process — check
`status` for `Last output` and child PIDs. If you're sure it's stuck,
`stop` then `start` resumes it fresh from the same conversation.

**Q: Why does it keep relaunching the agent after every run?**
A clean exit *without* the completion marker means "unfinished — continue."
Ensure the prompt demands the exact text `MISSION COMPLETE` only at the
true end (or use tasks + verifiers instead of a marker).

**Q: The mission stopped itself and says "blocked". Now what?**
Read `state\diagnostics\<project>-<ts>.md` — it names the failing checks
or the no-progress pattern and the fix. Then `tasks approve` (retry) or
`tasks skip` (move on), or fix the config and `start` again. Blocked
sessions are never auto-resumed — that's the loop-prevention working.

**Q: Claude does nothing and every run "accomplishes nothing" — why?**
Almost always missing permissions: headless Claude auto-denies writes
without `claude.permissionMode: "acceptEdits"` (or allowedTools /
dangerouslySkipPermissions) in the project JSON. As of v2.3.1
`projects add` sets `permissionMode: "acceptEdits"` for you, and `doctor`
warns about any claude project still missing it — but double-check the
block is there if you hand-wrote the config.

**Q: How do I test my notification setup without running a mission?**
`ai-orchestrator notify test` — it sends a real message through every
enabled channel and prints ✔/✘ for each. `doctor` also lists the enabled
channels.

**Q: My phone buzzes on everything — can I quiet it down?**
`ai-orchestrator notify tune` (Phase 11 M4) — pick a channel, pick a
minimum severity (`info`/`warning`/`critical`), done. A channel with no
severity set of its own falls back to the global `notifications.minSeverity`.

**Q: Where do my SMTP password / bot token go? Won't they get committed?**
Put them in `config/local.json` — it is git-ignored and merged over
`config/orchestrator.json` at load, so secrets never touch a tracked file.
See CONFIGURATION.md → "config/local.json".

**Q: How do I approve things from my phone?**
Set up Telegram ([TELEGRAM_SETUP.md](TELEGRAM_SETUP.md)) — reply
`APPROVE A7` to the bot. Email is receive-only. There is no
WhatsApp/Discord/Slack/push provider yet (the interface exists; each is
"one subclass" of future work).

**Q: I got two Telegram messages for the same approval — is that a bug?**
It was, and it's fixed (Phase 11 M2). Two distinct causes: (1) a stop/resume
or crash recovery re-entering a still-pending gate used to mint a fresh
request and re-announce it — it now reuses the same request instead; (2)
having both `notifications.telegram.enabled` and
`approvals.providers.telegram.enabled` on (a common setup) used to send the
provider's message AND the notification channel's near-identical copy —
the channel now auto-skips approval events its own provider already
delivers. If you still see this, check `config/orchestrator.json`'s
`notifications.telegram.excludeEvents` hasn't been overridden to remove
the auto-exclusion.

**Q: Why did README.md show up as a link on my phone?**
Fixed (Phase 11 M2) — it was a real bug: Telegram sent messages with no
`parse_mode`, so its own auto-linkification ran unrestricted, and `.md`
happens to also be a country-code domain (Moldova). Filenames now render
as inline code, never a link; a real file (a diagnostic report, release
notes) is attached directly instead of merely named.

**Q: Can it run several projects at once?**
Yes: `start projA projB` — one process, one orchestrator per project,
cross-mission resource locks (`resources` on tasks). The desktop starts
one at a time; use the CLI for parallel.

**Q: Does it push to GitHub / deploy anything by itself?**
No. `release apply` commits and tags locally and *never pushes*; deploys
belong in owner-gate approval categories. The final outward step is
always yours.

**Q: What does it cost to test the pipeline?**
Nothing: set `"driver": "mock"` in a scratch project — the whole
supervision pipeline (waits, resumes, verification, approvals,
notifications) runs against a scripted fake engine.

**Q: Where does my API key / login for Claude live?**
The orchestrator doesn't manage Claude auth at all — it spawns the same
`claude` CLI you use, with whatever login/subscription that CLI already
has. `doctor` confirms the CLI is reachable.

**Q: What if the PC reboots mid-mission?**
Install the auto-resume task once: `ai-orchestrator scheduler install`.
After logon, `resume` continues the interrupted session (30 s delay).
Without logon, Windows must auto-logon or the task must be converted to
"run whether user is logged on or not" in `taskschd.msc`.

**Q: A project shows `[active: waiting-retry]` from an old run I don't
want to resume — how do I clear it?**
`ai-orchestrator sessions <project> --abandon` archives the stale session
without launching anything, so the next `start` begins the mission fresh.
(It refuses if an orchestrator is actively supervising that project — use
`stop` there.)

**Q: Is the HTTP API safe to expose?**
It binds to `127.0.0.1` only. Reads are open; every mutation needs the
local bearer token (`ai-orchestrator api-token`). Don't port-forward it
raw; use a VPN/tunnel if you need remote HTTP.

**Q: Something is wrong and I can't tell what.**
1) `doctor`. 2) `logs\orchestrator-<today>.log` — every decision is
logged with its reasoning. 3) [../TROUBLESHOOTING.md](../TROUBLESHOOTING.md).

**Q: Can `doctor` fix things for me, or just tell me what's wrong?**
Both, if you ask: plain `doctor` is read-only. `doctor --fix` (Phase 11 M3)
walks every flagged issue, explains its cause and impact, and offers a
repair — a safe, direct change (e.g. setting `claude.permissionMode`,
deleting an already-useless quarantined corrupt file) applies once you
confirm it; anything needing real input (a bot token, a mailbox password)
launches the matching setup wizard instead. Nothing changes without you
saying yes to each one, and it tells you clearly at the end how many were
actually fixed vs. still need you.
