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
import SessionManager from '../state/sessionManager.js';
import MissionTimeline from '../state/missionTimeline.js';
import TaskQueue from '../mission/taskQueue.js';
import { validateSingleTask } from '../mission/missionPlan.js';
import MemoryStore from '../memory/memoryStore.js';
import { loadOrCreateToken } from '../api/apiAuth.js';
import DriverRegistry from '../drivers/driverRegistry.js';
import { readJsonSafe } from '../state/statePersistence.js';
import { isPidAlive } from '../state/heartbeat.js';
import { formatDuration } from '../infra/time.js';
import { ROOT_DIR } from '../infra/paths.js';

/** Windows Task Scheduler task name used by `scheduler` commands. */
const SCHEDULED_TASK_NAME = 'AI-Orchestrator Auto-Resume';

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

/** Uniform fatal-error rendering for every command. */
function fail(error) {
  const message = error instanceof ConfigError ? error.message : (error.stack ?? error.message);
  console.error(chalk.red(`\nError: ${error.message}`));
  if (message !== error.message) console.error(chalk.dim(message));
  process.exitCode = 1;
}

export function buildProgram() {
  const program = new Command();

  program
    .name('ai-orchestrator')
    .description('Autonomous supervisor for AI coding agents (Claude Code and friends)')
    .version('2.1.0');

  program
    .command('start')
    .argument('[project]', 'project name (defaults to config "defaultProject")')
    .option('--fresh', 'abandon any interrupted session and start the mission over')
    .description('Start (or resume) supervising a project until its mission completes')
    .action(async (project, options) => {
      try {
        const app = new App();
        const result = await app.start({ projectName: project, fresh: options.fresh });
        if (result?.complete) {
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
    .description('List active sessions, or one project’s session history')
    .action((project) => {
      try {
        const { sessionManager } = readOnlyContext();
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
        const taskQueue = new TaskQueue({ tasksDir: paths.tasksDir, logger: silentLogger });
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
        const taskQueue = new TaskQueue({ tasksDir: paths.tasksDir, logger: silentLogger });
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
    .argument('<name>', 'project name')
    .requiredOption('--dir <path>', 'working directory the agent operates in')
    .requiredOption('--prompt <file>', 'mission prompt file (relative to --dir or absolute)')
    .option('--driver <id>', 'AI engine driver', 'claude')
    .description('Create a new project definition')
    .action((name, options) => {
      try {
        const { configManager } = readOnlyContext();
        const file = configManager.saveProject(name, {
          driver: options.driver,
          workingDirectory: path.resolve(options.dir),
          promptFile: options.prompt,
        });
        console.log(chalk.green(`Project created: ${file}`));
        console.log(`Start it with:  ai-orchestrator start ${name}`);
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
    .description('Diagnose the environment, configuration, and engine installation')
    .action(async () => {
      await runDoctor();
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
async function runDoctor() {
  const check = (ok, label, detail = '') => {
    const mark = ok ? chalk.green('✔') : chalk.red('✘');
    console.log(`  ${mark} ${label}${detail ? chalk.dim(` — ${detail}`) : ''}`);
    return ok;
  };

  console.log(chalk.bold('\nAI-Orchestrator doctor\n'));

  // Node version.
  const major = Number(process.versions.node.split('.')[0]);
  check(major >= 18, `Node.js ${process.version}`, major >= 18 ? 'supported' : 'need >= 18');

  // Configuration.
  let configManager;
  try {
    configManager = new ConfigManager();
    configManager.load();
    check(true, 'Global configuration loads', 'config/orchestrator.json');
  } catch (error) {
    check(false, 'Global configuration loads', error.message);
    return;
  }

  // Projects.
  const projectNames = configManager.listProjects();
  check(projectNames.length > 0, `Projects defined: ${projectNames.length}`,
    projectNames.join(', ') || 'add one with "projects add"');
  const registry = new DriverRegistry({ logger: silentLogger });
  for (const name of projectNames) {
    try {
      const project = configManager.getProject(name);
      check(true, `Project "${name}" is valid`, project.workingDirectory);

      const driver = registry.getDriver(project.driver);
      // eslint-disable-next-line no-await-in-loop
      const installation = await driver.checkInstallation(
        project[project.driver]?.executable
      );
      check(installation.ok, `Engine for "${name}" (${project.driver})`,
        installation.version ?? installation.error);
    } catch (error) {
      check(false, `Project "${name}" is valid`, error.message);
    }
  }

  // Writable runtime dirs.
  const paths = configManager.getPaths();
  try {
    fs.mkdirSync(paths.stateDir, { recursive: true });
    const probe = path.join(paths.stateDir, '.doctor-probe');
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe);
    check(true, 'State directory writable', paths.stateDir);
  } catch (error) {
    check(false, 'State directory writable', error.message);
  }

  // Running instance?
  const heartbeat = readJsonSafe(paths.heartbeatFile);
  if (heartbeat?.state === 'running' && isPidAlive(heartbeat.pid)) {
    console.log(chalk.yellow(`\n  An orchestrator is currently running (pid ${heartbeat.pid}).`));
  }

  // Scheduled task (Windows only).
  if (process.platform === 'win32') {
    const task = spawnSync('schtasks', ['/Query', '/TN', SCHEDULED_TASK_NAME], {
      encoding: 'utf8',
      windowsHide: true,
    });
    check(
      task.status === 0,
      'Auto-resume scheduled task',
      task.status === 0 ? 'installed' : 'not installed (optional) — "scheduler install"'
    );
  }

  console.log('');
}

export default buildProgram;
