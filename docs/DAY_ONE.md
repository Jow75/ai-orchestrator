# Day One — from a fresh clone to your first phone approval

This is the shortest path in. One command sets everything up by asking you
questions — you never edit a JSON file by hand.

> Prefer to configure by hand? Every wizard just writes the same config an
> expert would. The manual routes are in [QUICKSTART.md](QUICKSTART.md),
> [TELEGRAM_SETUP.md](TELEGRAM_SETUP.md), and [EMAIL_SETUP.md](EMAIL_SETUP.md).

---

## 1. Install

```bat
cd C:\Users\Admin\Music\AI-Orchestrator
npm install
```

## 2. Run the guided setup

```bat
node bin\ai-orchestrator.js init
```

`init` walks you through, in order, pausing only where a human decision is
needed. Every step is optional and the whole thing is safe to re-run.

1. **Environment check** — confirms Node and (if installed) the Claude Code
   engine. No engine yet? You can still try everything with the built-in
   `mock` driver.
2. **Create your first project** — asks for the working directory (offers to
   create it), the engine, whether the work is a single mission prompt or a
   task plan, the permission mode, and any tool restrictions. It creates a
   starter prompt for you and validates the result before saving. This is
   the same flow as `projects add --interactive`.
3. **Connect your phone (Telegram)** — you create a bot with @BotFather and
   paste the token; `init` verifies it, **discovers your chat id
   automatically** (just message your bot once), and sends a test. After
   this you can approve work from your phone by replying `APPROVE <id>`.
4. **Connect email (optional)** — SMTP settings with the Gmail App-Password
   path spelled out; sends a real test email.
5. **Survive reboots (Windows, optional)** — offers to install the
   auto-resume task so a mid-mission power cut just continues at logon.
6. **You're ready** — a live channel test and a one-line summary of your
   projects, channels, and approval mode.

## 3. Run your first mission

```bat
node bin\ai-orchestrator.js start <your-project>
```

The orchestrator launches the agent, watches it, and recovers it if it
crashes or hits a usage limit. **Silence is normal** — it never interrupts a
working agent. It only pauses to ask *you* something when the work needs an
owner decision (an owner-gate approval or a human-only action like a login).

## 4. Approve from your phone

When a mission needs your sign-off, your phone buzzes with the request.
Reply in Telegram:

```
APPROVE A7                 approve request A7
REJECT A7 not this way     reject, with a reason
MODIFY A7 use Postgres     approve with a change note
DONE A7                    "I did the manual step you asked for"
```

The mission resumes within seconds of your reply.

## 5. If something looks off

```bat
node bin\ai-orchestrator.js doctor
```

`doctor` checks your environment, projects, and channels and tells you what
to fix — add `--fix` and it offers to repair what it found (safe changes
apply on confirmation; anything needing real input hands off to the
matching wizard). See [../TROUBLESHOOTING.md](../TROUBLESHOOTING.md) for
symptom → fix guidance.

---

## The mental model (30 seconds)

- **A project** is *where* the agent works and *what* it should do — one file
  under `config/projects/`, created for you by the wizard.
- **The orchestrator** (`start`) runs and supervises the agent unattended.
- **You** are interrupted only for genuine owner decisions — everything else
  proceeds, recovers, and resumes on its own.
- **Your windows in** are `status`, the desktop app, and — when you're away —
  Telegram/email.

Next: [CONFIGURATION.md](../CONFIGURATION.md) for every setting,
[REMOTE_APPROVALS.md](REMOTE_APPROVALS.md) for the full remote workflow.
