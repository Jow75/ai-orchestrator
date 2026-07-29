# Phase 13 M6 — Remote File System

**Version:** `v3.6.0`
**Date:** 2026-07-29
**Plan:** [PHASE_13_PLAN.md](PHASE_13_PLAN.md)
**Predecessor:** [M5 — Provider Architecture Completion & Remote Model/Provider Management](PHASE_13_M5_REPORT.md)

The first new runtime dependency since baseline (`archiver`) and the first
filesystem surface exposed remotely. Treated as a security-sensitive
milestone, not a feature milestone, per the owner's explicit framing: the
filesystem is never a raw filesystem, and Telegram must never become a
generic file browser.

---

## What was built

- **`src/operator/fileAccess.js`** — everything filesystem-adjacent lives
  here, so there is exactly ONE path-traversal guard in the codebase:
  - `resolveWithinProject(projectRoot, relativePath)` — the guard itself.
    Two layers: **textual** containment (`path.resolve()` then
    `path.relative(root, resolved)`, refusing anything that starts with
    `..` or is itself absolute) catches every spelling of "outside the
    project" `path.resolve()` can express — `../`, a POSIX absolute path, a
    Windows drive letter, the obscure Windows *drive-relative* form
    (`C:foo`, no separator after the colon — `path.isAbsolute()` alone does
    **not** flag this as absolute), a UNC path, and any mix of `/`/`\`
    separators — with no pattern blacklist, because the only thing that
    matters is where the path actually lands. **Real-path** containment
    (`fs.realpathSync()` on both root and target, then the same relative
    check) catches what the textual layer structurally cannot see: a
    symlink or NTFS junction that lives *inside* the project but points
    *outside* it.
  - `listFiles()` — one directory level, Explorer-style, never a recursive
    walk; directories first then alphabetical; paginated (`page`/`pageSize`,
    default 30).
  - `looksBinary()` — a NUL-byte sniff over the first 8 KB, extension-agnostic.
  - `estimateArchiveSize()` / `createProjectArchive()` — sum and then zip
    everything that survives the SAME exclusion list, so "how big will this
    be" and "what actually gets zipped" can never disagree with each other.
  - `pruneOldDownloads()` — deletes generated ZIPs past a configurable
    retention window (default 24h).
- **Three commands** (`commandGrammar.js` / `commandRouter.js`):
  `/files [path]`, `/file <path>`, `/download-project [project]`. All
  behind a new `operator.files.enabled` kill switch — the highest new
  filesystem-read exposure in this phase gets its own switch, separate from
  the general `operator.enabled` grammar toggle.
- **`CommandRouter.handle()`'s reply contract grows one optional field**,
  exactly as D4 specified: `{reply, attachment?}`. Additive — every
  existing `.reply`-only caller is unaffected (confirmed: all 1100
  pre-M6 tests stayed green with zero modifications).
- **`TelegramApprovalProvider.sendDocument()`** — mirrors the ~30-line
  method already proven in `notifications/channels/telegram.js`
  (multipart `FormData`, same `MAX_DOCUMENT_BYTES` ceiling, reused not
  duplicated) rather than rerouting through the one-way notification
  channel, per D4: the API/CLI path must see the identical
  `{reply, attachment}` contract a phone gets, and only this provider
  serves that router.
- **`OperatorGateway.deliver()`** sends the text reply (if any), then the
  attachment (if any) via a duck-typed `typeof provider.sendDocument ===
  'function'` check — the same convention `registerCommands()` already
  established for a capability only some providers implement.
- **`POST /api/operator/command`** (`dashboardServer.js`) and the CLI's
  `operator` command now surface `attachment` instead of silently dropping
  it — a real gap found while wiring this up (see below).

---

## Security design

Every command resolves `active project → ConfigManager.getProject() →
workingDirectory → resolveWithinProject()` before touching a byte of disk.
`/files` and `/file` deliberately do **not** accept a project name as part
of their own argument — unlike `/status`/`/tasks`, their argument is a
filesystem path, and a path and a project name are both free-form strings
with no way to disambiguate them; only the active project (`/project
<name>` first) is ever read from. `/download-project [project]` is the one
exception, since it names a project instead of a path, and uses the
existing `resolveTarget()` (named-or-active) like every other project-
scoped command.

**A refusal is never a "fix."** No input is ever reinterpreted onto a valid
path; every escape attempt is refused outright, with a plain-language
reason, and — new in this milestone — **recorded in the durable event log**
(`file.served` with `mode: 'refused'`). A plain not-found (a typo, a file
that was simply never there) is *not* logged as refusal evidence, for the
same reason `/scan`'s "no candidates" result isn't logged per candidate —
noise, not signal. This was not in the original plan; it surfaced while
reviewing the router's own stated rule ("every real outcome becomes an
event") against what a hostile probe on this specific surface would leave
behind, which was, before this fix, *nothing*.

---

## Real deviations from the plan, and real defects found

Every one of these was found by building the thing and testing it against
real evidence — the recurring lesson this project has restated at the end
of every phase since Phase 8, holding again on its 10th+ occurrence.

1. **`archiver` published a major rewrite (v8) with a different API than
   the plan assumed.** `npm install archiver` pulled the current `latest`
   (8.0.0), a pure-ESM rewrite: no default export, no
   `archiver(format, options)` factory — named classes
   (`ZipArchive`/`TarArchive`/`JsonArchive`) instead. Confirmed via
   `npm view` that both 7.0.1 and 8.0.0 are maintained by the same author
   under the same package; 8.x is the current recommendation, and this
   codebase is itself `"type": "module"` throughout, so adopting the real
   ESM API (`new ZipArchive(...)`) was the correct call rather than pinning
   to an older major to dodge it. A second, more consequential finding
   while reading `readdir-glob`'s source (`archiver`'s own glob
   dependency): its `ignore` option only filters files *after* walking
   them — it does not stop the walk from *descending* into an excluded
   directory. For something the size of a real `node_modules`, that
   difference is the whole performance story. Fixed by using the `skip`
   option instead (`**/node_modules`, etc.), which prevents the walker
   from ever entering an excluded directory at all.
2. **`/download-project` is not a legal Telegram bot command name.**
   `setMyCommands` requires `^[a-z0-9_]{1,32}$` — no hyphen. Building this
   the same day M2.2's command-menu invariant (every command in
   `COMMANDS` must be publishable, tested in `commandMenu.test.js`) exists
   meant the conflict surfaced immediately as a real, cascading test
   failure (`commandMenu.test.js`, `onboarding.notifyWizard.test.js`, and
   the daemon integration tests all failed on the same root cause). Fixed
   by making the canonical name `download_project` and keeping
   `/download-project` — the owner's own literal spelling — as a fully
   working alias, so nothing the directive asked for stopped working; only
   the *published, tappable* form differs from the directive's prose,
   necessarily.
3. **A vanished project's folder silently produced a valid, EMPTY ZIP
   instead of an error.** Found by the adversarial test suite, not by
   inspection: `readdir-glob`'s own `readdir()` treats `ENOENT` on the
   `cwd` as "zero matches," not a failure, so `createProjectArchive()`
   (and, separately, the hand-rolled `estimateArchiveSize()`) would
   complete "successfully" over a missing directory and report "0 bytes, 0
   files zipped" — exactly the kind of confidently-wrong non-answer this
   project has a standing rule against (`projectRegistry.js`'s own "more
   useful than one that reports a confident fiction"). Fixed with an
   explicit `fs.existsSync()` check at the top of both functions, throwing
   a clear `FileAccessError` instead. The regression test was **run
   against the unfixed code and confirmed to fail first** (the same
   discipline `workerExit.test.js` established in Phase 12 M2 — a test
   that has never seen its own bug is a hope, not a test).
4. **The `POST /api/operator/command` route silently dropped
   `attachment`.** D4 states the API/CLI path must see the identical
   `{reply, attachment}` contract Telegram gets; the pre-existing route
   (written before this milestone existed) returned only `{ok, reply}`.
   Left unfixed, an API or CLI caller running `/file bigfile.bin` would
   have received "sending as a file" with no way to find it. Fixed by
   including `attachment` (a local filesystem path — safe to expose, since
   the daemon and this loopback-only API always share one machine) in the
   JSON response, and printing it from the CLI's `operator` command.

None of these were cosmetic — each was either a genuine security/integrity
gap or a cascading test failure that would have blocked the milestone from
shipping honestly. All four are fixed at the root, not patched around.

---

## Verification

**1100 → 1155 backend tests** (+55): the centerpiece is
`test/fileAccess.test.js` (26 tests) — the adversarial path-traversal suite
is deliberately the largest section: classic `../` traversal, mixed
separators, a POSIX absolute path, a Windows absolute drive-letter path, the
obscure Windows drive-*relative* form, a UNC path, a sibling directory that
merely *shares a string prefix* with the root (the exact bug a naive
`startsWith()` check would miss), and a real symlink/junction escape — every
one refused via the real containment check, none via a name-based blacklist.
Also: `listFiles` ordering/pagination/ignore-list behavior, `looksBinary`,
`estimateArchiveSize` exclusion-consistency, `createProjectArchive`
producing a real ZIP with a genuine local-file-header signature and
excluding `node_modules`, and `pruneOldDownloads`. Plus: `sendDocument()`
tests mirroring `telegramChannel.test.js`'s existing coverage
(`telegramRouting.test.js`), attachment-delivery tests in
`operatorGateway.test.js` (text-then-document ordering, attachment-only
replies, the duck-typed provider-without-`sendDocument` case, a failed
attachment send never disturbing an already-sent text reply), 18 new
`/files`/`/file`/`/download_project` integration tests in
`commandRouter.test.js` (including the archived-project-is-still-reachable
case and the refusal-audit-trail case), and 2 new
`dashboardServer.operator.test.js` tests for the attachment passthrough fix.

**Live validation**, against the real installation, the real Core Service
(restarted to load this milestone's code), and the real `calculator-proof`
project (12 real files, kept as evidence since Phase 12 M2.2):

- `/files` on the real project root: correctly showed `electron/`, `src/`,
  `test/`, `.gitignore`, `index.html`, `package-lock.json`, `package.json`,
  `README.md`, `vite.config.js` — 9 entries, `node_modules` and `dist`
  correctly absent (both in `DEFAULT_IGNORE_DIRS`).
- `/files src` listed all 4 real source files.
- `/file README.md` and `/file package.json` — both real, small files —
  rendered inline, in full.
- `/file src/calculator.js` (4,047 bytes, over the 3,500-byte inline
  threshold) correctly routed to the attachment path.
- **Sent through the real Telegram Bot API**, not simulated: a throwaway
  scratch harness (never committed) wired the real, production
  `TelegramApprovalProvider` against the real bot token/chat id
  (`config/local.json`) and called the real `sendDocument()` method on the
  real, complete `calculator.js` — Telegram returned a genuine message id
  (`163`), confirming actual delivery.
- Three distinct outside-the-project attempts, all refused with a plain
  reason and none "fixed": `../../../../windows/system32/drivers/etc/hosts`
  (relative traversal), `C:\Windows\System32\drivers\etc\hosts` (absolute),
  and `../AI-Orchestrator/config/local.json` — a real, existing, genuinely
  sensitive file (this installation's own gitignored credentials) in a real
  sibling directory, not a hypothetical path.
- `/download-project` (via its alias) produced a real 129.9 KB, 13-file
  ZIP. **Verified by actually extracting it** with Windows' own
  `Expand-Archive` (a genuine unzip, not just a byte-signature check):
  directory structure preserved (`electron/`, `src/`, `test/`), all 13
  real source files intact, `node_modules` and `dist` absent.
- Archived-project access: `/archive example` (a real, low-stakes project),
  then `/files`, `/file prompt.md`, and `/download_project` against it —
  all worked exactly as on a non-archived project, then `/restore example`
  reverted the classification. Confirms the plan's own framing directly:
  archiving is a registry demotion, never an access restriction.
- A genuinely nonexistent path (`does-not-exist-anywhere.txt`) produced a
  clear "does not exist" — distinct from a security refusal.
- Every access — list, read, refusal, download — was independently
  confirmed present in `state/events/events.jsonl` via `ai-orchestrator
  events`, with the traversal refusal specifically showing
  `mode: "refused"` and the exact attempted path.

**No leftover temporary files**: `pruneOldDownloads()` runs at daemon start
and after every new ZIP; the one ZIP produced during this validation pass
was inspected via `Expand-Archive` into a scratch folder that was then
deleted, leaving only the original `state/operator/downloads/*.zip` (which
ages out on the normal 24h cycle like any other).

---

## Deliberately deferred

- **`docs/OPERATOR_CONSOLE.md`** was not updated with the new commands —
  consistent with M2 through M5, none of which touched it either; a full
  pass covering every M1–M7 command is explicitly M8's scope
  ("Bot Experience & Discoverability"), not repeated piecemeal five times.
  `/help` itself needs no such pass — it is generated from `COMMANDS`
  directly and already lists all three new commands correctly (confirmed
  by the same test that has covered every prior milestone's commands).
- **`CONFIGURATION.md`** likewise carries no `operator.*` documentation for
  any milestone since M2 (`operator.discovery`, `.lifecycle`, `.liveConfig`
  are equally undocumented there) — `operator.files`/`operator.download`
  follow the same established boundary rather than being the first to
  break it.
- **A `page` argument on the `/files` command itself** was not added —
  `listFiles()`'s API supports `page`/`pageSize` (and is tested directly),
  but the command surface always requests page 1. 30 entries covers the
  overwhelming majority of real directories, and nothing about this is a
  safety gap: Telegram's `sendLongText()` already guarantees delivery of
  whatever a reply contains, however long.
- **Inline file display uses plain, HTML-escaped text, not a monospace
  `<pre>` code block.** The existing send pipeline has exactly one text
  shape (freeform text that `formatTelegramText()` escapes downstream);
  adding a genuine `<pre>` block would require threading an
  "already-HTML-formatted, do not escape again" flag through the reply
  contract and the send path — a real extension, not a bug fix, and one
  the owner's directive did not ask for. Telegram already preserves line
  breaks and whitespace in plain text, so readability is not lost, only
  syntax highlighting.
- **`operator.download.exclude`'s "unless explicitly requested" clause**
  (the directive's own wording) has no command-level override yet — no
  `/download-project --include-node_modules` flag exists. Config-file
  overridable; a remote flag was not built, since nothing in this
  milestone's validation needed it and it was not requested as a command.

---

## What's next

Phase 13 M7 — Mission Completion Messaging (`v3.7.0`): a copy change to
`mission:complete`'s notification, pointing a completed mission's owner at
the real commands this milestone just shipped
(`/files`/`/file`/`/download-project`) with the real project name
substituted in. See [PHASE_13_PLAN.md](PHASE_13_PLAN.md).

---

## Addendum (2026-07-30, reconciliation pass)

The owner's original directive for remote file access asked for large
files to be delivered by streaming or chunking when Telegram's limits are
hit. What shipped instead, both here (`/file`) and for whole-project
export, is a flat refusal with a redirect: over `MAX_DOCUMENT_BYTES`
(50MB), `/file` points the owner at `/download-project` or the machine
itself (`commandRouter.js`'s oversized-file branch); over the same limit
post-zip, `/download-project` explains the size and suggests zipping by
hand. No chunking mechanism was ever built, and this substitution was
never disclosed as a deliberate decision in this report at the time — an
audit surfaced it after the fact, not a stated design choice.

**Decided on reconciliation, 2026-07-30: this is the permanent design.**
Chunking a file's raw bytes across multiple Telegram messages would still
require the recipient to manually reassemble it — strictly worse than the
zip `/download-project` already produces, which is one file, one send,
correctly ordered, with no reassembly step. `/file` under the 50MB limit
already delivers the real file as a single document; nothing between "one
message" and "one zip" is needed. No chunking implementation is planned.
