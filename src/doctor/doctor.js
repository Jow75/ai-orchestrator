/**
 * doctor/doctor.js — Phase 11 M3: structured diagnostics.
 *
 * `buildDoctorFindings()` runs every check and returns a plain array of
 * findings — no printing, no side effects beyond reading the environment/
 * config. `renderDoctorFindings()` is the only place that prints.
 * `applyDoctorFix()` invokes one finding's repair. This split is what makes
 * `doctor --fix` possible: the same findings a human reads on a plain
 * `doctor` run are exactly what `--fix` iterates over — nothing is
 * special-cased between the two modes.
 *
 * Every finding that names a real problem also carries `cause` (why) and
 * `impact` (what it actually affects) — the "remedy-first" contract this
 * phase establishes for every user-facing message, not just errors that
 * throw. A finding's `fix`, when present, is `{ description, safe, apply }`:
 * `safe` fixes are direct, reversible repairs (set a config field, delete
 * an already-useless quarantined file, install a well-known scheduled
 * task); non-safe fixes hand off to a guided onboarding wizard because they
 * need real human input (a bot token, a mailbox password) that nothing can
 * safely invent. EVERY fix — safe or not — is still confirmed individually
 * before it runs; `--fix` never changes anything silently.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import ConfigManager from '../config/configManager.js';
import DriverRegistry from '../drivers/driverRegistry.js';
import SessionManager from '../state/sessionManager.js';
import { readJsonSafe } from '../state/statePersistence.js';
import { CHECK_MARK } from '../shared/vocabulary.js';
import { isPidAlive } from '../state/heartbeat.js';
import { silentLogger } from '../infra/logger.js';
import { autostartState, CORE_SERVICE_TASK_NAME } from '../daemon/serviceControl.js';

/** Windows Task Scheduler task name used by `scheduler`/doctor's auto-resume check. */
export const SCHEDULED_TASK_NAME = 'AI-Orchestrator Auto-Resume';

/**
 * @typedef {object} DoctorFix
 * @property {string} description - What applying this fix will do.
 * @property {boolean} safe - True for a direct, reversible repair this
 *   process applies itself; false for a fix that launches a guided wizard
 *   because it needs real human input.
 * @property {(ctx: object) => Promise<{ok: boolean, message: string}>} apply
 */

/**
 * @typedef {object} DoctorFinding
 * @property {string} id - Stable identifier (used by --fix and tests).
 * @property {'ok'|'warn'|'fail'} status
 * @property {string} label
 * @property {string} [detail]
 * @property {string} [cause] - Why this is happening.
 * @property {string} [impact] - What it actually affects.
 * @property {DoctorFix} [fix]
 */

function okFinding(id, label, detail) { return { id, status: 'ok', label, detail }; }
function failFinding(id, label, detail, extra = {}) { return { id, status: 'fail', label, detail, ...extra }; }
function warnFinding(id, label, detail, extra = {}) { return { id, status: 'warn', label, detail, ...extra }; }

/** Real check for the Windows auto-resume scheduled task (injectable for tests). */
function defaultCheckScheduledTask() {
  const result = spawnSync('schtasks', ['/Query', '/TN', SCHEDULED_TASK_NAME], {
    encoding: 'utf8', windowsHide: true,
  });
  return { installed: result.status === 0 };
}

/** Real check for the Core Service logon task (injectable for tests). */
function defaultCheckCoreServiceTask() {
  return autostartState();
}

/**
 * Recursively find quarantined corrupt-state files (see
 * statePersistence.js's `readJsonSafe` — a damaged file is renamed to
 * `<file>.corrupt-<timestamp>` rather than crashing the supervisor).
 * Bounded to the state directory; safe to call even if it doesn't exist.
 */
function findCorruptFiles(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const found = [];
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return; // unreadable directory — not this check's concern
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.includes('.corrupt-')) found.push(full);
    }
  };
  walk(dir);
  return found;
}

/**
 * Run every diagnostic check and return the findings, in display order.
 *
 * @param {object} [options]
 * @param {ConfigManager} [options.configManager]
 * @param {DriverRegistry} [options.driverRegistry]
 * @param {string} [options.platform] - Defaults to `process.platform` (tests override).
 * @param {() => {installed: boolean}} [options.checkScheduledTask] - Injectable (tests).
 * @param {() => {installed: boolean}} [options.checkCoreServiceTask] - Injectable (tests).
 * @returns {Promise<DoctorFinding[]>}
 */
export async function buildDoctorFindings({
  configManager = new ConfigManager(),
  driverRegistry = new DriverRegistry({ logger: silentLogger }),
  platform = process.platform,
  checkScheduledTask = defaultCheckScheduledTask,
  checkCoreServiceTask = defaultCheckCoreServiceTask,
} = {}) {
  const findings = [];

  const major = Number(process.versions.node.split('.')[0]);
  findings.push(major >= 18
    ? okFinding('node-version', `Node.js ${process.version}`, 'supported')
    : failFinding('node-version', `Node.js ${process.version}`, 'need >= 18', {
      cause: `Node.js ${process.version} is older than the minimum supported version (18).`,
      impact: 'AI-Orchestrator relies on modern JS runtime features; behaviour on older Node is unsupported.',
    }));

  try {
    configManager.load();
    findings.push(okFinding('global-config', 'Global configuration loads', 'config/orchestrator.json'));
  } catch (error) {
    findings.push(failFinding('global-config', 'Global configuration loads', error.message, {
      cause: error.message,
      impact: 'Nothing else can be checked without valid configuration.',
    }));
    return findings; // nothing downstream can run without config — matches pre-M3 behaviour
  }

  const projectNames = configManager.listProjects();
  if (projectNames.length > 0) {
    findings.push(okFinding('projects-defined', `Projects defined: ${projectNames.length}`, projectNames.join(', ')));
  } else {
    findings.push(failFinding('projects-defined', 'Projects defined: 0', 'add one with "projects add"', {
      cause: 'No project definitions exist yet in config/projects/.',
      impact: 'There is nothing to supervise until at least one project is defined.',
      fix: {
        description: 'Launch the guided project-creation wizard.',
        safe: false,
        apply: async (ctx) => {
          const result = await ctx.projectWizard({ configManager: ctx.configManager, prompter: ctx.prompter });
          return result?.name
            ? { ok: true, message: `Project "${result.name}" created.` }
            : { ok: false, message: 'No project was created.' };
        },
      },
    }));
  }

  for (const name of projectNames) {
    try {
      const project = configManager.getProject(name);
      findings.push(okFinding(`project-valid:${name}`, `Project "${name}" is valid`, project.workingDirectory));

      const driver = driverRegistry.getDriver(project.driver);
      // eslint-disable-next-line no-await-in-loop
      const installation = await driver.checkInstallation(project[project.driver]?.executable);
      findings.push(installation.ok
        ? okFinding(`engine:${name}`, `Engine for "${name}" (${project.driver})`, installation.version)
        : failFinding(`engine:${name}`, `Engine for "${name}" (${project.driver})`, installation.error, {
          cause: installation.error,
          impact: `"${name}" cannot be started until its engine is installed and on PATH.`,
        }));

      // Unattended headless engines cannot answer permission prompts; a
      // claude project without write permissions blocks on "no progress".
      if (
        project.driver === 'claude' &&
        !project.claude?.permissionMode &&
        !project.claude?.dangerouslySkipPermissions
      ) {
        findings.push(warnFinding(
          `write-permission:${name}`, `Project "${name}" has no engine write permissions`,
          'unattended runs will be read-only and block — set "claude.permissionMode" (e.g. "acceptEdits")', {
            cause: `"${name}" has no claude.permissionMode set (and dangerouslySkipPermissions is off).`,
            impact: 'A headless engine cannot answer permission prompts; unattended runs are read-only and the mission blocks on "no progress".',
            fix: {
              description: `Set claude.permissionMode to "acceptEdits" in "${name}"'s project file.`,
              safe: true,
              apply: async (ctx) => {
                const file = path.join(ctx.paths.projectsDir, `${name}.json`);
                const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
                raw.claude = { ...(raw.claude ?? {}), permissionMode: 'acceptEdits' };
                fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
                return { ok: true, message: `claude.permissionMode set to "acceptEdits" in ${file}` };
              },
            },
          }
        ));
      }
    } catch (error) {
      findings.push(failFinding(`project-valid:${name}`, `Project "${name}" is valid`, error.message, {
        cause: error.message,
        impact: `"${name}" cannot be loaded or supervised until this is fixed.`,
      }));
    }
  }

  // Writable runtime dirs.
  const paths = configManager.getPaths();
  try {
    fs.mkdirSync(paths.stateDir, { recursive: true });
    const probe = path.join(paths.stateDir, '.doctor-probe');
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe);
    findings.push(okFinding('state-dir-writable', 'State directory writable', paths.stateDir));
  } catch (error) {
    findings.push(failFinding('state-dir-writable', 'State directory writable', error.message, {
      cause: error.message,
      impact: 'Nothing can be supervised — session/task/status state cannot be persisted.',
    }));
  }

  // Notification channels — the remote/phone workflow needs at least one
  // beyond the local desktop toast.
  const notif = configManager.get('notifications', {});
  const enabledChannels = ['desktop', 'webhook', 'discord', 'telegram', 'email']
    .filter((name) => notif[name]?.enabled);
  findings.push(enabledChannels.length > 0
    ? okFinding('notification-channels', 'Notification channels enabled', enabledChannels.join(', '))
    : failFinding('notification-channels', 'Notification channels enabled',
      'none — see docs/TELEGRAM_SETUP.md / docs/EMAIL_SETUP.md', {
        cause: 'No notification channel is enabled at all (not even desktop).',
        impact: 'You will not be told about approvals, blocked missions, or completions.',
      }));

  if (!enabledChannels.some((name) => name !== 'desktop')) {
    findings.push(warnFinding('remote-channel', 'No remote notification channel',
      'approvals from your phone need telegram or email — see docs/REMOTE_APPROVALS.md', {
        cause: 'Only the local desktop channel is enabled.',
        impact: 'You cannot approve work or be notified while away from this machine.',
        fix: {
          description: 'Launch the Telegram setup wizard (real, two-way phone approvals).',
          safe: false,
          apply: async (ctx) => {
            const result = await ctx.telegramWizard({ configManager: ctx.configManager, prompter: ctx.prompter });
            return result
              ? { ok: true, message: 'Telegram configured.' }
              : { ok: false, message: 'Telegram setup was not completed.' };
          },
        },
      }));
  }
  if (notif.telegram?.enabled && (!notif.telegram.botToken || !notif.telegram.chatId)) {
    findings.push(warnFinding('telegram-incomplete', 'Telegram channel incomplete',
      '"botToken" and "chatId" are both required', {
        cause: 'notifications.telegram.enabled is true but botToken/chatId is missing.',
        impact: 'The Telegram channel will fail every send until this is fixed.',
        fix: {
          description: 'Re-run the Telegram setup wizard to fill in the token/chat id.',
          safe: false,
          apply: async (ctx) => {
            const result = await ctx.telegramWizard({ configManager: ctx.configManager, prompter: ctx.prompter });
            return result
              ? { ok: true, message: 'Telegram configured.' }
              : { ok: false, message: 'Telegram setup was not completed.' };
          },
        },
      }));
  }
  if (notif.email?.enabled && !notif.email.smtp?.host) {
    findings.push(warnFinding('email-incomplete', 'Email channel incomplete', '"smtp.host" is required', {
      cause: 'notifications.email.enabled is true but smtp.host is missing.',
      impact: 'The email channel will fail every send until this is fixed.',
      fix: {
        description: 'Re-run the email setup wizard.',
        safe: false,
        apply: async (ctx) => {
          const result = await ctx.emailWizard({ configManager: ctx.configManager, prompter: ctx.prompter });
          return result
            ? { ok: true, message: 'Email configured.' }
            : { ok: false, message: 'Email setup was not completed.' };
        },
      },
    }));
  }

  // Running instance? (informational only; rendered specially — see renderDoctorFindings).
  const heartbeat = readJsonSafe(paths.heartbeatFile);
  const instanceRunning = heartbeat?.state === 'running' && isPidAlive(heartbeat.pid);
  if (instanceRunning) {
    findings.push({ id: 'running-instance', status: 'ok', label: `pid ${heartbeat.pid}` });
  }

  // Guided recovery (Phase 11 M3): a resumable session nobody is currently
  // supervising isn't a problem by itself (P0's whole design lets a mission
  // sit paused until the next `start`) — but an operator unfamiliar with
  // the CLI shouldn't have to remember there even IS a next command.
  const sessionManager = new SessionManager({ sessionsDir: paths.sessionsDir, logger: silentLogger });
  for (const name of projectNames) {
    const session = sessionManager.getResumableSession(name);
    if (!session) continue;
    if (instanceRunning && heartbeat.project === name) continue; // actively supervised right now
    findings.push(warnFinding(`unfinished-session:${name}`,
      `Project "${name}" has unfinished work from a previous run`,
      `state: ${session.state}, last updated ${new Date(session.updatedAt).toLocaleString()} — ` +
      `continue: "ai-orchestrator start ${name}", or discard: "ai-orchestrator sessions ${name} --abandon"`, {
        cause: `A resumable session exists but no orchestrator is currently supervising "${name}".`,
        impact: 'Nothing is broken — this is informational. The mission is exactly where it was left.',
      }));
  }

  // Guided recovery: quarantined corrupt state files. The system already
  // self-heals from corruption (readJsonSafe quarantines a damaged file and
  // falls back to defaults) — this surfaces what happened instead of
  // leaving a silent trail only visible in the logs.
  const corruptFiles = findCorruptFiles(paths.stateDir);
  if (corruptFiles.length > 0) {
    const shown = corruptFiles.slice(0, 5).map((f) => path.basename(f)).join(', ');
    findings.push(warnFinding('quarantined-state-files',
      `${corruptFiles.length} corrupted state file(s) were quarantined`,
      shown + (corruptFiles.length > 5 ? `, +${corruptFiles.length - 5} more` : ''), {
        cause: 'One or more state files were damaged (invalid JSON) and safely set aside instead of crashing supervision.',
        impact: 'None currently — the system already recovered by falling back to defaults. Safe to delete once you\'ve confirmed nothing important was lost.',
        fix: {
          description: `Delete ${corruptFiles.length} quarantined file(s).`,
          safe: true,
          apply: async () => {
            let deleted = 0;
            for (const file of corruptFiles) {
              try { fs.rmSync(file); deleted += 1; } catch { /* best-effort; report what happened */ }
            }
            return {
              ok: deleted === corruptFiles.length,
              message: `Deleted ${deleted}/${corruptFiles.length} file(s).`,
            };
          },
        },
      }));
  }

  // Scheduled task (Windows only).
  if (platform === 'win32') {
    const task = checkScheduledTask();
    findings.push(task.installed
      ? okFinding('auto-resume-task', 'Auto-resume scheduled task', 'installed')
      : warnFinding('auto-resume-task', 'Auto-resume scheduled task',
        'not installed (optional) — "scheduler install"', {
          cause: 'The Windows logon task that resumes interrupted missions after a reboot is not installed.',
          impact: 'Optional — missions still resume the next time you manually run "start"; a reboot alone will not auto-resume them.',
          fix: {
            description: 'Install the auto-resume logon task.',
            safe: true,
            apply: async (ctx) => {
              try {
                ctx.runSchedulerScript('install-task.ps1');
                return { ok: true, message: 'Auto-resume task installed.' };
              } catch (error) {
                return { ok: false, message: error.message };
              }
            },
          },
        }));

    // Phase 12 M2.1: the Core Service's own logon task.
    //
    // Added because its absence is invisible until it matters. On 2026-07-28
    // this machine rebooted, the operator console went silent, and every
    // diagnostic available said the installation was healthy — `doctor`
    // checked only the auto-resume task above, which was installed and which
    // does a different job. A remote interface that cannot survive a reboot is
    // a FAILURE, not a warning: being there when nobody is at the machine is
    // the entire purpose of the daemon.
    const service = checkCoreServiceTask();
    findings.push(service.installed
      ? okFinding('core-service-task', 'Core Service starts at logon', 'installed')
      : failFinding('core-service-task', 'Core Service starts at logon',
        'not installed — "daemon install"', {
          cause: `No scheduled task named "${CORE_SERVICE_TASK_NAME}" is registered for this user.`,
          impact:
            'After a reboot nothing starts the Core Service, so Telegram commands, remote approvals, ' +
            'scheduled missions and the desktop client all stay silent until someone runs "serve" by hand.',
          fix: {
            description: 'Install the Core Service logon task (it also restarts the service if it crashes).',
            safe: true,
            apply: async (ctx) => {
              try {
                ctx.runSchedulerScript('install-daemon-task.ps1');
                return autostartState().installed
                  ? { ok: true, message: 'Core Service logon task installed.' }
                  : { ok: false, message: 'The script ran but the task was not registered. Retry from an elevated PowerShell.' };
              } catch (error) {
                return { ok: false, message: error.message };
              }
            },
          },
        }));
  }

  return findings;
}

/**
 * Print findings exactly as `doctor` has always looked (✔/⚠/✘ + label +
 * dim detail), one per line, in a `chalk`-colored terminal-friendly format.
 *
 * @param {DoctorFinding[]} findings
 * @param {object} chalk - Injected so this stays dependency-light (tests
 *   can pass a no-op colorizer; the CLI passes the real `chalk`).
 */
export function renderDoctorFindings(findings, chalk) {
  const color = { ok: chalk.green, warn: chalk.yellow, fail: chalk.red };
  console.log(chalk.bold('\nAI-Orchestrator doctor\n'));
  for (const f of findings) {
    if (f.id === 'running-instance') {
      // Preserved verbatim from the pre-M3 doctor: a standalone note, not a
      // ✔/⚠/✘ check line.
      console.log(chalk.yellow(`\n  An orchestrator is currently running (${f.label}).`));
      continue;
    }
    const mark = color[f.status](CHECK_MARK[f.status]);
    console.log(`  ${mark} ${f.label}${f.detail ? chalk.dim(` — ${f.detail}`) : ''}`);
  }
  console.log('');
}

/**
 * Apply one finding's fix. Callers are responsible for confirming with the
 * operator first — this function only performs the repair and reports the
 * result; it never asks anything itself.
 *
 * @param {DoctorFinding} finding - Must have a `.fix`.
 * @param {object} ctx - Dependencies the fix's `apply()` may need:
 *   `{ configManager, paths, prompter, projectWizard, telegramWizard,
 *   emailWizard, runSchedulerScript }`.
 * @returns {Promise<{ok: boolean, message: string}>}
 */
export async function applyDoctorFix(finding, ctx) {
  if (!finding.fix) return { ok: false, message: 'This finding has no automated fix.' };
  try {
    return await finding.fix.apply(ctx);
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

export default { buildDoctorFindings, renderDoctorFindings, applyDoctorFix, SCHEDULED_TASK_NAME };
