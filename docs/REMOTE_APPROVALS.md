# Remote Approval Guide

How to control missions from anywhere: what pauses, what proceeds, and every
way to answer. (Setup of the channels themselves:
[TELEGRAM_SETUP.md](TELEGRAM_SETUP.md), [EMAIL_SETUP.md](EMAIL_SETUP.md).)

## The mental model

Every piece of work has a **category** (a plain string: `tests`,
`production-deployment`, `demo-feature`, …). The policy engine
(`src/approvals/approvalPolicy.js`) classifies each category into one of
four classes, and your **operating mode** decides which classes pause:

| Class | Meaning | conservative | balanced (default) | autonomous |
| --- | --- | --- | --- | --- |
| `automatic` | routine work (tests, docs, lint, retries, commits…) | ⏸ asks | ▶ proceeds | ▶ proceeds |
| `implementation-review` | the agent presented a plan (`IMPLEMENTATION PLAN READY` in its output) | ⏸ asks | ⏸ asks | ▶ proceeds |
| `owner-gate` | deploys, deletions, credentials, secrets, financial… | ⏸ asks | ⏸ asks | ⏸ asks |
| `human-action` | CAPTCHA, logins, browser prompts — things only a human can do | ⏸ asks | ⏸ asks | ⏸ asks |

**A category on no list is treated as owner-gate (fails closed).** Owner
gates and human actions ALWAYS pause — no mode disables your control.

Set the mode globally (`approvals.mode` in `config/orchestrator.json`),
per project (`"approvals": {"mode": "autonomous"}` in the project JSON), or
live: `ai-orchestrator approvals mode --set autonomous [project]`.

## Where approval requests come from

1. **Task gates** — a task in the project JSON declares
   `"approval": "<category>"`; it is evaluated **before the task's first
   launch**. Rejected → the task is BLOCKED (recover with
   `tasks approve` / `tasks skip`).
2. **Plan reviews** — a run whose output contains the `planMarker` pauses
   with an implementation summary (objective, duration, files, tasks,
   risks) for APPROVE / REJECT / MODIFY.
3. **Human-action pauses** — the agent's output matches a human-action
   pattern (CAPTCHA, authentication, browser prompt…); the mission pauses
   with what/why/action/where and resumes on DONE.

## Every way to answer

Requests have phone-friendly ids: `A1`, `A2`, … (global across projects,
persisted in `state/approvals/`).

| Surface | How |
| --- | --- |
| **Telegram** (two-way) | reply `APPROVE A7`, `REJECT A7 reason`, `MODIFY A7 changes`, `DONE A7` |
| **CLI** | `ai-orchestrator approvals approve A7` (also `reject` / `modify` / `done`, note after the id) |
| **Desktop app** | Approvals view → Approve / Modify… / Reject / "Done — I did it" |
| **HTTP API** | `POST /api/approvals/:project/:id/decide` with `{"decision":"approved","note":"..."}` + `Authorization: Bearer <api-token>` |
| **Email** | receive-only — the email lists the options above |

A decision made in ANY surface is picked up by the waiting mission within
`approvals.decisionPollMs` (default 15 s) — even from a different process.

## What the decisions do

- **APPROVE** — the task launches / the plan proceeds (a MODIFY note, if
  any, is included in the agent's next briefing).
- **REJECT <reason>** — a gated task is BLOCKED with your reason recorded;
  a plan review sends the agent your reason and stops the mission from
  proceeding down that plan.
- **MODIFY <changes>** — approve *with changes*: the mission continues and
  your note is injected into the agent's next prompt.
- **DONE** — only for human-action requests: "I did the thing, continue."

## Timing and safety

- Default `decisionTimeoutMs: 0` = a paused mission **waits forever** —
  it is resumable and abortable at any time, like a rate-limit wait, and
  survives reboots (the auto-resume task re-enters the same wait).
  A positive value expires the request (status `expired`) after that long.
  A project's own `approvals.decisionTimeoutMs`/`decisionPollMs` override
  the global values.
- Every request and decision (including auto-approved work) is a permanent
  audit trail: `ai-orchestrator approvals list <project>`.
- Only the configured Telegram `chatId` can decide; API decisions need the
  local token (`ai-orchestrator api-token`).
- **One request, one notification (Phase 11 M2).** A stop/resume or crash
  recovery that re-enters a still-pending gate reuses the SAME request
  instead of minting a new one and re-announcing it. And if you have both
  `notifications.telegram.enabled` and `approvals.providers.telegram.enabled`
  turned on (the Telegram channel AND the Telegram approval provider), the
  notification channel automatically skips approval events on that
  channel — the provider already delivers them with reply instructions, so
  you get one message, not two. If a request has been sitting unanswered
  and you want a nudge, `ai-orchestrator notify resend <project> <id>`
  force-resends it.

## Mission Cards, filenames, and attachments (Phase 11 M2)

Mission-complete and mission-blocked notifications now carry an executive
**Mission Card** — duration, tasks done, files changed, tests passed, an
honest confidence label (`verified` / `partial` / `unverified` — a mission
that finished without any automated check says so, never dressed up as
verified), the real git commit the mission ended on, and — when blocked —
your exact next command.

Any message that mentions a filename (`README.md`, `DiagnosticReport.md`)
renders it as inline code, never a clickable/dead link — a real bug a live
walkthrough found (Telegram's `.md` happens to also be a country-code
domain). When a real file is available (a diagnostic report, release
notes), Telegram attaches the actual document, not just its name.

## Quick recipes

```bat
:: See everything waiting on you, across all projects
node bin\ai-orchestrator.js approvals list

:: Gate a deployment task in a project JSON
"tasks": [{ "id": "D1", "prompt": "deploy.md", "approval": "production-deployment", ... }]

:: Make one project fully autonomous except gates
node bin\ai-orchestrator.js approvals mode --set autonomous my-project

:: Ask for a plan review: instruct the planning agent in its prompt to end
:: its plan with the exact text IMPLEMENTATION PLAN READY
```
