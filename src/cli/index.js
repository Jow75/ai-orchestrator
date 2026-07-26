/**
 * cli/index.js — Command-line interface.
 *
 * The human control surface of AI-Orchestrator:
 *
 *   start [project]        Launch (or resume) supervision of a project
 *   resume [project]       Resume only if something was interrupted
 *   stop                   Ask the running orchestrator to stop gracefully
 *   status                 Show live status (from status.json)
 *   sessions [project]     Show active sessions / a project's history
 *   tasks list|add|remove|reorder|approve|skip   Manage a project's task
 *                           queue (Phase P2/P3); approve/skip are Phase P7
 *                           operator overrides for a blocked/failed task
 *   memory list|add|resolve   Manage a project's long-term memory (Phase P5)
 *   agents list|health|message  Inspect the roster & performance (Phase 9); post cross-agent messages (Phase 10H)
 *   approvals ...          Approval requests + operating modes (Phase 10A/10B)
 *   lifecycle <project>    Standardized mission lifecycle + history (Phase 10D)
 *   intel <project>        Project intelligence recommendations (Phase 10E)
 *   improve [project]      Self-improvement analysis from history (Phase 10I)
 *   schedules ...          Scheduled missions incl. missed-run recovery (Phase 10G)
 *   coordination <project> Locks, ready tasks, dependency stalls, messages (Phase 10H)
 *   release prepare|apply  Approval-aware release automation (Phase 10J)
 *   api-token [--rotate]    Show/rotate the dashboard API's mutating-endpoint token (Phase P7)
 *   projects list|add      Manage project definitions
 *   drivers                List available AI engine drivers
 *   scheduler ...          Install/inspect the Windows auto-start task
 *   doctor                 Diagnose the environment and configuration
 *
 * The CLI is a thin shell: all real behaviour lives in the application
 * modules, so everything here is also available programmatically.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import chalk from 'chalk';
import App, { STOP_REQUEST_FILENAME } from '../app.js';
import ConfigManager, { ConfigError } from '../config/configManager.js';
import { silentLogger } from '../infra/logger.js';
import SessionManager, { SessionState } from '../state/sessionManager.js';
import MissionTimeline from '../state/missionTimeline.js';
import TaskQueue from '../mission/taskQueue.js';
import { validateSingleTask } from '../mission/missionPlan.js';
import MemoryStore from '../memory/memoryStore.js';
import { loadOrCreateToken } from '../api/apiAuth.js';
import DriverRegistry from '../drivers/driverRegistry.js';
import AgentRegistry from '../agents/agentRegistry.js';
import AgentHealth from '../agents/agentHealth.js';
import { readJsonSafe } from '../state/statePersistence.js';
import { isPidAlive } from '../state/heartbeat.js';
import { formatDuration } from '../infra/time.js';
import { ROOT_DIR } from '../infra/paths.js';
// Phase 10 surfaces.
import ApprovalStore from '../approvals/approvalStore.js';
import { MODES, isKnownMode, effectiveApprovalConfig } from '../approvals/approvalPolicy.js';
import MissionLifecycle from '../mission/missionLifecycle.js';
import ProjectIntelligence from '../intelligence/projectIntelligence.js';
import SelfImprovement from '../intelligence/selfImprovement.js';
import MissionScheduler from '../scheduler/missionScheduler.js';
import { buildActivitySummary } from '../scheduler/activitySummary.js';
import ResourceLockManager from '../coordination/resourceLocks.js';
import AgentMessageBus from '../coordination/agentMessages.js';
import { readyTasks, blockedByDependencies } from '../coordination/dependencyGraph.js';
import ReleaseManager from '../release/releaseManager.js';
import ApprovalManager from '../approvals/approvalManager.js';
import { ProgressLedger } from '../progress/progressLedger.js';
import NotificationEngine from '../notifications/notificationEngine.js';
import NotificationState from '../notifications/notificationState.js';
// Phase 11 onboarding wizards (CLI-first).
import { createPrompter } from '../onboarding/prompts.js';
import { runProjectWizard } from '../onboarding/projectWizard.js';
import { runTelegramSetup, runEmailSetup } from '../onboarding/notifyWizard.js';
import { runInit } from '../onboarding/init.js';
import { buildDoctorFindings, renderDoctorFindings, applyDoctorFix, SCHEDULED_TASK_NAME } from '../doctor/doctor.js';
import { userFacingError } from '../infra/errors.js';

/** Build a ConfigManager + quiet SessionManager for read-only commands. */
function readOnlyContext() {
  const configManager = new ConfigManager();
  const paths = configManager.getPaths();
  const sessionManager = new SessionManager({
    sessionsDir: paths.sessionsDir,
    logger: silentLogger,
  });
  return { configManager, paths, sessionManager };
}

/**
 * Build the agent registry/health + resolved roster for the `agents`
 * commands. With a project name the roster is that project's effective
 * roster (which is the implicit default agent for an agent-less project);
 * without one it's the global `config/agents.json` roster.
 */
function agentContext(projectName) {
  const configManager = new ConfigManager();
  const paths = configManager.getPaths();
  const driverRegistry = new DriverRegistry({ logger: silentLogger });
  const registry = new AgentRegistry({ driverRegistry, logger: silentLogger, agentsFile: paths.agentsFile });
  const health = new AgentHealth({ healthFile: paths.agentHealthFile, logger: silentLogger });
  const roster = projectName
    ? registry.agentsFor(configManager.getProject(projectName))
    : registry.globalAgents();
  return { configManager, paths, registry, health, roster };
}

/** Uniform fatal-error rendering for every command. */
function fail(error) {
  // ConfigError and errors flagged `userFacing` are user-fixable problems
  // whose message already states the remedy — a stack trace only buries it.
  const userFacing = error instanceof ConfigError || error.userFacing === true;
  const message = userFacing ? error.message : (error.stack ?? error.message);
  console.error(chalk.red(`\nError: ${error.message}`));
  if (message !== error.message) console.error(chalk.dim(message));
  process.exitCode = 1;
}

/**
 * Guided recovery (Phase 11 M3): the exact next command for a blocked/failed
 * current task — never leave the operator to recall `tasks approve`/`tasks
 * skip`'s syntax themselves. Pure/exported so it's unit-testable without a
 * CLI harness (the CLI itself stays a thin shell around this).
 *
 * @param {string} project
 * @param {object} [task] - The queue's current task entry, if any.
 * @returns {string|null} Null when the task isn't blocked/failed.
 */
export function taskRecoveryHint(project, task) {
  if (!task || (task.state !== 'blocked' && task.state !== 'failed')) return null;
  return `Task "${task.id}" is ${task.state}. Retry it: ai-orchestrator tasks approve ${project} ${task.id}` +
    ` — or skip past it: ai-orchestrator tasks skip ${project} ${task.id}`;
}

/**
 * Guided recovery: the exact reply grammar + CLI equivalent for one pending
 * approval request, matching ApprovalManager#renderRequestMessage's wording.
 *
 * @param {object} request - An approval request record.
 * @returns {string|null} Null when the request isn't pending (nothing to reply to).
 */
export function approvalReplyHint(request) {
  if (request.status !== 'pending') return null;
  const reply = request.approvalClass === 'human-action'
    ? `DONE ${request.id}`
    : `APPROVE ${request.id} · REJECT ${request.id} [reason] · MODIFY ${request.id} <changes>`;
  return `Reply: ${reply}  (or: ai-orchestrator approvals approve ${request.id})`;
}

export function buildProgram() {
  const program = new Command();

  program
    .name('ai-orchestrator')
    .description('Autonomous supervisor for AI coding agents (Claude Code and friends)')
    .version('2.5.1');

  program
    .command('init')
    .description('Guided first-run setup: create a project, connect your phone, and go (Phase 11)')
    .action(async () => {
      try {
        const configManager = new ConfigManager();
        const prompter = createPrompter();
        try {
          await runInit({
            configManager,
            prompter,
            probe: probeEnvironment,
            notifyTest: () => testNotificationChannels(configManager),
            autoResume: process.platform === 'win32' ? {
              isInstalled: async () => spawnSync(
                'schtasks', ['/Query', '/TN', SCHEDULED_TASK_NAME],
                { encoding: 'utf8', windowsHide: true }
              ).status === 0,
              install: async () => { runSchedulerScript('install-task.ps1'); },
            } : null,
            // Mirrors the `start` command's own App usage — offering to
            // launch right here is how `init` closes the "how do I actually
            // start this thing?" gap found in the live walkthrough.
            startMission: async (name) => new App().start({ projectNames: [name] }),
          });
        } finally {
          prompter.close();
        }
      } catch (error) {
        fail(error);
      }
    });

  program
    .command('start')
    .argument('[projects...]', 'project name(s) — several names run IN PARALLEL (Phase 10H)')
    .option('--fresh', 'abandon any interrupted session and start the mission over')
    .description('Start (or resume) supervising one project — or several in parallel — until the mission(s) complete')
    .action(async (projects, options) => {
      try {
        const app = new App();
        const result = await app.start({ projectNames: projects, fresh: options.fresh });
        if (Array.isArray(result)) {
          console.log('');
          for (const mission of result) {
            const mark = mission.complete ? chalk.green('✔') : chalk.yellow('■');
            console.log(`${mark} ${chalk.bold(mission.project)}: ${mission.reason}`);
          }
        } else if (result?.complete) {
          console.log(chalk.green(`\n✔ Mission complete: ${result.reason}`));
        } else if (result) {
          console.log(chalk.yellow(`\n■ Supervision ended: ${result.reason}`));
        }
      } catch (error) {
        fail(error);
      }
    });

  program
    .command('resume')
    .argument('[project]', 'project name')
    .description('Resume supervision only if an interrupted session exists (used at boot)')
    .action(async (project) => {
      try {
        const app = new App();
        const result = await app.start({ projectName: project, onlyIfResumable: true });
        if (result === null) {
          console.log('Nothing to resume.');
        }
      } catch (error) {
        fail(error);
      }
    });

  program
    .command('stop')
    .description('Ask the running orchestrator to stop gracefully (session stays resumable)')
    .action(() => {
      try {
        const { paths } = readOnlyContext();
        const heartbeat = readJsonSafe(paths.heartbeatFile);
        if (!heartbeat || heartbeat.state !== 'running' || !isPidAlive(heartbeat.pid)) {
          console.log('No running orchestrator found.');
          return;
        }
        fs.writeFileSync(path.join(paths.stateDir, STOP_REQUEST_FILENAME), '');
        console.log(
          `Stop requested (pid ${heartbeat.pid}). ` +
          'The orchestrator will stop after the current agent process exits or within a few seconds.'
        );
      } catch (error) {
        fail(error);
      }
    });

  program
    .command('status')
    .description('Show what the orchestrator is doing right now')
    .action(() => {
      try {
        const { paths } = readOnlyContext();
        const status = readJsonSafe(paths.statusFile);
        if (!status) {
          console.log('No status.json yet — the orchestrator has not run.');
          return;
        }
        printStatus(status, paths.statusFile);
      } catch (error) {
        fail(error);
      }
    });

  program
    .command('sessions')
    .argument('[project]', 'show history for one project')
    .option('--abandon', 'archive the project\'s stale resumable session WITHOUT launching anything (the next start begins fresh)')
    .description('List active sessions, or one project’s session history')
    .action((project, options) => {
      try {
        const { sessionManager, paths } = readOnlyContext();
        if (options.abandon) {
          if (!project) {
            console.error(chalk.red('\n--abandon needs a project name: sessions <project> --abandon'));
            process.exitCode = 1;
            return;
          }
          const session = sessionManager.getResumableSession(project);
          if (!session) {
            console.log(`No resumable session for "${project}" — nothing to abandon.`);
            return;
          }
          const heartbeat = readJsonSafe(paths.heartbeatFile);
          if (heartbeat?.state === 'running' && isPidAlive(heartbeat.pid)
            && heartbeat.project === project) {
            console.error(chalk.red(
              `\nAn orchestrator (pid ${heartbeat.pid}) is actively supervising "${project}" — ` +
              'use "ai-orchestrator stop" instead.'
            ));
            process.exitCode = 1;
            return;
          }
          sessionManager.closeSession(session, SessionState.STOPPED);
          console.log(chalk.green(
            `Session ${session.id} (${project}) abandoned — archived as stopped. ` +
            'The next start begins the mission fresh.'
          ));
          return;
        }
        if (project) {
          const history = sessionManager.getHistory(project);
          const active = sessionManager.getActiveSession(project);
          if (active) printSession(active, 'ACTIVE');
          if (!history.length && !active) console.log(`No sessions recorded for "${project}".`);
          for (const record of history) printSession(record, 'archived');
        } else {
          const active = sessionManager.listActiveSessions();
          if (!active.length) {
            console.log('No active sessions.');
            return;
          }
          for (const record of active) printSession(record, 'ACTIVE');
        }
      } catch (error) {
        fail(error);
      }
    });

  program
    .command('timeline')
    .argument('<project>', 'project name')
    .option('-n, --limit <n>', 'show only the last N entries', String)
    .description('Show a project’s mission timeline (key events over time)')
    .action((project, options) => {
      try {
        const { paths } = readOnlyContext();
        const timeline = new MissionTimeline({
          timelineDir: paths.timelineDir,
          logger: silentLogger,
        });
        let entries = timeline.read(project);
        if (!entries.length) {
          console.log(`No timeline recorded for "${project}" yet.`);
          return;
        }
        const limit = Number(options.limit);
        if (Number.isInteger(limit) && limit > 0) entries = entries.slice(-limit);
        console.log(chalk.bold(`\nMission timeline — ${project}\n`));
        for (const entry of entries) {
          const time = new Date(entry.at).toLocaleString();
          console.log(`  ${chalk.dim(time)}  ${eventColor(entry.event)(entry.label)}`);
        }
        console.log('');
      } catch (error) {
        fail(error);
      }
    });

  const tasks = program
    .command('tasks')
    .description('Manage a project’s task queue (Phase P2 mission mode / P3 runtime queue)');

  tasks
    .command('list')
    .argument('<project>', 'project name')
    .description('Show a project’s task queue')
    .action((project) => {
      try {
        const { paths } = readOnlyContext();
        const taskQueue = new TaskQueue({ tasksDir: paths.tasksDir, logger: silentLogger });
        const queue = taskQueue.load(project);
        if (!queue) {
          console.log(
            `No task queue for "${project}" — either it hasn't run yet, or it is a ` +
            'legacy (single-prompt) project with no tasks queued.'
          );
          return;
        }
        console.log(chalk.bold(`\nTask queue — ${project}\n`));
        queue.tasks.forEach((task, index) => {
          const marker = index === queue.currentIndex ? chalk.cyan('→') : ' ';
          console.log(
            `  ${marker} ${chalk.bold(task.id)} — ${taskStateColor(task.state)(task.state)} ` +
            `(attempts: ${task.attempts})` +
            (task.objective ? chalk.dim(` — ${task.objective}`) : '')
          );
          if (task.checkpoint?.summary) {
            console.log(chalk.dim(`      ${truncateLine(task.checkpoint.summary, 100)}`));
          }
        });

        const hint = taskRecoveryHint(project, queue.tasks[queue.currentIndex]);
        if (hint) console.log(chalk.yellow(`\n  ${hint}`));
        console.log('');
      } catch (error) {
        fail(error);
      }
    });

  tasks
    .command('add')
    .argument('<project>', 'project name')
    .requiredOption('--id <id>', 'unique task id (e.g. "T3")')
    .requiredOption('--prompt <file>', 'this task’s prompt file (relative to the project’s working directory, or absolute)')
    .option('--objective <text>', 'human-readable description (defaults to the id)')
    .option('--max-runs <n>', 'launches allowed before this task blocks (default 5)', String)
    .option('--verify-file <file>', 'a JSON file containing this task’s "verify" array')
    .description('Queue a new task onto a project (Phase P3) — runs on the next start')
    .action((project, options) => {
      try {
        const { configManager, paths } = readOnlyContext();
        // Reuses full project validation (workingDirectory, driver, ...) —
        // tasks add builds on top of an already-valid project, it does not
        // replace the need for one.
        const projectConfig = configManager.getProject(project);
        const taskQueue = new TaskQueue({ tasksDir: paths.tasksDir, logger: silentLogger });
        const queue = taskQueue.ensure(project);

        let verify = [];
        if (options.verifyFile) {
          verify = JSON.parse(fs.readFileSync(path.resolve(options.verifyFile), 'utf8'));
        }
        const { task, problems } = validateSingleTask(
          {
            id: options.id,
            prompt: options.prompt,
            objective: options.objective,
            maxRuns: options.maxRuns ? Number(options.maxRuns) : undefined,
            verify,
          },
          {
            label: `task "${options.id}"`,
            workingDirectory: projectConfig.workingDirectory,
            seenIds: new Set(queue.tasks.map((t) => t.id)),
          }
        );
        if (problems.length) {
          console.error(chalk.red(`\nCannot add task:\n - ${problems.join('\n - ')}`));
          process.exitCode = 1;
          return;
        }

        taskQueue.enqueue(queue, task);
        console.log(
          chalk.green(`Task "${task.id}" queued for "${project}" (position ${queue.tasks.length}).`)
        );
      } catch (error) {
        fail(error);
      }
    });

  tasks
    .command('remove')
    .argument('<project>', 'project name')
    .argument('<taskId>', 'id of the task to remove')
    .description('Remove a not-yet-started task from the queue')
    .action((project, taskId) => {
      try {
        const { paths } = readOnlyContext();
        const taskQueue = new TaskQueue({ tasksDir: paths.tasksDir, logger: silentLogger });
        const queue = taskQueue.load(project);
        if (!queue) {
          console.log(`No task queue for "${project}".`);
          return;
        }
        const result = taskQueue.removeTask(queue, taskId);
        if (!result.ok) {
          console.error(chalk.red(`\n${result.reason}`));
          process.exitCode = 1;
          return;
        }
        console.log(chalk.green(`Removed task "${taskId}" from "${project}".`));
      } catch (error) {
        fail(error);
      }
    });

  tasks
    .command('reorder')
    .argument('<project>', 'project name')
    .argument('<taskId>', 'id of the task to move')
    .argument('<direction>', '"up" (earlier) or "down" (later)')
    .description('Move a not-yet-started task earlier or later in the queue')
    .action((project, taskId, direction) => {
      try {
        if (direction !== 'up' && direction !== 'down') {
          console.error(chalk.red('\nDirection must be "up" or "down".'));
          process.exitCode = 1;
          return;
        }
        const { paths } = readOnlyContext();
        const taskQueue = new TaskQueue({ tasksDir: paths.tasksDir, logger: silentLogger });
        const queue = taskQueue.load(project);
        if (!queue) {
          console.log(`No task queue for "${project}".`);
          return;
        }
        const result = taskQueue.reorderTask(queue, taskId, direction);
        if (!result.ok) {
          console.error(chalk.red(`\n${result.reason}`));
          process.exitCode = 1;
          return;
        }
        console.log(chalk.green(`Moved task "${taskId}" ${direction}.`));
      } catch (error) {
        fail(error);
      }
    });

  tasks
    .command('approve')
    .argument('<project>', 'project name')
    .argument('<taskId>', 'id of the current BLOCKED/FAILED task to retry')
    .description('Operator override (Phase P7): reset a blocked/failed task to PENDING so the next start retries it')
    .action((project, taskId) => {
      try {
        const { paths } = readOnlyContext();
        const taskQueue = new TaskQueue({
          tasksDir: paths.tasksDir,
          logger: silentLogger,
          lifecycle: new MissionLifecycle({ lifecycleDir: paths.lifecycleDir, logger: silentLogger }),
        });
        const queue = taskQueue.load(project);
        if (!queue) {
          console.log(`No task queue for "${project}".`);
          return;
        }
        const result = taskQueue.approveRetry(queue, taskId);
        if (!result.ok) {
          console.error(chalk.red(`\n${result.reason}`));
          process.exitCode = 1;
          return;
        }
        console.log(chalk.green(`Task "${taskId}" approved for retry — the next start will retry it.`));
      } catch (error) {
        fail(error);
      }
    });

  tasks
    .command('skip')
    .argument('<project>', 'project name')
    .argument('<taskId>', 'id of the current BLOCKED/FAILED task to skip')
    .option('--reason <text>', 'why this task is being skipped (recorded on its checkpoint)')
    .description('Operator override (Phase P7): mark a blocked/failed task done and advance past it')
    .action((project, taskId, options) => {
      try {
        const { paths } = readOnlyContext();
        const taskQueue = new TaskQueue({
          tasksDir: paths.tasksDir,
          logger: silentLogger,
          lifecycle: new MissionLifecycle({ lifecycleDir: paths.lifecycleDir, logger: silentLogger }),
        });
        const queue = taskQueue.load(project);
        if (!queue) {
          console.log(`No task queue for "${project}".`);
          return;
        }
        const result = taskQueue.operatorSkip(queue, taskId, options.reason);
        if (!result.ok) {
          console.error(chalk.red(`\n${result.reason}`));
          process.exitCode = 1;
          return;
        }
        console.log(chalk.green(`Task "${taskId}" skipped.`));
      } catch (error) {
        fail(error);
      }
    });

  program
    .command('api-token')
    .option('--rotate', 'generate a new token, invalidating the previous one')
    .description('Show (or rotate) the local token required by the dashboard API\'s mutating endpoints (Phase P7)')
    .action((options) => {
      try {
        const { paths } = readOnlyContext();
        const token = loadOrCreateToken(paths.apiTokenFile, { rotate: Boolean(options.rotate) });
        if (options.rotate) {
          console.log(chalk.green('Rotated. New API token:'));
        } else {
          console.log('API token:');
        }
        console.log(token);
      } catch (error) {
        fail(error);
      }
    });

  const memory = program
    .command('memory')
    .description('Manage a project’s long-term memory (Phase P5) — notes, failure catalog, task history');

  memory
    .command('list')
    .argument('<project>', 'project name')
    .description('Show a project’s memory: operator notes, failures, and archived task history')
    .action((project) => {
      try {
        const { paths } = readOnlyContext();
        const memoryStore = new MemoryStore({ memoryDir: paths.memoryDir, logger: silentLogger });
        const mem = memoryStore.load(project);
        if (!mem) {
          console.log(`No memory recorded yet for "${project}".`);
          return;
        }
        console.log(chalk.bold(`\nMemory — ${project}\n`));

        console.log(chalk.bold('Notes:'));
        if (!mem.notes.length) console.log(chalk.dim('  (none)'));
        for (const note of mem.notes) {
          console.log(`  #${note.id} [${note.category}] ${note.text}`);
        }

        console.log(chalk.bold('\nFailures:'));
        if (!mem.failures.length) console.log(chalk.dim('  (none)'));
        for (const f of mem.failures) {
          const status = f.resolved ? chalk.green('resolved') : chalk.red('unresolved');
          const scope = f.taskId ? `task "${f.taskId}"` : 'mission';
          console.log(`  #${f.id} [${status}] (${scope}) ${f.reason}`);
        }

        console.log(chalk.bold('\nArchived task history:'));
        if (!mem.taskHistory.length) console.log(chalk.dim('  (none)'));
        for (const h of mem.taskHistory) {
          console.log(`  ${h.taskId}: ${h.outcome} after ${h.attempts} attempt(s)`);
        }
        console.log('');
      } catch (error) {
        fail(error);
      }
    });

  memory
    .command('add')
    .argument('<project>', 'project name')
    .requiredOption('--note <text>', 'the durable fact to remember')
    .option('--category <category>', '"project" (general) or "architecture" (build/structure/conventions)', 'project')
    .description('Record a durable, operator-authored fact — surfaced in every future resume/retry briefing')
    .action((project, options) => {
      try {
        if (options.category !== 'project' && options.category !== 'architecture') {
          console.error(chalk.red('\n--category must be "project" or "architecture".'));
          process.exitCode = 1;
          return;
        }
        const { paths } = readOnlyContext();
        const memoryStore = new MemoryStore({ memoryDir: paths.memoryDir, logger: silentLogger });
        memoryStore.addNote(project, { category: options.category, text: options.note });
        console.log(chalk.green(`Noted for "${project}".`));
      } catch (error) {
        fail(error);
      }
    });

  memory
    .command('resolve')
    .argument('<project>', 'project name')
    .argument('<failureId>', 'id of the failure to mark resolved', Number)
    .description('Mark a recorded failure resolved — it stops appearing in future briefings')
    .action((project, failureId) => {
      try {
        const { paths } = readOnlyContext();
        const memoryStore = new MemoryStore({ memoryDir: paths.memoryDir, logger: silentLogger });
        const result = memoryStore.resolveFailure(project, failureId);
        if (!result.ok) {
          console.error(chalk.red(`\n${result.reason}`));
          process.exitCode = 1;
          return;
        }
        console.log(chalk.green(`Failure #${failureId} marked resolved for "${project}".`));
      } catch (error) {
        fail(error);
      }
    });

  const projects = program.command('projects').description('Manage project definitions');

  projects
    .command('list')
    .description('List defined projects')
    .action(() => {
      try {
        const { configManager, sessionManager } = readOnlyContext();
        const names = configManager.listProjects();
        if (!names.length) {
          console.log('No projects defined. Create one with "ai-orchestrator projects add".');
          return;
        }
        for (const name of names) {
          const session = sessionManager.getActiveSession(name);
          const marker = session ? chalk.green(` [active: ${session.state}]`) : '';
          console.log(`  ${chalk.bold(name)}${marker}`);
        }
      } catch (error) {
        fail(error);
      }
    });

  projects
    .command('add')
    .argument('[name]', 'project name (prompted for when --interactive)')
    .option('-i, --interactive', 'create the project through guided prompts (recommended for a first project)')
    .option('--dir <path>', 'working directory the agent operates in')
    .option('--prompt <file>', 'mission prompt file (relative to --dir or absolute)')
    .option('--driver <id>', 'AI engine driver', 'claude')
    .option(
      '--permission-mode <mode>',
      'claude driver only: --permission-mode passed to the engine ' +
      '(acceptEdits, bypassPermissions, or "" to run read-only)',
      'acceptEdits'
    )
    .description('Create a new project definition (add --interactive for a guided wizard)')
    .action(async (name, options) => {
      try {
        const { configManager } = readOnlyContext();

        // Guided path (Phase 11B): the wizard asks every question, creates
        // the working dir / starter prompt, validates, and writes the file.
        if (options.interactive) {
          const prompter = createPrompter();
          try {
            await runProjectWizard({ configManager, prompter, name });
          } finally {
            prompter.close();
          }
          return;
        }

        // Non-interactive path (unchanged): --dir and --prompt are required.
        if (!name || !options.dir || !options.prompt) {
          throw userFacingError({
            cause: '"projects add" needs <name>, --dir and --prompt.',
            fix: 'run "ai-orchestrator projects add --interactive" for a guided wizard instead.',
          });
        }
        const definition = {
          driver: options.driver,
          workingDirectory: path.resolve(options.dir),
          promptFile: options.prompt,
        };
        // An unattended headless engine cannot answer permission prompts —
        // without a permission mode every run is effectively read-only and
        // the mission blocks on "no progress" (the #1 new-user trap).
        if (options.driver === 'claude' && options.permissionMode) {
          definition.claude = { permissionMode: options.permissionMode };
        }
        const file = configManager.saveProject(name, definition);
        console.log(chalk.green(`Project created: ${file}`));
        if (definition.claude) {
          console.log(
            `Engine permission mode: ${definition.claude.permissionMode} ` +
            '(unattended runs must be able to write — see CONFIGURATION.md "claude")'
          );
        } else if (options.driver === 'claude') {
          console.log(chalk.yellow(
            'No permission mode set — unattended runs will be read-only and will block. ' +
            'Set "claude.permissionMode" in the project JSON before a real mission.'
          ));
        }
        console.log(`Start it with:  ai-orchestrator start ${name}`);
      } catch (error) {
        fail(error);
      }
    });

  const notify = program
    .command('notify')
    .description('Notification utilities (Phase 10.5)');

  notify
    .command('test')
    .description('Send a test notification through every enabled channel and report each result')
    .action(async () => {
      try {
        const configManager = new ConfigManager();
        const engine = new NotificationEngine({
          config: configManager.get('notifications', {}),
          logger: silentLogger,
        });
        if (!engine.channels.length) {
          console.log(
            'No notification channels enabled. Enable one in config/orchestrator.json ' +
            '(credentials belong in the git-ignored config/local.json) — see ' +
            'docs/TELEGRAM_SETUP.md and docs/EMAIL_SETUP.md.'
          );
          return;
        }
        console.log(chalk.bold('\nNotification channel test\n'));
        for (const channel of engine.channels) {
          try {
            // eslint-disable-next-line no-await-in-loop
            await channel.send({
              title: 'AI-Orchestrator — test notification',
              message: `If you can read this, the "${channel.name}" channel works. (${new Date().toLocaleString()})`,
              event: 'notify:test',
              payload: {},
              severity: 'info',
            });
            console.log(`  ${chalk.green('✔')} ${channel.name}`);
          } catch (error) {
            console.log(`  ${chalk.red('✘')} ${channel.name} — ${error.message}`);
            process.exitCode = 1;
          }
        }
        console.log('');
      } catch (error) {
        fail(error);
      }
    });

  notify
    .command('setup')
    .argument('<channel>', 'telegram | email')
    .description('Guided setup for a remote channel — validates, sends a test, writes config/local.json')
    .action(async (channel) => {
      try {
        const configManager = new ConfigManager();
        const prompter = createPrompter();
        try {
          if (channel === 'telegram') {
            await runTelegramSetup({ configManager, prompter });
          } else if (channel === 'email') {
            await runEmailSetup({ configManager, prompter });
          } else {
            throw userFacingError({
              cause: `Unknown channel "${channel}".`,
              fix: 'use "telegram" or "email".',
            });
          }
        } finally {
          prompter.close();
        }
      } catch (error) {
        fail(error);
      }
    });

  notify
    .command('resend')
    .argument('<project>')
    .argument('<id>', 'approval request id, e.g. A20')
    .description('Force-resend a pending approval notification, bypassing idempotency dedup (Phase 11 M2)')
    .action(async (project, id) => {
      try {
        const configManager = new ConfigManager();
        const paths = configManager.getPaths();
        const approvalStore = new ApprovalStore({ approvalsDir: paths.approvalsDir, logger: silentLogger });
        const request = approvalStore.get(project, id);
        if (!request) {
          throw userFacingError({
            cause: `No approval request "${id}" for "${project}".`,
            fix: `check the id with "ai-orchestrator approvals list ${project}".`,
          });
        }
        if (request.status !== 'pending') {
          throw userFacingError({
            cause: `Request "${id}" is already ${request.status}.`,
            impact: 'Nothing to remind the owner about — it was already decided.',
          });
        }

        const notificationState = new NotificationState({
          notificationsDir: paths.notificationsDir, logger: silentLogger,
        });
        const engine = new NotificationEngine({
          config: configManager.get('notifications', {}), logger: silentLogger, notificationState,
        });
        const event = request.approvalClass === 'human-action' ? 'human-action:required' : 'approval:required';
        const key = event === 'human-action:required' || event === 'approval:required' ? request.id : null;
        notificationState.forceResend(project, key);

        // Reuse the manager's own rendering so a resend reads identically
        // to the original notification (same "Reply: APPROVE ..." footer).
        const approvalManager = new ApprovalManager({
          config: configManager.get('approvals', {}), store: approvalStore, providers: [], logger: silentLogger,
        });
        await engine.notify(event, {
          project, request, title: request.title, message: approvalManager.renderRequestMessage(request),
        });
        console.log(chalk.green(`Resent notification for ${id} (${project}).`));
      } catch (error) {
        fail(error);
      }
    });

  program
    .command('drivers')
    .description('List available AI engine drivers')
    .action(() => {
      const registry = new DriverRegistry({ logger: silentLogger });
      for (const id of registry.listDrivers()) {
        const driver = registry.getDriver(id);
        console.log(`  ${chalk.bold(id)} — ${driver.name}`);
      }
    });

  const agents = program
    .command('agents')
    .description('Manage the agent roster (Phase 9) — specialized agents routed per task');

  agents
    .command('list')
    .argument('[project]', 'resolve the roster for one project (else show global agents)')
    .description('Show the configured agents (id, role, driver, capabilities)')
    .action((project) => {
      try {
        const { roster } = agentContext(project);
        if (!roster.length) {
          console.log('No agents configured. Add config/agents.json (see config/agents.example.json).');
          return;
        }
        console.log(chalk.bold(`\nAgents${project ? ` — ${project}` : ''}\n`));
        for (const a of roster) {
          const impl = a.implicit ? chalk.dim(' (implicit default)') : '';
          const caps = a.capabilities?.length ? chalk.dim(` [${a.capabilities.join(', ')}]`) : '';
          console.log(
            `  ${chalk.bold(a.id)} — ${roleColor(a.role)(a.role)} · driver ${a.driver}${caps}${impl}`
          );
        }
        console.log('');
      } catch (error) {
        fail(error);
      }
    });

  agents
    .command('health')
    .argument('[project]', 'resolve the roster for one project (else show global agents)')
    .description('Show each agent\'s engine install status and task performance')
    .action((project) => {
      try {
        const { health, roster } = agentContext(project);
        if (!roster.length) {
          console.log('No agents configured.');
          return;
        }
        console.log(chalk.bold(`\nAgent health${project ? ` — ${project}` : ''}\n`));
        for (const r of health.report(roster)) {
          const install = r.installed === null
            ? chalk.dim('unchecked')
            : (r.installed ? chalk.green(`installed${r.version ? ` (${r.version})` : ''}`) : chalk.red(`missing — ${r.installError ?? ''}`));
          console.log(`  ${chalk.bold(r.agentId)} — ${roleColor(r.role)(r.role)} · ${install}`);
          console.log(chalk.dim(
            `      done ${r.tasksDone} · failed ${r.tasksFailed} · blocked ${r.tasksBlocked}` +
            ` · attempts ${r.totalAttempts}` +
            (r.totalRuns ? ` · runs ${r.totalRuns} (avg ${formatDuration(r.avgRunMs ?? 0)})` : '') +
            (r.lastUsedAt ? ` · last used ${r.lastUsedAt}` : '')
          ));
        }
        console.log('');
      } catch (error) {
        fail(error);
      }
    });

  agents
    .command('message')
    .argument('<project>', 'project name')
    .requiredOption('--from <agent>', 'sending agent id (or "operator")')
    .requiredOption('--to <recipient>', 'an agent id, "role:<role>", or "all"')
    .requiredOption('--text <text>', 'the message body')
    .option('--topic <topic>', 'short topic tag')
    .description('Post a cross-agent message (Phase 10H) — folded into the recipient’s next briefing')
    .action((project, options) => {
      try {
        const { paths } = readOnlyContext();
        const bus = new AgentMessageBus({ coordinationDir: paths.coordinationDir, logger: silentLogger });
        const message = bus.post(project, {
          from: options.from, to: options.to, topic: options.topic, text: options.text,
        });
        console.log(chalk.green(`Message #${message.id} posted (${options.from} → ${options.to}).`));
      } catch (error) {
        fail(error);
      }
    });

  // ── Phase 10A/10B: approvals ──────────────────────────────────────────

  const approvals = program
    .command('approvals')
    .description('Manage approval requests (Phase 10A) and operating modes (10B)');

  approvals
    .command('list')
    .argument('[project]', 'one project’s full request history (else all pending)')
    .description('Show pending approval requests (or one project’s history)')
    .action((project) => {
      try {
        const { paths } = readOnlyContext();
        const store = new ApprovalStore({ approvalsDir: paths.approvalsDir, logger: silentLogger });
        const requests = project ? store.list(project) : store.pendingAll();
        if (!requests.length) {
          console.log(project ? `No approval requests recorded for "${project}".` : 'No pending approvals.');
          return;
        }
        console.log(chalk.bold(`\nApprovals${project ? ` — ${project}` : ' (pending)'}\n`));
        for (const r of requests) {
          const status = {
            pending: chalk.yellow, approved: chalk.green, done: chalk.green,
            'auto-approved': chalk.green, rejected: chalk.red,
          }[r.status] ?? chalk.white;
          console.log(
            `  ${chalk.bold(r.id)} [${r.project}] ${status(r.status)} — ` +
            `${r.category} (${r.approvalClass})${r.taskId ? chalk.dim(` task ${r.taskId}`) : ''}`
          );
          console.log(chalk.dim(`      ${truncateLine(r.title, 100)} — ${new Date(r.createdAt).toLocaleString()}`));
          const reply = approvalReplyHint(r);
          if (reply) console.log(chalk.dim(`      ${reply}`));
        }
        console.log('');
      } catch (error) {
        fail(error);
      }
    });

  for (const [verb, decision] of [
    ['approve', 'approved'], ['reject', 'rejected'], ['modify', 'modified'], ['done', 'done'],
  ]) {
    approvals
      .command(verb)
      .argument('<id>', 'approval request id (e.g. A7)')
      .argument('[note...]', 'optional note (required for modify)')
      .description(
        verb === 'done'
          ? 'Report a required human action as completed — the paused mission continues'
          : `${verb.charAt(0).toUpperCase() + verb.slice(1)} a pending approval request`
      )
      .action((id, noteWords) => {
        try {
          const note = noteWords?.length ? noteWords.join(' ') : undefined;
          if (decision === 'modified' && !note) {
            console.error(chalk.red('\nMODIFY needs a note: approvals modify A7 <what to change>'));
            process.exitCode = 1;
            return;
          }
          const { paths } = readOnlyContext();
          const store = new ApprovalStore({ approvalsDir: paths.approvalsDir, logger: silentLogger });
          const result = store.resolveById(id, { decision, note, by: 'owner', via: 'cli' });
          if (!result.ok) {
            console.error(chalk.red(`\n${result.reason}`));
            process.exitCode = 1;
            return;
          }
          console.log(chalk.green(
            `Request ${id} ${decision}. A mission paused on it picks the decision up within seconds.`
          ));
        } catch (error) {
          fail(error);
        }
      });
  }

  approvals
    .command('mode')
    .argument('[project]', 'show the effective mode for one project')
    .option('--set <mode>', `change the mode (${MODES.join(' | ')})`)
    .description('Show or set the operating mode (Phase 10B) — globally or per project')
    .action((project, options) => {
      try {
        const configManager = new ConfigManager();
        const globalConfig = configManager.getAll().approvals ?? {};
        if (options.set) {
          if (!isKnownMode(options.set)) {
            console.error(chalk.red(`\nUnknown mode "${options.set}". Use: ${MODES.join(', ')}.`));
            process.exitCode = 1;
            return;
          }
          const paths = configManager.getPaths();
          const file = project
            ? path.join(paths.projectsDir, `${project}.json`)
            : path.join(paths.configDir, 'orchestrator.json');
          if (project && !fs.existsSync(file)) {
            console.error(chalk.red(`\nProject "${project}" not found (${file}).`));
            process.exitCode = 1;
            return;
          }
          const raw = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
          raw.approvals = { ...(raw.approvals ?? {}), mode: options.set };
          fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
          console.log(chalk.green(
            `Operating mode ${project ? `for "${project}"` : '(global)'} set to "${options.set}".`
          ));
          return;
        }
        if (project) {
          const projectConfig = configManager.getProject(project);
          const effective = effectiveApprovalConfig(globalConfig, projectConfig);
          console.log(`Effective mode for "${project}": ${chalk.bold(effective.mode ?? 'balanced')}`);
        } else {
          console.log(`Global operating mode: ${chalk.bold(globalConfig.mode ?? 'balanced')}`);
        }
      } catch (error) {
        fail(error);
      }
    });

  // ── Phase 10D: lifecycle ──────────────────────────────────────────────

  program
    .command('lifecycle')
    .argument('<project>', 'project name')
    .description('Show a mission’s lifecycle state and transition history (Phase 10D)')
    .action((project) => {
      try {
        const { paths } = readOnlyContext();
        const lifecycle = new MissionLifecycle({ lifecycleDir: paths.lifecycleDir, logger: silentLogger });
        const record = lifecycle.get(project);
        if (!record) {
          console.log(`No lifecycle recorded for "${project}" yet.`);
          return;
        }
        console.log(chalk.bold(`\nMission lifecycle — ${project}\n`));
        console.log(`  Current state: ${lifecycleColor(record.state)(record.state)}\n`);
        for (const entry of record.history.slice(-20)) {
          console.log(
            `  ${chalk.dim(new Date(entry.at).toLocaleString())}  ` +
            `${entry.from ?? '(start)'} → ${lifecycleColor(entry.to)(entry.to)}` +
            (entry.reason ? chalk.dim(` — ${truncateLine(entry.reason, 80)}`) : '')
          );
        }
        console.log('');
      } catch (error) {
        fail(error);
      }
    });

  // ── Phase 10E/10I: intelligence & self-improvement ────────────────────

  program
    .command('intel')
    .argument('<project>', 'project name')
    .description('Project intelligence (Phase 10E): health, next work item, recommendations')
    .action((project) => {
      try {
        const { configManager, paths, sessionManager } = readOnlyContext();
        const intelligence = new ProjectIntelligence({
          configManager,
          sessionManager,
          taskQueue: new TaskQueue({ tasksDir: paths.tasksDir, logger: silentLogger }),
          memoryStore: new MemoryStore({ memoryDir: paths.memoryDir, logger: silentLogger }),
          ledger: new ProgressLedger({ ledgerDir: paths.ledgerDir, logger: silentLogger }),
          agentRegistry: new AgentRegistry({
            driverRegistry: new DriverRegistry({ logger: silentLogger }),
            logger: silentLogger, agentsFile: paths.agentsFile,
          }),
          agentHealth: new AgentHealth({ healthFile: paths.agentHealthFile, logger: silentLogger }),
          approvalStore: new ApprovalStore({ approvalsDir: paths.approvalsDir, logger: silentLogger }),
          lifecycle: new MissionLifecycle({ lifecycleDir: paths.lifecycleDir, logger: silentLogger }),
          logger: silentLogger,
        });
        const analysis = intelligence.analyze(project);
        console.log(chalk.bold(`\nProject intelligence — ${project}\n`));
        const healthColor = { healthy: chalk.green, attention: chalk.yellow, unhealthy: chalk.red }[analysis.health.level];
        console.log(`  Health:   ${healthColor(analysis.health.level)} (${analysis.health.score}/100) — ${analysis.health.signals.join('; ')}`);
        console.log(`  Running:  ${analysis.running ? chalk.green(`yes (${analysis.sessionState})`) : 'no'}`);
        if (analysis.lifecycleState) console.log(`  Lifecycle: ${analysis.lifecycleState}`);
        console.log(`  Next work: ${analysis.nextWorkItem ? `${analysis.nextWorkItem.taskId} — ${analysis.nextWorkItem.objective}` : chalk.dim('(nothing ready)')}`);
        console.log(chalk.bold('\n  Recommendations:'));
        if (!analysis.recommendations.length) console.log(chalk.dim('    (none)'));
        for (const rec of analysis.recommendations) {
          const priority = { high: chalk.red, medium: chalk.yellow, low: chalk.dim }[rec.priority];
          console.log(`    ${priority(`[${rec.priority}]`)} ${chalk.bold(rec.title)}`);
          console.log(chalk.dim(`        ${rec.detail}`));
        }
        console.log('');
      } catch (error) {
        fail(error);
      }
    });

  program
    .command('improve')
    .argument('[project]', 'restrict the analysis to one project')
    .description('Self-improvement analysis (Phase 10I): patterns from historical mission data')
    .action((project) => {
      try {
        const { configManager, paths } = readOnlyContext();
        const improvement = new SelfImprovement({
          listProjects: () => configManager.listProjects(),
          ledger: new ProgressLedger({ ledgerDir: paths.ledgerDir, logger: silentLogger }),
          memoryStore: new MemoryStore({ memoryDir: paths.memoryDir, logger: silentLogger }),
          taskQueue: new TaskQueue({ tasksDir: paths.tasksDir, logger: silentLogger }),
          agentHealth: new AgentHealth({ healthFile: paths.agentHealthFile, logger: silentLogger }),
          approvalStore: new ApprovalStore({ approvalsDir: paths.approvalsDir, logger: silentLogger }),
          logger: silentLogger,
        });
        const analysis = improvement.analyze(project);
        console.log(chalk.bold(`\nSelf-improvement analysis${project ? ` — ${project}` : ''}\n`));
        if (!analysis.recommendations.length) {
          console.log(chalk.dim('  No patterns strong enough to recommend anything yet — more history needed.\n'));
          return;
        }
        for (const rec of analysis.recommendations) {
          const priority = { high: chalk.red, medium: chalk.yellow, low: chalk.dim }[rec.priority];
          console.log(`  ${priority(`[${rec.priority}]`)} ${chalk.bold(rec.title)}`);
          console.log(chalk.dim(`      ${rec.detail}`));
        }
        console.log('');
      } catch (error) {
        fail(error);
      }
    });

  // ── Phase 10G: scheduled missions ─────────────────────────────────────

  const schedules = program
    .command('schedules')
    .description('Scheduled missions (Phase 10G): daily/weekly/once/cron, with missed-run recovery');

  const buildSchedulerCli = () => {
    const configManager = new ConfigManager();
    const paths = configManager.getPaths();
    const config = configManager.getAll();
    const notifications = new NotificationEngine({
      config: config.notifications, logger: silentLogger,
    });
    const approvalStore = new ApprovalStore({ approvalsDir: paths.approvalsDir, logger: silentLogger });
    const ledger = new ProgressLedger({ ledgerDir: paths.ledgerDir, logger: silentLogger });
    const timeline = new MissionTimeline({ timelineDir: paths.timelineDir, logger: silentLogger });
    const scheduler = new MissionScheduler({
      schedulesFile: paths.schedulesFile,
      stateFile: paths.schedulesStateFile,
      heartbeatFile: paths.heartbeatFile,
      rootDir: ROOT_DIR,
      logger: silentLogger,
      notifications,
      buildSummary: ({ sinceMs, now }) => buildActivitySummary({
        listProjects: () => configManager.listProjects(),
        readTimeline: (p) => timeline.read(p),
        recentLedger: (p, n) => ledger.recent(p, n),
        pendingApprovals: () => approvalStore.pendingAll(),
      }, { sinceMs, now }),
    });
    scheduler.configureSummaries(config.notifications?.summaries);
    return { scheduler, paths };
  };

  schedules
    .command('list')
    .description('Show every schedule with its last run and next due time')
    .action(() => {
      try {
        const { scheduler } = buildSchedulerCli();
        const report = scheduler.report();
        if (!report.schedules.length) {
          console.log('No schedules defined. Add one with "schedules add".');
          return;
        }
        console.log(chalk.bold('\nScheduled missions\n'));
        for (const s of report.schedules) {
          const state = s.enabled === false ? chalk.dim('disabled') : chalk.green('enabled');
          const when = s.type === 'cron' ? s.cron
            : s.type === 'once' ? s.date
              : s.type === 'weekly' ? `${s.day} ${s.time}` : `daily ${s.time}`;
          console.log(`  ${chalk.bold(s.id)} — ${s.project} · ${s.type} (${when}) · ${state}`);
          console.log(chalk.dim(
            `      last run: ${s.lastRunAt ? new Date(s.lastRunAt).toLocaleString() : 'never'}` +
            `${s.lastOutcome ? ` (${s.lastOutcome})` : ''} · next due: ` +
            `${s.nextDueAt ? new Date(s.nextDueAt).toLocaleString() : '—'}`
          ));
        }
        for (const problem of report.problems) console.log(chalk.red(`  ⚠ ${problem}`));
        console.log('');
      } catch (error) {
        fail(error);
      }
    });

  schedules
    .command('add')
    .argument('<project>', 'project the schedule launches')
    .requiredOption('--id <id>', 'unique schedule id')
    .requiredOption('--type <type>', 'daily | weekly | once | cron')
    .option('--time <HH:MM>', 'time of day (daily/weekly)')
    .option('--day <weekday>', 'weekday name (weekly)')
    .option('--date <date>', 'date/time (once), e.g. 2026-08-01T02:00')
    .option('--cron <expr>', '5-field cron expression (cron)')
    .option('--fresh', 'start the mission fresh instead of resuming')
    .option('--no-recover-missed', 'skip occurrences missed while the machine was off')
    .description('Add a scheduled mission')
    .action((project, options) => {
      try {
        const { scheduler } = buildSchedulerCli();
        const result = scheduler.add({
          id: options.id,
          project,
          type: options.type,
          time: options.time,
          day: options.day,
          date: options.date,
          cron: options.cron,
          fresh: Boolean(options.fresh),
          recoverMissed: options.recoverMissed !== false,
        });
        if (!result.ok) {
          console.error(chalk.red(`\n${result.reason}`));
          process.exitCode = 1;
          return;
        }
        console.log(chalk.green(`Schedule "${options.id}" added. Run "schedules watch" to activate it.`));
      } catch (error) {
        fail(error);
      }
    });

  schedules
    .command('remove')
    .argument('<id>', 'schedule id')
    .description('Remove a schedule')
    .action((id) => {
      try {
        const { scheduler } = buildSchedulerCli();
        const result = scheduler.remove(id);
        if (!result.ok) {
          console.error(chalk.red(`\n${result.reason}`));
          process.exitCode = 1;
          return;
        }
        console.log(chalk.green(`Schedule "${id}" removed.`));
      } catch (error) {
        fail(error);
      }
    });

  for (const [verb, enabled] of [['enable', true], ['disable', false]]) {
    schedules
      .command(verb)
      .argument('<id>', 'schedule id')
      .description(`${verb === 'enable' ? 'Enable' : 'Disable'} a schedule`)
      .action((id) => {
        try {
          const { scheduler } = buildSchedulerCli();
          const result = scheduler.setEnabled(id, enabled);
          if (!result.ok) {
            console.error(chalk.red(`\n${result.reason}`));
            process.exitCode = 1;
            return;
          }
          console.log(chalk.green(`Schedule "${id}" ${verb}d.`));
        } catch (error) {
          fail(error);
        }
      });
  }

  schedules
    .command('run-due')
    .description('Check once and launch anything due (missed occurrences included)')
    .action(async () => {
      try {
        const { scheduler } = buildSchedulerCli();
        const actions = await scheduler.runDue();
        if (!actions.length) {
          console.log('Nothing due.');
          return;
        }
        for (const action of actions) {
          console.log(`  ${chalk.bold(action.id)}: ${action.action}`);
        }
      } catch (error) {
        fail(error);
      }
    });

  schedules
    .command('watch')
    .option('--interval <seconds>', 'check cadence in seconds', '30')
    .description('Run the schedule watcher until Ctrl+C (launches due missions, sends summaries)')
    .action(async (options) => {
      try {
        const { scheduler } = buildSchedulerCli();
        const controller = new AbortController();
        for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
          process.on(signal, () => controller.abort());
        }
        console.log('Schedule watcher running (Ctrl+C to stop)...');
        await scheduler.watch({
          intervalMs: Math.max(5, Number(options.interval)) * 1000,
          signal: controller.signal,
        });
        console.log('Schedule watcher stopped.');
      } catch (error) {
        fail(error);
      }
    });

  // ── Phase 10H: coordination ───────────────────────────────────────────

  program
    .command('coordination')
    .argument('<project>', 'project name')
    .description('Coordination view (Phase 10H): held locks, ready tasks, dependency stalls, agent messages')
    .action((project) => {
      try {
        const { paths } = readOnlyContext();
        const locks = new ResourceLockManager({ coordinationDir: paths.coordinationDir, logger: silentLogger });
        const bus = new AgentMessageBus({ coordinationDir: paths.coordinationDir, logger: silentLogger });
        const queue = new TaskQueue({ tasksDir: paths.tasksDir, logger: silentLogger }).load(project);

        console.log(chalk.bold(`\nCoordination — ${project}\n`));
        const held = locks.held();
        console.log(chalk.bold('  Resource locks:'));
        if (!held.length) console.log(chalk.dim('    (none held)'));
        for (const lock of held) {
          console.log(`    ${lock.resource} — ${lock.holder?.project ?? '?'}${lock.holder?.taskId ? `/${lock.holder.taskId}` : ''}${lock.stale ? chalk.yellow(' (stale)') : ''}`);
        }

        console.log(chalk.bold('\n  Ready tasks (dependencies satisfied):'));
        const ready = queue ? readyTasks(queue) : [];
        if (!ready.length) console.log(chalk.dim('    (none)'));
        for (const t of ready) console.log(`    ${t.id} — ${t.objective ?? ''}`);

        const stalled = queue ? blockedByDependencies(queue) : [];
        if (stalled.length) {
          console.log(chalk.bold('\n  Waiting on dependencies:'));
          for (const s of stalled) console.log(`    ${s.taskId} ← ${s.waitingOn.join(', ')}`);
        }

        const messages = bus.list(project);
        console.log(chalk.bold('\n  Agent messages:'));
        if (!messages.length) console.log(chalk.dim('    (none)'));
        for (const m of messages.slice(-10)) {
          console.log(`    #${m.id} ${m.from} → ${m.to}${m.topic ? ` [${m.topic}]` : ''}: ${truncateLine(m.text, 80)}`);
        }
        console.log('');
      } catch (error) {
        fail(error);
      }
    });

  // ── Phase 10J: release automation ─────────────────────────────────────

  const release = program
    .command('release')
    .description('Release automation (Phase 10J): notes/report drafts, version bump, commit + tag');

  const buildReleaseCli = () => {
    const configManager = new ConfigManager();
    const paths = configManager.getPaths();
    const config = configManager.getAll();
    const approvalStore = new ApprovalStore({ approvalsDir: paths.approvalsDir, logger: silentLogger });
    const approvalManager = new ApprovalManager({
      config: config.approvals, store: approvalStore, providers: [], logger: silentLogger,
    });
    return new ReleaseManager({
      configManager,
      taskQueue: new TaskQueue({ tasksDir: paths.tasksDir, logger: silentLogger }),
      ledger: new ProgressLedger({ ledgerDir: paths.ledgerDir, logger: silentLogger }),
      approvalManager,
      releasesDir: paths.releasesDir,
      releaseConfig: config.release,
      logger: silentLogger,
    });
  };

  release
    .command('prepare')
    .argument('<project>', 'project name')
    .argument('<version>', 'release version, e.g. 1.4.0')
    .option('--highlights <text>', 'a lead paragraph for the notes')
    .description('Generate release-notes + verification-report drafts from mission data')
    .action((project, version, options) => {
      try {
        const manager = buildReleaseCli();
        const result = manager.prepare(project, {
          version, highlights: options.highlights,
        });
        if (!result.ok) {
          console.error(chalk.red(`\n${result.reason}`));
          process.exitCode = 1;
          return;
        }
        console.log(chalk.green(`Release ${version} drafts prepared:`));
        console.log(`  notes:  ${result.notesPath}`);
        console.log(`  report: ${result.reportPath}`);
        console.log(`Review/edit them, then: release apply ${project} ${version}`);
      } catch (error) {
        fail(error);
      }
    });

  release
    .command('apply')
    .argument('<project>', 'project name')
    .argument('<version>', 'a version prepared with "release prepare"')
    .description('Apply a prepared release: bump version, update CHANGELOG, git commit + tag (never pushes)')
    .action(async (project, version) => {
      try {
        const manager = buildReleaseCli();
        const result = await manager.apply(project, { version });
        if (!result.ok && result.pendingRequest) {
          console.log(chalk.yellow(`\n${result.reason}`));
          console.log(`  approvals approve ${result.pendingRequest.id}`);
          return;
        }
        if (!result.ok && result.reason) {
          console.error(chalk.red(`\n${result.reason}`));
          process.exitCode = 1;
          return;
        }
        for (const step of result.steps) {
          const mark = step.ok ? chalk.green('✔') : chalk.red('✘');
          console.log(`  ${mark} ${step.step}${step.detail ? chalk.dim(` — ${step.detail}`) : ''}`);
        }
        if (!result.ok) process.exitCode = 1;
        else console.log(chalk.green('\nRelease applied. Push the commit and tag when YOU are ready.'));
      } catch (error) {
        fail(error);
      }
    });

  const scheduler = program
    .command('scheduler')
    .description('Windows Task Scheduler integration (auto-start after reboot)');

  scheduler
    .command('install')
    .option('--project <name>', 'project the boot task should resume')
    .description('Install a logon task that resumes interrupted missions automatically')
    .action((options) => {
      try {
        runSchedulerScript('install-task.ps1', options.project);
      } catch (error) {
        fail(error);
      }
    });

  scheduler
    .command('uninstall')
    .description('Remove the auto-resume scheduled task')
    .action(() => {
      try {
        runSchedulerScript('uninstall-task.ps1');
      } catch (error) {
        fail(error);
      }
    });

  scheduler
    .command('status')
    .description('Show whether the auto-resume task is installed')
    .action(() => {
      const result = spawnSync(
        'schtasks',
        ['/Query', '/TN', SCHEDULED_TASK_NAME, '/FO', 'LIST'],
        { encoding: 'utf8', windowsHide: true }
      );
      if (result.status === 0) {
        console.log(chalk.green('Auto-resume task is installed:'));
        console.log(result.stdout.trim());
      } else {
        console.log('Auto-resume task is NOT installed. Run "ai-orchestrator scheduler install".');
      }
    });

  program
    .command('doctor')
    .option('--fix', 'offer to repair each flagged issue (every change is confirmed individually; read-only without this flag)')
    .description('Diagnose the environment, configuration, and engine installation')
    .action(async (options) => {
      await runDoctor({ fix: options.fix });
    });

  return program;
}

/** Render status.json for humans. */
function printStatus(status, statusFile) {
  const stateColor =
    {
      supervising: chalk.green,
      'mission-complete': chalk.green,
      'gave-up': chalk.red,
      blocked: chalk.red,
      stopped: chalk.yellow,
    }[status.orchestrator?.state] ?? chalk.white;

  console.log(chalk.bold('\nAI-Orchestrator status'));
  console.log(chalk.dim(`  (${statusFile})`));
  console.log(`  State:        ${stateColor(status.orchestrator?.state)}`);
  console.log(`  Project:      ${status.project ?? '-'}`);
  console.log(`  Uptime:       ${formatDuration(status.orchestrator?.uptimeMs ?? 0)}`);
  if (status.session) {
    console.log(`  Session:      ${status.session.id} (${status.session.state})`);
  }
  if (status.agent?.pid) {
    const children = status.agent.childPids?.length
      ? ` (children: ${status.agent.childPids.join(', ')})`
      : '';
    console.log(`  Agent PID:    ${status.agent.pid}${children}`);
  }
  if (status.mission?.mode === 'tasks') {
    const m = status.mission;
    const position = m.currentTaskId ? `${m.taskIndex + 1}/${m.totalTasks}` : `${m.totalTasks}/${m.totalTasks}`;
    console.log(
      `  Task:         ${m.currentTaskId ?? '(all done)'} ` +
      `[${position}] ${taskStateColor(m.taskState)(m.taskState ?? '')} ` +
      `(attempts: ${m.taskAttempts})`
    );
  }
  if (status.activity?.currentTask) {
    console.log(`  Current task: ${status.activity.currentTask}`);
  }
  if (status.activity?.lastOutputAt) {
    console.log(`  Last output:  ${status.activity.lastOutputAt}`);
  }
  const c = status.counters ?? {};
  console.log(
    `  Counters:     runs ${c.runs ?? 0} · resumes ${c.resumes ?? 0} · ` +
    `crashes ${c.crashes ?? 0} · rate limits ${c.rateLimits ?? 0}`
  );
  if (status.rateLimit?.waiting) {
    console.log(
      chalk.yellow(
        `  Waiting:      usage limit — resuming at ${status.rateLimit.resumeAt} ` +
        `(~${formatDuration(status.rateLimit.estimatedWaitMs ?? 0)})`
      )
    );
  }
  console.log(chalk.dim(`  Updated:      ${status.updatedAt}\n`));
}

/** Colour a timeline entry by its event kind. */
function eventColor(event) {
  return (
    {
      'mission-started': chalk.cyan,
      progress: chalk.green,
      'task-done': chalk.green,
      complete: chalk.green,
      resumed: chalk.cyan,
      recovered: chalk.cyan,
      'rate-limit': chalk.yellow,
      network: chalk.yellow,
      crash: chalk.red,
      blocked: chalk.red,
      'gave-up': chalk.red,
    }[event] ?? chalk.white
  );
}

/** Colour an agent role. */
function roleColor(role) {
  return (
    {
      planner: chalk.magenta,
      coding: chalk.cyan,
      testing: chalk.yellow,
      documentation: chalk.blue,
      research: chalk.green,
      review: chalk.magentaBright,
      general: chalk.white,
    }[role] ?? chalk.white
  );
}

/** Colour a Phase 10D mission-lifecycle state. */
function lifecycleColor(state) {
  return (
    {
      completed: chalk.green,
      approved: chalk.green,
      executing: chalk.cyan,
      verifying: chalk.cyan,
      'agents-assigned': chalk.cyan,
      planned: chalk.white,
      analyzed: chalk.white,
      received: chalk.white,
      'approval-pending': chalk.yellow,
      fixing: chalk.yellow,
      cancelled: chalk.yellow,
      blocked: chalk.red,
      failed: chalk.red,
    }[state] ?? chalk.white
  );
}

/** Colour a task-queue entry by its lifecycle state. */
function taskStateColor(state) {
  return (
    {
      done: chalk.green,
      active: chalk.cyan,
      pending: chalk.white,
      failed: chalk.red,
      blocked: chalk.red,
    }[state] ?? chalk.white
  );
}

function truncateLine(text, maxChars) {
  const line = text.split('\n')[0];
  return line.length > maxChars ? `${line.slice(0, maxChars - 1)}…` : line;
}

/** Render one session record. */
function printSession(session, label) {
  console.log(
    `  ${chalk.bold(session.project)} [${label}] ${session.state} — ` +
    `runs ${session.runs}, resumes ${session.resumes}, crashes ${session.crashes}, ` +
    `rate limits ${session.rateLimits}` +
    (session.lastActivity ? chalk.dim(` — ${session.lastActivity}`) : '')
  );
}

/** Invoke a PowerShell helper script from scripts/. */
function runSchedulerScript(scriptName, project) {
  const script = path.join(ROOT_DIR, 'scripts', scriptName);
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-InstallRoot',
    ROOT_DIR,
  ];
  if (project) args.push('-Project', project);

  const result = spawnSync('powershell.exe', args, {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`${scriptName} exited with code ${result.status}`);
  }
}

/** Environment/config diagnostics for `doctor`. */
/** Environment probes shared by `init` (and mirrored by `doctor`). */
async function probeEnvironment() {
  const steps = [];
  const major = Number(process.versions.node.split('.')[0]);
  steps.push({
    label: `Node.js ${process.version}`,
    ok: major >= 18,
    detail: major >= 18 ? 'supported' : 'need >= 18',
  });
  try {
    const registry = new DriverRegistry({ logger: silentLogger });
    const installation = await registry.getDriver('claude').checkInstallation();
    steps.push({
      label: 'Claude Code engine',
      ok: installation.ok,
      detail: installation.version ?? installation.error,
    });
  } catch (error) {
    steps.push({ label: 'Claude Code engine', ok: false, detail: error.message });
  }
  return steps;
}

/** Send a live test through every enabled channel; returns per-channel results. */
async function testNotificationChannels(configManager) {
  configManager.load();
  const engine = new NotificationEngine({
    config: configManager.get('notifications', {}),
    logger: silentLogger,
  });
  const results = [];
  for (const channel of engine.channels) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await channel.send({
        title: 'AI-Orchestrator — setup test',
        message: 'Setup complete — this is a test notification.',
        event: 'notify:test',
        payload: {},
        severity: 'info',
      });
      results.push({ name: channel.name, ok: true });
    } catch (error) {
      results.push({ name: channel.name, ok: false, error: error.message });
    }
  }
  return results;
}

/**
 * Thin CLI wrapper (Phase 11 M3): all the actual diagnostic logic lives in
 * doctor/doctor.js as structured findings, so `doctor` and `doctor --fix`
 * share exactly the same checks — nothing is special-cased between them.
 */
async function runDoctor({ fix = false } = {}) {
  const configManager = new ConfigManager();
  const findings = await buildDoctorFindings({ configManager });
  renderDoctorFindings(findings, chalk);

  const fixable = findings.filter((f) => f.fix);
  if (!fix) {
    if (fixable.length > 0) {
      console.log(chalk.dim(
        `  ${fixable.length} issue(s) above can be repaired — run "ai-orchestrator doctor --fix".\n`
      ));
    }
    return;
  }
  if (!fixable.length) {
    console.log(chalk.green('Nothing to fix.\n'));
    return;
  }

  const prompter = createPrompter();
  const ctx = {
    configManager,
    paths: configManager.getPaths(),
    prompter,
    projectWizard: runProjectWizard,
    telegramWizard: runTelegramSetup,
    emailWizard: runEmailSetup,
    runSchedulerScript,
  };

  let fixed = 0;
  let skipped = 0;
  let manual = 0;
  try {
    for (const finding of fixable) {
      console.log(chalk.bold(`\n${finding.label}`));
      if (finding.cause) console.log(`  Cause:  ${finding.cause}`);
      if (finding.impact) console.log(`  Impact: ${finding.impact}`);
      console.log(`  Fix:    ${finding.fix.description}`);
      // eslint-disable-next-line no-await-in-loop
      const proceed = await prompter.confirm('Apply this fix?', { default: finding.fix.safe });
      if (!proceed) {
        skipped += 1;
        console.log(chalk.dim('  Skipped.'));
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const result = await applyDoctorFix(finding, ctx);
      if (result.ok) {
        fixed += 1;
        console.log(chalk.green(`  ✔ Recovered — ${result.message}`));
      } else {
        manual += 1;
        console.log(chalk.yellow(`  Manual intervention required — ${result.message}`));
      }
    }
  } finally {
    prompter.close();
  }

  console.log(chalk.bold(
    `\n${fixed} recovered, ${skipped} skipped, ${manual} need manual follow-up.\n`
  ));
}

export default buildProgram;
