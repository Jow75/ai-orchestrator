# Telegram Setup — guided wizard

Connect AI-Orchestrator to Telegram so your phone receives mission
notifications AND can approve/reject work remotely (`APPROVE A7` by reply).
Telegram is the only **two-way** remote channel today — if you set up just
one remote integration, make it this one.

Work through the steps in order. **Stop at every ⏸ PAUSE — the next step
needs something only you can do.** Nothing before Step 6 changes any config,
so you can abandon the wizard at any point with no cleanup.

---

## Step 1 — Create the bot

1. Open Telegram (phone or desktop) and search for **@BotFather**
   (verified, blue check).
2. Send it: `/newbot`
3. It asks for a display name — e.g. `My AI Orchestrator`.
4. It asks for a username — must end in `bot`, e.g. `moses_orchestrator_bot`.
5. BotFather replies with a **bot token** that looks like:
   `8123456789:AAE4xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`

> ⏸ **PAUSE.** Copy the token somewhere safe (it is a credential — anyone
> holding it can send messages as your bot). Come back when you have it.

## Step 2 — Validate the token

Replace `<TOKEN>` and run (PowerShell):

```powershell
curl.exe "https://api.telegram.org/bot<TOKEN>/getMe"
```

**Expected:** `{"ok":true,"result":{...,"username":"moses_orchestrator_bot"}}`
**If you get** `{"ok":false,"error_code":401,...}`: the token is wrong or
was revoked — go back to BotFather (`/token` shows it again).

> ⏸ **PAUSE.** Only continue when `"ok":true`.

## Step 3 — Get your chat id

The bot may only message chats that messaged it first.

1. In Telegram, open a chat with **your own bot** (BotFather links it,
   or search its username).
2. Press **Start** and send any message, e.g. `hello`.
3. Run:

```powershell
curl.exe "https://api.telegram.org/bot<TOKEN>/getUpdates"
```

4. In the JSON, find `"chat":{"id":123456789,...}` — that number is your
   **chat id**.

**If `"result":[]` is empty:** send another message to the bot and re-run —
updates expire after 24 h, and a previously-set webhook can swallow them
(`curl.exe "https://api.telegram.org/bot<TOKEN>/deleteWebhook"` clears one).

> ⏸ **PAUSE.** Note the chat id. Continue when you have both token and id.

## Step 4 — Send yourself a test message

```powershell
curl.exe -X POST "https://api.telegram.org/bot<TOKEN>/sendMessage" -H "Content-Type: application/json" -d "{\"chat_id\": <CHAT_ID>, \"text\": \"AI-Orchestrator test\"}"
```

**Expected:** the message appears on your phone within seconds.

> ⏸ **PAUSE.** Don't proceed until the test message arrives — everything
> after this only re-uses the same two values.

## Step 5 — Decide what Telegram should do

Two independent systems use the same bot:

| System | What you get | Config block |
| --- | --- | --- |
| **Notifications** | one-way alerts (mission complete, blocked, crashed, approval required…) | `notifications.telegram` |
| **Approvals** | two-way: approval requests you can ANSWER by replying `APPROVE A7` / `REJECT A7 reason` / `MODIFY A7 changes` / `DONE A7` | `approvals.providers.telegram` |

Enable both (recommended). The approval provider falls back to the
notification channel's token/chatId when its own fields are blank — you
only have to paste the credentials once.

## Step 6 — Edit `config/local.json` (NOT orchestrator.json)

Credentials belong in **`config/local.json`** — it is git-ignored and
merged over `orchestrator.json` at load (Phase 10.5), so a `git commit -A`
can never publish your token. Create it (or add to it) like this:

```json
{
  "notifications": {
    "telegram": { "enabled": true, "botToken": "<TOKEN>", "chatId": "<CHAT_ID>" }
  },
  "approvals": {
    "providers": {
      "telegram": { "enabled": true, "botToken": "", "chatId": "" }
    }
  }
}
```

(Blank provider fields = reuse the notification channel's credentials.
Non-secret settings still live in `config/orchestrator.json`; local.json
only needs the blocks you see above.)

Optional noise control: `"telegram": { ..., "minSeverity": "warning" }`
keeps chatty info events off your phone; `critical` = only approvals,
human-action requests, and give-ups.

> ⏸ **PAUSE.** Save the file. Config is read at startup only — if an
> orchestrator is running, `ai-orchestrator stop` then start it again.

## Step 7 — Live end-to-end check

1. `node bin\ai-orchestrator.js doctor` — must stay green (it catches JSON
   syntax errors and lists the enabled channels).
2. `node bin\ai-orchestrator.js notify test` — sends a real test message
   through every enabled channel and prints a per-channel ✔/✘. Your phone
   should buzz within seconds.
3. For the full two-way loop, start any mission with an approval gate
   (or the demo project `audit-demo`):
   `node bin\ai-orchestrator.js start audit-demo --fresh`
4. Your phone should receive **"🔔 Approval required — audit-demo"** with a
   request id like `A7`.
5. Reply in the bot chat: `APPROVE A7`
6. Within ~15 s (the decision poll interval) the mission resumes; you get
   further notifications as it completes.

**If no message arrives:** check `logs/orchestrator-<today>.log` for
`Notification channel failed` — a 401 means bad token, a 400 usually means
wrong chat id or you never pressed Start on the bot chat.

## Security notes

- Only the configured `chatId` may decide approvals — a stranger who finds
  your bot cannot approve anything (enforced in
  `src/approvals/providers/telegramProvider.js`).
- The token lives in plain text in `config/local.json`, which is
  git-ignored — never move it into the tracked `orchestrator.json`.
- To revoke access at any time: BotFather → `/revoke` (invalidates the
  token), or set `enabled: false` in both blocks.

## Reply grammar (keep this handy)

```
APPROVE A7              approve request A7
REJECT A7 too risky     reject, with a reason the agent will see
MODIFY A7 skip step 3   approve with changes (carried into the agent's briefing)
DONE A7                 "I did the human action" (CAPTCHA, login, …) — resume
```
