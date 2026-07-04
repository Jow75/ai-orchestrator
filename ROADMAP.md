# Roadmap

## v1.0 — Shipped ✔

- Supervision loop with passive observation (never interrupt a live agent)
- Exit-cause classification (completed / usage-limit / network /
  interrupted / spawn-failure / crash), each with its own recovery strategy
- Usage-limit recovery: reset-time parsing, bounded waits, automatic resume
  of the same engine conversation
- Crash recovery with exponential backoff and a preserve-the-mission give-up
- Reboot / power-loss recovery: heartbeat + Task Scheduler auto-resume
- Claude Code driver (headless stream-json, `--resume`), mock driver
- Multi-project JSON configuration; per-project engine settings
- Session records, atomic state persistence, live status.json
- Rotating structured logs; every decision recorded
- Notifications: desktop, webhook, Discord, Telegram (email stubbed)
- Read-only dashboard HTTP API
- Plugin system (event subscribers, driver registration)
- CLI: start/resume/stop/status/sessions/projects/drivers/scheduler/doctor
- 53 unit/integration tests on Node's built-in test runner

## v1.1 — Hardening

- [ ] Email notification channel (SMTP via optional dependency)
- [ ] `runtime_history.json`: daily aggregates (runtime, completed phases,
      limits hit) for long-mission trend review
- [ ] Structured progress tracking: let the agent drop a `progress.json`
      the orchestrator surfaces in status/API
- [ ] Optional periodic status notification ("still running, 22h, phase E2")
- [ ] Windows service mode (run without logon) via `node-windows` or NSSM

## v1.2 — More engines

- [ ] OpenAI Codex CLI driver
- [ ] Gemini CLI driver
- [ ] Aider driver
- [ ] OpenCode / Qwen drivers
- [ ] Driver conformance test-kit (one suite every driver must pass)

## v2.0 — Dashboard & fleet

- [ ] Web dashboard on the existing API (live status, history charts,
      log tail, stop/resume buttons)
- [ ] Concurrent multi-project supervision in one process
- [ ] Mission queues: run project B when project A completes
- [ ] Remote/mobile notifications with actionable replies
- [ ] Cross-machine status aggregation

## Non-goals

- Editing or generating code itself — that is the agent's job; the
  orchestrator supervises.
- Interactive TUI sessions — supervision targets headless runs; interactive
  use already has a human present.
