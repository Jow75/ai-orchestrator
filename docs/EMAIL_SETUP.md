# Email Setup — guided wizard

Connect AI-Orchestrator to a mailbox so mission notifications and approval
requests arrive by email. **Email is one-way (publish-only) by design** —
the orchestrator never reads your inbox (no IMAP). Every approval email
tells you how to actually decide: Telegram reply, CLI, desktop, or API.
If you want to *answer* from your phone, set up Telegram too
([TELEGRAM_SETUP.md](TELEGRAM_SETUP.md)).

Uses the built-in dependency-free SMTP client
(`src/notifications/smtpClient.js`): implicit TLS (port 465), STARTTLS
(port 587), and AUTH PLAIN/LOGIN.

**Stop at every ⏸ PAUSE — the next step needs something only you can do.**

> **The fastest way is the built-in wizard:**
> `node bin\ai-orchestrator.js notify setup email` — it collects your SMTP
> settings, sends a real test email, translates the common errors (535 auth,
> STARTTLS, connection) into plain-language fixes, and writes
> `config/local.json`. The manual steps below are the by-hand route.

---

## Step 1 — Choose the sending mailbox

Any SMTP-capable account works. For Gmail, Google requires an **App
Password** — your normal password will NOT work and "less secure apps"
no longer exists.

> ⏸ **PAUSE.** Decide which account sends. Gmail → Step 2. Another
> provider → find its SMTP host/port and jump to Step 3.

## Step 2 — Create a Gmail App Password

1. 2-Step Verification must be ON: <https://myaccount.google.com/security>
2. Then open <https://myaccount.google.com/apppasswords>
3. Create one named e.g. `ai-orchestrator`.
4. Google shows a 16-character password (like `abcd efgh ijkl mnop`) —
   **shown only once**.

> ⏸ **PAUSE.** Copy it (spaces don't matter). If you can't see the App
> Passwords page, 2-Step Verification isn't fully enabled yet.

## Step 3 — Fill in the config

Credentials belong in **`config/local.json`** — it is git-ignored and
merged over `orchestrator.json` at load (Phase 10.5), so the app password
can never end up in a commit. Create it (or add to it):

```json
{
  "notifications": {
    "email": {
      "enabled": true,
      "smtp": {
        "host": "smtp.gmail.com",
        "port": 587,
        "starttls": true,
        "user": "me@gmail.com",
        "pass": "<16-char app password>"
      },
      "from": "me@gmail.com",
      "to": "me@gmail.com"
    }
  },
  "approvals": {
    "providers": {
      "email": { "enabled": true, "smtp": {}, "from": "", "to": "" }
    }
  }
}
```

Non-Gmail: swap `host`/`port` (`"secure": true` + port 465 for implicit
TLS instead of `starttls`). The `approvals.providers.email` block is only
needed if you ALSO want approval requests by email.

(Blank fields reuse the notification channel's SMTP settings — one mailbox
serves both, wired in `src/app.js`.)

Noise control: email is a poor place for chatty events — consider
`"minSeverity": "warning"` inside the email block.

> ⏸ **PAUSE.** Save the file. Restart the orchestrator if one is running
> (`ai-orchestrator stop`, then `start` again).

## Step 4 — Validate

1. `node bin\ai-orchestrator.js doctor` — catches config JSON mistakes.
2. `node bin\ai-orchestrator.js notify test` — sends a real test email
   through the SMTP client and prints ✔/✘ per channel.
3. Watch the inbox. If it failed, check `logs/orchestrator-<today>.log`:
   - **no `Notification channel failed` line** → sent successfully.
   - `535` / `Username and Password not accepted` → app password wrong,
     or you used the normal account password.
   - `Connection timed out` → port blocked; try 465 + `"secure": true`.

> ⏸ **PAUSE.** Only mark email "done" once a real message has landed.

## What you will receive

| Event | Default severity |
| --- | --- |
| Approval required / human action required | critical |
| Mission blocked, agent gave up | critical/warning |
| Verification failed | warning |
| Mission complete, release created | info |
| Daily/weekly digest (needs `schedules watch` running + `notifications.summaries` enabled) | info |

Remember: to DECIDE an approval you still reply via Telegram
(`APPROVE A7`), the CLI (`ai-orchestrator approvals approve A7`), the
desktop Approvals view, or the API — the email itself repeats these
options in its footer.
