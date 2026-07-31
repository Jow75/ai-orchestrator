/**
 * commandRouter.js — Phase 12 M2: the operator console's brain.
 *
 * Takes one parsed inbound message and does exactly what it says, against the
 * daemon's own collaborators. Everything here obeys four rules:
 *
 *  1. THE DAEMON IS THE SOURCE OF TRUTH. The router reads the registry, the
 *     stores, and the supervisor — never a cached idea of what is running.
 *  2. NOTHING DESTRUCTIVE HAPPENS ON ONE MESSAGE (Priority 7). Destructive
 *     commands return a confirmation, never a result. See confirmations.js.
 *  3. FREE TEXT NEVER STARTS WORK. It can only raise a proposal the owner
 *     must approve (PHASE_12_PLAN.md §6). See missionRequests.js.
 *  4. EVERY REAL OUTCOME BECOMES AN EVENT. The reply is for the human; the
 *     event is for the system. A future interface reads the second, not the
 *     first — which is the entire point of the M2 architecture.
 *
 * The router is transport-agnostic on purpose: it is handed `{text, channel,
 * chatId, from}` and returns `{reply}`. It has never heard of Telegram. When
 * the desktop (M3) and any later client arrive, they call this same method.
 */

import fs from 'node:fs';
import path from 'node:path';
import { isLegacyMission, validateSingleTask } from '../mission/missionPlan.js';
import { TaskState } from '../mission/taskState.js';
import { approvalEventFor } from '../events/eventTypes.js';
import { isEvidenceVerifier } from '../notifications/missionCard.js';
import { parseCommand } from './commandGrammar.js';
import { scanRoots } from './projectDiscovery.js';
import { inspectProject, buildAutoMissionPrompt } from './projectInspector.js';
import { gitReport } from './gitVisibility.js';
import { readLogTail } from './logVisibility.js';
import { searchFiles, buildGrepPattern, buildSymbolPattern } from './repoSearch.js';
import {
  archive, restore, hide, unhide, forget, classifyProposal,
} from './projectLifecycleOps.js';
import { DEFAULT_CLASSIFICATION } from '../config/projectClassification.js';
import { capabilitiesOf } from '../drivers/capabilities.js';
import {
  renderProjectList, renderProjectDetail, renderTasks, renderApprovals,
  renderMissionProposal, renderMissionRequests, renderEvents, renderConfirmation,
  renderHelp, renderServiceStatus, renderScanResults, renderFileListing,
  renderFileInline, formatBytes, truncate, renderMissionAssignment, renderMissionBatch,
  renderWorkspace, renderGitStatus, renderGitFilter, renderLogTail, renderSearchResults,
} from './render.js';
import {
  FileAccessError, listFiles, resolveWithinProject, looksBinary,
  estimateArchiveSize, createProjectArchive, pruneOldDownloads, missingFolderDetail,
} from './fileAccess.js';
import { MAX_DOCUMENT_BYTES } from '../notifications/channels/telegram.js';

/**
 * Phase 13 M6: the largest a text file may be to show inline rather than as
 * an attachment. Deliberately well under Telegram's real 4096-char message
 * limit (not just close to it): inline content is sent through the SAME
 * `sendLongText()` every other reply uses, and a code file that needed
 * splitting across several messages would arrive with no visual indication
 * of where one file ended and the next numbered part began — worse than
 * simply attaching it. Below this size, one message is always enough.
 */
export const INLINE_MAX_BYTES = 3_500;

/** How many events `/events` returns when no count is given. */
export const DEFAULT_EVENT_COUNT = 12;

/** Upper bound on `/events <n>`, so one message cannot become a wall of text. */
export const MAX_EVENT_COUNT = 40;

/**
 * Shared by `/whoami` and `activeProjectRoot()` (the guard behind `/files`,
 * `/file`, `/grep`, `/symbol`) — both need "there is no active project" and
 * neither accepts a project name as part of their own argument, so neither
 * can offer `resolveTarget()`'s "or name one directly" alternative.
 * `resolveTarget()` itself (used by `/status`, `/git`, `/log`, …) keeps its
 * own longer message on purpose, since it CAN take a name inline.
 */
const NO_ACTIVE_PROJECT_REPLY = 'No project selected. /projects then /project <name>.';

export class CommandRouter {
  /**
   * @param {object} deps
   * @param {import('./projectRegistry.js').ProjectRegistry} deps.registry
   * @param {import('./operatorContext.js').OperatorContext} deps.context
   * @param {import('./missionRequests.js').MissionRequestStore} deps.requests
   * @param {import('./confirmations.js').ConfirmationStore} deps.confirmations
   * @param {import('../events/eventStore.js').EventStore} deps.events
   * @param {import('../approvals/approvalStore.js').ApprovalStore} deps.approvalStore
   * @param {import('../approvals/approvalManager.js').ApprovalManager} deps.approvalManager
   * @param {import('../daemon/workerSupervisor.js').WorkerSupervisor} deps.supervisor
   * @param {import('../mission/taskQueue.js').TaskQueue} deps.taskQueue
   * @param {import('../state/sessionManager.js').SessionManager} deps.sessionManager
   * @param {import('../progress/progressLedger.js').ProgressLedger} [deps.ledger]
   * @param {import('../config/configManager.js').ConfigManager} deps.configManager
   * @param {import('../config/liveConfig.js').LiveConfigLayer} [deps.liveConfig]
   * @param {import('../drivers/driverRegistry.js').DriverRegistry} [deps.driverRegistry]
   * @param {object} deps.config - The full merged global config.
   * @param {{downloadsDir: string, logsDir: string}} [deps.paths] - Phase 13
   *   M6: where `/download-project` writes generated ZIPs. Absent ⇒
   *   `/download-project` refuses cleanly rather than guessing a location.
   *   Phase 14 M2: `logsDir` is where `/log` tails the real orchestrator log
   *   file from; absent ⇒ `/log` refuses cleanly the same way.
   * @param {() => void} [deps.requestShutdown] - Stops the Core Service.
   * @param {object} deps.logger
   */
  constructor({
    registry, context, requests, confirmations, events, approvalStore, approvalManager,
    supervisor, taskQueue, sessionManager, ledger, configManager, liveConfig, driverRegistry, config,
    paths, requestShutdown, serviceReport, logger,
  }) {
    this.registry = registry;
    this.context = context;
    this.requests = requests;
    this.confirmations = confirmations;
    this.events = events;
    this.approvalStore = approvalStore;
    this.approvalManager = approvalManager;
    this.supervisor = supervisor;
    this.taskQueue = taskQueue;
    this.sessionManager = sessionManager;
    this.ledger = ledger;
    this.configManager = configManager;
    this.liveConfig = liveConfig;
    this.driverRegistry = driverRegistry;
    this.config = config ?? {};
    this.paths = paths;
    this.requestShutdown = requestShutdown;
    this.serviceReport = serviceReport;
    this.logger = logger;
  }

  get operatorConfig() {
    return this.config.operator ?? {};
  }

  get notificationsConfig() {
    return this.config.notifications ?? {};
  }

  get approvalsConfig() {
    return this.config.approvals ?? {};
  }

  /**
   * Handle one inbound message.
   *
   * Never throws: an unhandled error here would take down the service's only
   * remote surface over one malformed message. Anything unexpected is logged
   * and answered honestly.
   *
   * @param {object} message
   * @param {string} message.text
   * @param {string} message.channel - 'telegram', 'desktop', …
   * @param {string|number} [message.chatId]
   * @param {string} [message.from]
   * @returns {Promise<{reply: string|null, attachment?: {filePath: string, caption?: string}}>}
   *   `attachment` (Phase 13 M6) is additive — every caller that only ever
   *   read `.reply` keeps working unchanged; see OperatorGateway.deliver().
   */
  async handle({ text, channel, chatId, from }) {
    const actor = `${channel}:${from ?? 'owner'}`;
    try {
      const parsed = parseCommand(text);
      if (parsed.kind === 'empty') return { reply: null };

      // The widened grammar can be switched off entirely, leaving exactly the
      // v2.8.0 message set. Decisions are never gated by it: they predate the
      // operator interface and are orthogonal to it.
      if (this.operatorConfig.enabled === false && parsed.kind !== 'decision') {
        return { reply: null };
      }

      this.events?.append({
        type: 'command.received',
        actor,
        payload: { kind: parsed.kind, name: parsed.name ?? null },
      });

      switch (parsed.kind) {
        case 'decision':
          return await this.handleDecision(parsed, { channel, chatId, from, actor });
        case 'command':
          return await this.handleCommand(parsed, { channel, chatId, from, actor });
        case 'unknown-command':
          return this.handleUnknown(parsed, { channel, chatId, actor });
        case 'free-text':
          return await this.handleFreeText(parsed, { channel, chatId, from, actor });
        default:
          return { reply: null };
      }
    } catch (error) {
      this.logger?.error('Operator command failed', { error: error.message, stack: error.stack });
      this.events?.append({
        type: 'command.rejected',
        actor,
        payload: { reason: 'internal-error', error: error.message },
      });
      return {
        reply: `Something went wrong handling that: ${error.message}\nThe service is still running — try /status.`,
      };
    }
  }

  // ------------------------------------------------------------- decisions --

  /** `APPROVE A7` (an approval) or `APPROVE M3` (a mission request). */
  async handleDecision(parsed, { channel, chatId, from, actor }) {
    if (parsed.idKind === 'approval') {
      const result = this.approvalManager.applyRemoteDecision({
        requestId: parsed.requestId,
        decision: parsed.decision,
        note: parsed.note,
        by: from ?? 'owner',
        via: channel,
      });
      if (!result.ok) return { reply: result.reason };
      const eventType = approvalEventFor(result.request.status);
      if (eventType) {
        this.events?.append({
          type: eventType,
          project: result.request.project,
          actor,
          payload: {
            id: result.request.id,
            category: result.request.category,
            note: parsed.note ?? null,
          },
        });
      }
      return {
        reply: `${result.request.id} ${parsed.decision} — ${result.request.project}.\n` +
          `${result.request.title}`,
      };
    }

    // A mission request. MODIFY/DONE are not decisions a proposal can take:
    // there is nothing to modify yet (that is what the plan gate is for) and
    // nothing to mark done.
    if (parsed.decision === 'modified' || parsed.decision === 'done') {
      return {
        reply: `${parsed.requestId} is a mission request — reply APPROVE ${parsed.requestId} ` +
          `or REJECT ${parsed.requestId}. You will get a full plan to modify once it has one.`,
      };
    }
    return await this.decideMissionRequest(parsed, { channel, chatId, from, actor });
  }

  /**
   * Approve or reject a mission request. Approval is where a sentence typed on
   * a phone finally becomes real work — and it is the ONLY place that happens.
   */
  async decideMissionRequest(parsed, { channel, from, actor }) {
    const decision = parsed.decision === 'approved' ? 'approved' : 'rejected';
    const result = this.requests.decide(parsed.requestId, {
      decision, by: from ?? 'owner', note: parsed.note,
    });
    if (!result.ok) return { reply: result.reason };
    const request = result.request;

    if (decision === 'rejected') {
      this.events?.append({
        type: 'mission.rejected',
        project: request.project,
        actor,
        payload: { id: request.id, note: parsed.note ?? null },
      });
      return { reply: `${request.id} rejected. Nothing was started.` };
    }

    this.events?.append({
      type: 'mission.approved',
      project: request.project,
      actor,
      payload: { id: request.id, objective: truncate(request.objective, 200) },
    });

    const started = await this.startApprovedMission(request, { channel, actor });
    return { reply: started.reply };
  }

  /**
   * Materialize an approved request and start supervising it.
   *
   * Everything here uses machinery that already existed: a prompt file, a task
   * on the project's queue (the `tasks add` path since P3), and a supervised
   * worker (M1). No new execution path is introduced by remote operation —
   * which is precisely why remote operation inherits every P0–P11 guarantee.
   */
  async startApprovedMission(request, { actor }) {
    let project;
    try {
      project = this.configManager.getProject(request.project);
    } catch (error) {
      this.requests.update(request.id, { status: 'cancelled', decisionNote: error.message });
      return { reply: `Cannot start ${request.id}: ${error.message}` };
    }

    const blocker = this.startBlocker(project.name);
    if (blocker) {
      // The request stays APPROVED, not started: the owner's decision was
      // valid and should not have to be made twice once the blocker clears.
      return { reply: `${request.id} is approved, but cannot start yet.\n\n${blocker}` };
    }

    const queue = this.ensureQueue(project);
    const seenIds = new Set(queue.tasks.map((t) => t.id));
    const promptFile = this.requests.writePrompt(request, {
      planMarker: this.config.approvals?.planMarker ?? 'IMPLEMENTATION PLAN READY',
      completionMarker: project.mission?.completionMarker ?? 'MISSION COMPLETE',
    });

    // No `approval` category is set on the task. The owner has already gated
    // this work twice (M3 here, and the plan gate the prompt routes into), and
    // a third declared category would pause again in conservative mode for a
    // decision that has demonstrably already been made.
    const { task, problems } = validateSingleTask({
      id: request.id,
      objective: truncate(request.objective, 120),
      prompt: promptFile,
    }, { label: `mission ${request.id}`, workingDirectory: project.workingDirectory, seenIds });

    if (problems.length) {
      return { reply: `Cannot start ${request.id}:\n - ${problems.join('\n - ')}` };
    }

    this.taskQueue.enqueue(queue, task);
    const position = queue.tasks.length - queue.currentIndex;

    const result = this.supervisor.start(project.name);
    if (!result.ok) {
      // The task IS queued and will run on the next start — say so rather than
      // implying the request evaporated.
      this.requests.update(request.id, { promptFile, taskId: task.id });
      return {
        reply: `${request.id} is queued for ${project.name}, but the mission did not start:\n` +
          `${result.reason}\n\nIt will run on the next start.`,
      };
    }

    this.requests.update(request.id, {
      status: 'started',
      promptFile,
      taskId: task.id,
      startedAt: new Date().toISOString(),
      workerPid: result.pid,
    });
    this.events?.append({
      type: 'mission.started',
      project: project.name,
      actor,
      payload: { id: request.id, taskId: task.id, pid: result.pid },
    });

    const queued = position > 1 ? `\nIt is #${position} in the queue.` : '';
    return {
      reply: `▶️ ${project.name} — starting ${request.id}.${queued}\n\n` +
        'It will plan first and come back with tasks, files, duration and risks\n' +
        'for your approval before writing any code.',
    };
  }

  /**
   * Why a mission cannot start right now, or null when it can.
   *
   * Both cases below are situations where enqueueing would SILENTLY lose the
   * work, which is worse than refusing:
   *
   *  - A live worker holds the queue in memory and rewrites it on every task
   *    transition, so an externally appended task is overwritten.
   *  - A BLOCKED/FAILED current task means the next start cannot adopt the
   *    queue at all (taskQueue.getOrInitialize case 3) and reseeds it from
   *    static config — discarding anything appended here.
   */
  startBlocker(projectName) {
    const holder = this.supervisor.holderOf(projectName);
    if (holder) {
      return `${projectName} already has a mission running (pid ${holder.pid}).\n` +
        `Wait for it to finish, or /stop ${projectName} first.`;
    }
    const queue = this.taskQueue.load(projectName);
    const current = queue?.tasks?.[queue.currentIndex] ?? null;
    if (current && (current.state === TaskState.BLOCKED || current.state === TaskState.FAILED)) {
      return `${projectName} is stuck on task "${current.id}" (${current.state}).\n` +
        'Clear it first on the machine:\n' +
        `  ai-orchestrator tasks approve ${projectName} ${current.id}   (retry it)\n` +
        `  ai-orchestrator tasks skip ${projectName} ${current.id}      (give up on it)`;
    }
    return null;
  }

  /**
   * The queue an approved mission should be appended to.
   *
   * For a project with a CONFIGURED plan and no persisted queue, the plan is
   * materialized first, so a remote mission is added to the project's work
   * rather than quietly replacing it — an empty queue would be adopted by the
   * next run and the configured tasks would never execute.
   */
  ensureQueue(project) {
    const existing = this.taskQueue.load(project.name);
    if (existing) return existing;
    return isLegacyMission(project)
      ? this.taskQueue.ensure(project.name)
      : this.taskQueue.initialize(project.name, project.tasks, null);
  }

  // -------------------------------------------------------------- commands --

  async handleCommand(parsed, ctx) {
    const { name, command, rest } = parsed;

    if (command.destructive) {
      const prepared = await this.prepareDestructive(name, rest, ctx);
      if (prepared.reply) return { reply: prepared.reply };
      const confirmation = this.confirmations.require({
        channel: ctx.channel,
        action: name,
        project: prepared.project ?? null,
        summary: prepared.summary,
        perform: prepared.perform,
      });
      return { reply: renderConfirmation(confirmation) };
    }

    switch (name) {
      case 'help': return { reply: renderHelp({ active: this.activeProject(ctx) }) };
      case 'projects': return this.commandProjects(rest, ctx);
      case 'project': return this.commandSelect(rest, ctx);
      case 'whoami': return this.commandWhoami(ctx);
      case 'status': return this.commandStatus(rest, ctx);
      case 'workspace': return this.commandWorkspace(ctx);
      case 'git': return this.commandGit(rest, ctx);
      case 'start': return this.commandStart(rest, ctx);
      case 'tasks': return this.commandTasks(rest, ctx);
      case 'approvals': return this.commandApprovals(rest, ctx);
      case 'missions': return this.commandMissions(ctx);
      case 'service': return await this.commandService();
      case 'events': return this.commandEvents(rest, ctx);
      case 'log': return this.commandLog(rest, ctx);
      case 'confirm': return await this.commandConfirm(rest, ctx);
      case 'cancel': return this.commandCancel(rest, ctx);
      case 'scan': return this.commandScan(ctx);
      case 'import': return this.commandImport(rest, ctx);
      case 'mission': return this.commandMission(rest, ctx);
      case 'archive': return this.commandArchive(rest, ctx);
      case 'restore': return this.commandRestore(rest, ctx);
      case 'hide': return this.commandHide(rest, ctx);
      case 'unhide': return this.commandUnhide(rest, ctx);
      case 'roots': return this.commandRoots(rest, ctx);
      case 'provider': return this.commandProvider(ctx);
      case 'model': return this.commandModel(rest, ctx);
      case 'safemode': return this.commandSafeMode(rest, ctx);
      case 'notify': return this.commandNotify(rest, ctx);
      case 'files': return this.commandFiles(rest, ctx);
      case 'file': return this.commandFile(rest, ctx);
      case 'grep': return this.commandGrep(rest, ctx);
      case 'symbol': return this.commandSymbol(rest, ctx);
      case 'download_project': return await this.commandDownloadProject(rest, ctx);
      default:
        return { reply: `"/${name}" is recognized but not implemented. This is a bug — please report it.` };
    }
  }

  commandProjects(rest, ctx) {
    const word = (rest ?? '').trim().toLowerCase();
    if (word === 'classify') return this.commandProjectsClassify(ctx);

    const includeHidden = word === 'all';
    const records = this.registry.list({ includeHidden });
    // A selection pointing at a project that no longer exists is worse than no
    // selection: every later command fails with a confusing error. Pruning
    // uses every real name (not just the ones just listed), so a selection
    // pointing at a currently-hidden project is never wrongly pruned.
    this.context.pruneMissing(this.registry.names());
    return { reply: renderProjectList(records, { active: this.activeProject(ctx) }) };
  }

  /**
   * `/projects classify` — Phase 13 M3: propose (never silently apply) a
   * classification for every project that doesn't have one yet. One batch
   * confirmation via the existing `ConfirmationStore`, not one per project —
   * exactly the same mechanism `/stop`/`/reset`/`/shutdown` already use,
   * invoked directly here rather than through the destructive-command gate
   * since this isn't a per-project destructive action.
   */
  commandProjectsClassify(ctx) {
    const proposals = classifyProposal(this.configManager);
    if (!proposals.length) {
      return { reply: 'Every project already has a classification. Nothing to propose.' };
    }
    const lines = proposals.map((p) => `${p.name} → ${p.proposed} (${p.reason})`);
    const confirmation = this.confirmations.require({
      channel: ctx.channel,
      action: 'classify',
      summary: `Classify ${proposals.length} project(s):\n${lines.join('\n')}`,
      perform: () => {
        for (const p of proposals) {
          this.configManager.updateProject(p.name, { classification: p.proposed });
          this.events?.append({
            type: 'project.classified', project: p.name, actor: ctx.actor,
            payload: { classification: p.proposed },
          });
        }
        return `Classified ${proposals.length} project(s).`;
      },
    });
    return { reply: renderConfirmation(confirmation) };
  }

  commandSelect(rest, ctx) {
    if (!rest) {
      return {
        reply: 'Which project? Try /projects to see them, then /project <name>.',
      };
    }
    const { match, candidates } = this.registry.resolveName(rest);
    if (!match) {
      return { reply: this.noSuchProject(rest, candidates) };
    }
    const { previous } = this.context.select(ctx.channel, ctx.chatId, match, ctx.from);
    this.events?.append({
      type: 'project.selected',
      project: match,
      actor: ctx.actor,
      payload: { previous },
    });
    const record = this.registry.describe(match, { health: false });
    return { reply: `▸ ${match} selected.\n\n${renderProjectDetail(record)}` };
  }

  commandWhoami(ctx) {
    const active = this.activeProject(ctx);
    if (!active) return { reply: NO_ACTIVE_PROJECT_REPLY };
    const entry = this.context.get(ctx.channel, ctx.chatId);
    return {
      reply: `Active project: ${active}\nSelected: ${entry?.selectedAt ?? 'unknown'}`,
    };
  }

  commandStatus(rest, ctx) {
    const resolved = this.resolveTarget(rest, ctx);
    if (resolved.reply) return { reply: resolved.reply };
    return { reply: renderProjectDetail(this.registry.describe(resolved.project)) };
  }

  /**
   * `/workspace` — Phase 14 M0: a read-only rollup over the whole registry.
   * Every field `renderWorkspace()` sums (status, git, lastActivity) is
   * already computed by `registry.list()` — this method's only real job is
   * mission-readiness, which reads the RAW config file per project, exactly
   * like `assignMission()`'s own "already has a mission" check: the
   * validated view `configManager.getProject()` gives THROWS on precisely
   * the misconfigured/missing-folder projects this rollup still has to
   * count, so it can't be used here either.
   */
  commandWorkspace(ctx) {
    const disabled = this.guardEnabled('workspace', 'Workspace overview');
    if (disabled) return disabled;
    const records = this.registry.list({ includeHidden: false });
    const missionReady = new Set();
    for (const record of records) {
      const raw = this.configManager.getProjectFileContents(record.name);
      if (raw && (raw.promptFile || (Array.isArray(raw.tasks) && raw.tasks.length > 0))) {
        missionReady.add(record.name);
      }
    }
    this.events?.append({
      type: 'workspace.viewed', actor: ctx?.actor, payload: { projects: records.length, missionReady: missionReady.size },
    });
    return { reply: renderWorkspace(records, { missionReady }) };
  }

  /**
   * `/git [project]` — Phase 14 M1: branch, dirty/clean state, HEAD, recent
   * commit subjects, and (when tracked) ahead/behind. Read-only, no diff, no
   * file contents, no approval gate — same risk class as `/status`.
   *
   * `/git dirty` / `/git clean` list every registered project in that git
   * state, the same reserved-keyword-before-project-name precedent
   * `/projects classify` and `/mission all` already established.
   *
   * Uses `configManager.getRawProject()`, not `getProject()`: the latter
   * throws on any project still missing a `promptFile` (most of the
   * registry before Phase 14 M9), and git state has nothing to do with
   * mission-readiness — the same reasoning `commandWorkspace()` and
   * `existingProjectDirs()` already apply.
   *
   * The "does this folder actually exist" check reuses `fileAccess.js`'s
   * own `resolveWithinProject()` (called with `''`, i.e. "the root itself")
   * rather than a bespoke `fs.existsSync()` — the same real-path check
   * `/files`/`/file`/`/grep`/`/symbol` already rely on, so a dangling
   * symlink or junction is caught here exactly as it would be there,
   * instead of this command being the one surface with a weaker guard.
   */
  commandGit(rest, ctx) {
    const disabled = this.guardEnabled('git', 'Git visibility');
    if (disabled) return disabled;
    const word = (rest ?? '').trim().toLowerCase();
    if (word === 'dirty' || word === 'clean') return this.commandGitFilter(word);

    const resolved = this.resolveTarget(rest, ctx);
    if (resolved.reply) return { reply: resolved.reply };

    const raw = this.configManager.getRawProject?.(resolved.project);
    const workingDirectory = raw?.workingDirectory;
    if (!workingDirectory) {
      return { reply: `${resolved.project} — no workingDirectory set.` };
    }
    let realRoot;
    try {
      realRoot = resolveWithinProject(workingDirectory, '');
    } catch (error) {
      if (!(error instanceof FileAccessError)) throw error;
      return { reply: `${resolved.project} — ${error.message}` };
    }

    const report = gitReport(realRoot);
    this.events?.append({
      type: 'git.viewed', project: resolved.project, actor: ctx.actor, payload: { isRepo: Boolean(report) },
    });
    return { reply: renderGitStatus(resolved.project, report) };
  }

  /** `/git dirty` / `/git clean` — every registered project in that state. */
  commandGitFilter(kind) {
    const records = this.registry.list({ includeHidden: false })
      .filter((r) => r.git && (kind === 'dirty' ? r.git.dirty : !r.git.dirty));
    return { reply: renderGitFilter(kind, records) };
  }

  /**
   * `/log [project] [page]` — Phase 14 M2: a tail of the real orchestrator
   * log file (`logVisibility.js`) for the active (or named) project —
   * timestamp, severity, and message per line. Paginated exactly like
   * `/files`: a trailing bare number is a page once a project name already
   * precedes it, so "/log 40" means the project "40" (page 1), not page 40
   * of the active project — the same disambiguation `commandFiles()` uses
   * and for the same reason. Read-only, no approval gate — same risk class
   * as `/git`.
   *
   * Distinct from `/events`: that reads the structured internal event log;
   * this reads the raw text log every daemon/worker process writes to (one
   * shared file for the whole installation — see `src/infra/paths.js`'s
   * `logsDir`), filtered to the lines that project's own activity tagged
   * with a `project` field. Lines with no such field are the service's own
   * activity, not this project's, so they are correctly excluded.
   */
  commandLog(rest, ctx) {
    const disabled = this.guardEnabled('log', 'Log visibility');
    if (disabled) return disabled;
    if (!this.paths?.logsDir) {
      return { reply: 'This interface cannot read the log from here.' };
    }

    const { page, rest: projectRest } = this.splitTrailingPage(rest);

    const resolved = this.resolveTarget(projectRest, ctx);
    if (resolved.reply) return { reply: resolved.reply };

    const tail = readLogTail(this.paths.logsDir, resolved.project, { page });
    this.events?.append({
      type: 'log.viewed', project: resolved.project, actor: ctx.actor, payload: { page, found: Boolean(tail) },
    });
    return { reply: renderLogTail(resolved.project, tail) };
  }

  commandStart(rest, ctx) {
    const resolved = this.resolveTarget(rest, ctx);
    if (resolved.reply) return { reply: resolved.reply };

    const blocker = this.startBlocker(resolved.project);
    if (blocker) return { reply: blocker };

    const result = this.supervisor.start(resolved.project);
    if (!result.ok) return { reply: result.reason };
    this.events?.append({
      type: 'worker.started',
      project: resolved.project,
      actor: ctx.actor,
      payload: { pid: result.pid, via: 'operator' },
    });
    return { reply: `▶️ ${resolved.project} — mission started (pid ${result.pid}).` };
  }

  commandTasks(rest, ctx) {
    const resolved = this.resolveTarget(rest, ctx);
    if (resolved.reply) return { reply: resolved.reply };
    return { reply: renderTasks(resolved.project, this.taskQueue.load(resolved.project)) };
  }

  /**
   * `/approvals` — every pending decision, unchanged since Phase 12 M2.
   * `/approvals mode [conservative|balanced|autonomous]` — Phase 14 M8: show
   * or set the global approval mode via the same live-config mechanism
   * `/safemode`/`/model` already use. A project's own `approvals.mode`
   * override (if it has one) still wins for that project — this only
   * changes the machine-wide default every project without an override falls
   * back to.
   */
  commandApprovals(rest, ctx) {
    const words = (rest ?? '').trim().split(/\s+/).filter(Boolean);
    if (words[0]?.toLowerCase() !== 'mode') {
      return {
        reply: renderApprovals(this.approvalStore.pendingAll(), {
          simulated: this.registry.simulatedNames(),
        }),
      };
    }

    const disabled = this.guardLiveConfig();
    if (disabled) return disabled;

    const valid = ['conservative', 'balanced', 'autonomous'];
    const current = this.approvalsConfig.mode || 'balanced';
    const value = (words[1] ?? '').trim().toLowerCase();
    if (!value) {
      return { reply: `Approval mode: ${current}\nValid modes: ${valid.join(', ')}. /approvals mode <mode> to change.` };
    }
    if (!valid.includes(value)) {
      return { reply: `"${value}" is not a valid approval mode. Valid: ${valid.join(', ')}.` };
    }
    if (value === current) {
      return { reply: `Approval mode is already "${current}".` };
    }

    this.liveConfig.applyPatch({ 'approvals.mode': value });
    this.events?.append({
      type: 'approvals.mode-changed', actor: ctx.actor, payload: { mode: value, previousMode: current },
    });
    return { reply: `Approval mode set to "${value}". Applies to new decisions from now on — decisions already pending are unaffected.` };
  }

  commandMissions(ctx) {
    const active = this.activeProject(ctx);
    const open = this.requests.open();
    if (open.length) {
      return { reply: renderMissionRequests(open, { simulated: this.registry.simulatedNames() }) };
    }
    return {
      reply: active
        ? `No mission requests are waiting.\nType what you want done to ${active} and it becomes one.`
        : 'No mission requests are waiting. Select a project first: /project <name>',
    };
  }

  /**
   * `/service` — "is it running, and will it still be running tomorrow?"
   *
   * The first half is answered by the fact that this reply exists at all: a
   * message only reaches the router through a live service. The second half is
   * the one worth asking remotely, and the one nothing reported before M2.1 —
   * after the 2026-07-28 reboot the console was silent, and no command on the
   * phone could have explained why.
   */
  async commandService() {
    if (!this.serviceReport) {
      return { reply: 'This interface cannot see the service record from here.' };
    }
    return { reply: renderServiceStatus(await this.serviceReport()) };
  }

  commandEvents(rest, ctx) {
    const requested = Number.parseInt(rest, 10);
    const count = Number.isFinite(requested)
      ? Math.min(Math.max(requested, 1), MAX_EVENT_COUNT)
      : DEFAULT_EVENT_COUNT;
    const active = this.activeProject(ctx);
    // Scoped to the active project when there is one: a phone screen full of
    // another project's churn is not what "what happened?" means here.
    const events = this.events?.recent(count, active ?? undefined) ?? [];
    const header = active ? `${active} — ` : '';
    return { reply: `${header}${renderEvents(events)}` };
  }

  async commandConfirm(rest, ctx) {
    const result = this.confirmations.take(ctx.channel, rest || undefined);
    if (!result.ok) {
      const codes = result.candidates?.length
        ? `\n\nWaiting: ${result.candidates.map((c) => `/confirm ${c.code} (${c.action}${c.project ? ` ${c.project}` : ''})`).join('\n')}`
        : '';
      return { reply: `${result.reason}${codes}` };
    }
    const confirmation = result.confirmation;
    this.events?.append({
      type: 'command.confirmed',
      project: confirmation.project ?? undefined,
      actor: ctx.actor,
      payload: { action: confirmation.action },
    });
    const reply = await confirmation.perform();
    return { reply: reply ?? `Done: ${confirmation.summary}` };
  }

  commandCancel(rest, ctx) {
    // `/cancel M3` cancels a mission request; `/cancel [code]` cancels a
    // pending confirmation. Both are "undo the thing you just asked me about".
    if (/^M\d+$/i.test(rest ?? '')) {
      const id = rest.toUpperCase();
      const result = this.requests.decide(id, { decision: 'cancelled', by: ctx.from });
      if (!result.ok) return { reply: result.reason };
      this.events?.append({
        type: 'mission.cancelled',
        project: result.request.project,
        actor: ctx.actor,
        payload: { id },
      });
      return { reply: `${id} cancelled. Nothing was started.` };
    }
    const result = this.confirmations.cancel(ctx.channel, rest || undefined);
    if (!result.ok) return { reply: result.reason };
    return {
      reply: result.cancelled > 1
        ? `Cancelled ${result.cancelled} pending confirmations.`
        : `Cancelled: ${result.confirmation?.summary ?? 'the pending action'}.`,
    };
  }

  /**
   * `workingDirectory` of every currently-registered project, regardless of
   * driver or whether it currently validates — a discovered candidate must
   * never be re-offered just because its config happens to be broken right
   * now (raw, not `getProject()`, precisely so a broken project doesn't
   * throw here).
   */
  existingProjectDirs() {
    const dirs = [];
    for (const name of this.registry.names()) {
      const raw = this.configManager.getRawProject?.(name);
      if (raw?.workingDirectory) dirs.push(raw.workingDirectory);
    }
    return dirs;
  }

  /** `/scan` — Phase 13 M2. Read-only: reports candidates, registers nothing. */
  commandScan(ctx) {
    const discovery = this.operatorConfig.discovery ?? {};
    if (discovery.enabled === false) {
      return { reply: 'Discovery is disabled (operator.discovery.enabled: false).' };
    }
    const roots = this.operatorConfig.projectRoots ?? [];
    const result = scanRoots(roots, {
      markers: discovery.markers,
      ignore: discovery.ignore,
      maxDepth: discovery.maxDepth,
      existingDirs: this.existingProjectDirs(),
    });
    this.events?.append({
      type: 'project.discovered',
      actor: ctx.actor,
      payload: { count: result.candidates.length, roots: result.rootsScanned },
    });
    return { reply: renderScanResults(result, { roots }) };
  }

  /**
   * `/import <path> [as <name>]` — Phase 13 M2. Purely additive: writes a new
   * `config/projects/<name>.json` pointing at a real, existing folder. Never
   * touches the folder itself, and refuses a colliding name outright
   * (`ConfigManager.saveProject()`'s existing behaviour) rather than
   * guessing which project the owner meant.
   *
   * `as <name>` exists because BOTH a filesystem path and a project name in
   * this system may legitimately contain spaces ("THE FINISHER") — splitting
   * `<path> [name]` on whitespace would be ambiguous. Without it, the
   * imported project is named after the folder's own basename, matching how
   * `/scan`'s output maps 1:1 onto `/import <path>`.
   */
  commandImport(rest, ctx) {
    const disabled = this.guardEnabled('discovery', 'Discovery');
    if (disabled) return disabled;
    if (!rest) {
      return { reply: 'Usage: /import <path> [as <name>], or /import all. Try /scan to see candidates.' };
    }
    if (rest.trim().toLowerCase() === 'all') {
      return this.commandImportAll(ctx);
    }

    const asMatch = rest.match(/^(.*?)\s+as\s+(\S.*)$/i);
    const rawPath = (asMatch ? asMatch[1] : rest).trim();
    const explicitName = asMatch ? asMatch[2].trim() : null;

    const resolved = path.resolve(rawPath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return { reply: `"${rawPath}" is not a real folder on this machine.` };
    }
    const name = explicitName || path.basename(resolved);
    if (this.registry.has(name)) {
      return { reply: `A project named "${name}" already exists. Retry: /import ${rawPath} as <different-name>.` };
    }

    try {
      this.configManager.saveProject(name, { driver: 'claude', workingDirectory: resolved });
    } catch (error) {
      return { reply: `Could not import: ${error.message}` };
    }
    this.events?.append({
      type: 'project.imported', project: name, actor: ctx.actor, payload: { path: resolved },
    });
    return {
      reply: `Imported "${name}" → ${resolved}.\n\n`
        + `It has no mission yet — add a "promptFile" or task plan to config/projects/${name}.json `
        + `before starting it. Try /status ${name}.`,
    };
  }

  /**
   * `/import all` — reconciliation pass, 2026-07-30. `/scan` already finds
   * every real, unregistered project correctly; the gap was that `/import`
   * only ever took one path, so registering N real folders meant N manual
   * commands. This closes that gap the same way `/projects classify` closes
   * the equivalent one-batch-vs-N-commands gap for classification: propose
   * everything `/scan` would find right now, one `ConfirmationStore`
   * confirmation, then write every registry file inside `perform()`.
   *
   * Still strictly additive and reversible — `saveProject()` never touches a
   * candidate's files, and any of the N imports can be individually undone
   * with `/forget <name>` afterward, same as a single `/import` always could.
   */
  commandImportAll(ctx) {
    const discovery = this.operatorConfig.discovery ?? {};
    const roots = this.operatorConfig.projectRoots ?? [];
    const result = scanRoots(roots, {
      markers: discovery.markers,
      ignore: discovery.ignore,
      maxDepth: discovery.maxDepth,
      existingDirs: this.existingProjectDirs(),
    });
    if (!result.candidates.length) {
      return { reply: 'Nothing to import — /scan finds no new candidates under your configured roots.' };
    }

    const lines = result.candidates.map((c) => `${c.name} → ${c.path}`);
    const confirmation = this.confirmations.require({
      channel: ctx.channel,
      action: 'import-all',
      summary: `Import ${result.candidates.length} project(s):\n${lines.join('\n')}`,
      perform: () => {
        const imported = [];
        const skipped = [];
        for (const candidate of result.candidates) {
          // Re-checked at confirm time, not just at propose time: something
          // else (a manual /import, a second confirmed batch) may have
          // claimed this name in the gap between the two.
          if (this.registry.has(candidate.name)) {
            skipped.push(candidate.name);
            continue;
          }
          this.configManager.saveProject(candidate.name, { driver: 'claude', workingDirectory: candidate.path });
          this.events?.append({
            type: 'project.imported', project: candidate.name, actor: ctx.actor,
            payload: { path: candidate.path, via: 'import-all' },
          });
          imported.push(candidate.name);
        }
        const skippedNote = skipped.length ? ` Skipped (already registered by the time this ran): ${skipped.join(', ')}.` : '';
        return `Imported ${imported.length} project(s): ${imported.join(', ')}.${skippedNote}\n\n`
          + 'None have a mission yet — each needs a "promptFile" or task plan in its config/projects/<name>.json before it can start.';
      },
    });
    return { reply: renderConfirmation(confirmation) };
  }

  /**
   * Shared logic behind `/mission` and `/mission all` — Phase 14 M9. Reads
   * the RAW config (never the defaults-merged view: `promptFile` has no
   * default, but checking the raw file is what makes "already has a
   * mission" mean "something actually set one", not an artifact of
   * PROJECT_DEFAULTS). `configManager.getProject()` is deliberately NOT used
   * here — it validates and would throw on exactly the projects this
   * command exists to fix.
   *
   * @returns {{ok: true, stack: object, promptFileName: string, needsPermission: boolean}
   *         | {ok: false, reason: string, alreadyReady?: boolean}}
   */
  assignMission(name, ctx, { via }) {
    const raw = this.configManager.getProjectFileContents(name);
    if (!raw) return { ok: false, reason: `"${name}" has no readable config.` };
    if (raw.promptFile || (Array.isArray(raw.tasks) && raw.tasks.length > 0)) {
      return { ok: false, alreadyReady: true, reason: 'already has a mission (a promptFile or task plan is set)' };
    }
    const workingDirectory = raw.workingDirectory;
    if (!workingDirectory || !fs.existsSync(workingDirectory)) {
      return { ok: false, reason: missingFolderDetail(workingDirectory) };
    }

    const detected = inspectProject(workingDirectory);
    const promptFileName = fs.existsSync(path.join(workingDirectory, 'prompt.md')) ? 'prompt.generated.md' : 'prompt.md';
    const resolvedDefaults = this.configManager.getRawProject(name) ?? {};
    const completionMarker = resolvedDefaults.mission?.completionMarker || 'MISSION COMPLETE';
    const promptContent = buildAutoMissionPrompt(detected, { completionMarker });
    fs.writeFileSync(path.join(workingDirectory, promptFileName), promptContent, 'utf8');

    const stack = { ...detected, source: 'auto-detected', generatedAt: new Date().toISOString() };
    this.configManager.updateProject(name, { promptFile: promptFileName, stack });
    this.events?.append({
      type: 'project.mission-assigned',
      project: name,
      actor: ctx.actor,
      payload: {
        path: workingDirectory, via, language: detected.language, framework: detected.framework, confidence: detected.confidence,
      },
    });
    return {
      ok: true,
      stack,
      promptFileName,
      needsPermission: resolvedDefaults.driver === 'claude' && !resolvedDefaults.claude?.permissionMode,
    };
  }

  /**
   * `/mission [project]` / `/mission all` — Phase 14 M9. Auto-detects a
   * project's language/framework/build-test commands from files already on
   * disk (see projectInspector.js) and writes it a starter promptFile plus a
   * `stack` metadata block — the remote fix for a project `/import`(-ed) but
   * never given a mission.
   *
   * Deliberately auto-detect only, no manual objective text:
   * `resolveTarget()`'s "the whole rest IS the project name" rule can't
   * combine with trailing free text without an ambiguous split (several real
   * project names contain spaces, e.g. "THE FINISHER"), and inspecting the
   * repo is what was actually asked for. Never overwrites an existing
   * promptFile or task plan — edit config/projects/<name>.json by hand to
   * replace one.
   */
  commandMission(rest, ctx) {
    const disabled = this.guardEnabled('mission', 'Mission auto-detection');
    if (disabled) return disabled;
    if (rest && rest.trim().toLowerCase() === 'all') {
      return this.commandMissionAll(ctx);
    }
    const resolved = this.resolveTarget(rest, ctx);
    if (resolved.reply) return { reply: resolved.reply };

    const result = this.assignMission(resolved.project, ctx, { via: 'mission' });
    if (!result.ok) {
      if (result.alreadyReady) {
        return {
          reply: `${resolved.project} already has a mission — ${result.reason}. `
            + 'Edit config/projects/<name>.json by hand to replace it; /mission never overwrites one.',
        };
      }
      return { reply: `Could not assign a mission to ${resolved.project}: ${result.reason}` };
    }
    return { reply: renderMissionAssignment(resolved.project, result) };
  }

  /**
   * `/mission all` — every registered project with no promptFile and no
   * task plan, in one confirmed batch. Mirrors `commandImportAll()`'s
   * propose-then-`/confirm`-then-execute shape; unlike it, each project's
   * detect+write is wrapped individually so one failure (e.g. a vanished
   * working directory) cannot abort the whole batch.
   */
  commandMissionAll(ctx) {
    const candidates = this.registry.names().filter((name) => {
      const raw = this.configManager.getProjectFileContents(name);
      return raw && !raw.promptFile && (!Array.isArray(raw.tasks) || raw.tasks.length === 0);
    });
    if (!candidates.length) {
      return { reply: `All ${this.registry.names().length} project(s) already have a mission.` };
    }

    const lines = candidates.map(
      (name) => `${name} → ${this.configManager.getProjectFileContents(name)?.workingDirectory}`
    );
    const confirmation = this.confirmations.require({
      channel: ctx.channel,
      action: 'mission-all',
      summary: `Auto-detect and assign a mission to ${candidates.length} project(s):\n${lines.join('\n')}`,
      perform: () => {
        const assigned = [];
        const skipped = [];
        const failed = [];
        for (const name of candidates) {
          try {
            const result = this.assignMission(name, ctx, { via: 'mission-all' });
            if (result.ok) {
              assigned.push({ name, ...result });
            } else if (result.alreadyReady) {
              // Re-checked at confirm time — the same race guard
              // commandImportAll() applies (something else assigned this
              // project's mission in the gap between propose and confirm).
              skipped.push(name);
            } else {
              failed.push({ name, error: result.reason });
            }
          } catch (error) {
            failed.push({ name, error: error.message });
          }
        }
        return renderMissionBatch({ assigned, skipped, failed });
      },
    });
    return { reply: renderConfirmation(confirmation) };
  }

  commandArchive(rest, ctx) {
    return this.mutateClassification(rest, ctx, {
      fn: archive, verb: 'Archived', to: 'archived', eventType: 'project.archived',
    });
  }

  commandRestore(rest, ctx) {
    return this.mutateClassification(rest, ctx, {
      fn: restore, verb: 'Restored', to: DEFAULT_CLASSIFICATION, eventType: 'project.restored',
    });
  }

  commandHide(rest, ctx) {
    return this.mutateClassification(rest, ctx, {
      fn: hide, verb: 'Hidden', to: 'hidden', eventType: 'project.hidden',
    });
  }

  commandUnhide(rest, ctx) {
    return this.mutateClassification(rest, ctx, {
      fn: unhide, verb: 'Unhidden', to: DEFAULT_CLASSIFICATION, eventType: 'project.unhidden',
    });
  }

  /**
   * The shared shape behind /archive, /restore, /hide, /unhide — all four
   * are reversible, registry-only classification changes (never destructive,
   * so none of them go through prepareDestructive()/ConfirmationStore).
   */
  mutateClassification(rest, ctx, { fn, verb, to, eventType }) {
    const disabled = this.guardEnabled('lifecycle', 'Lifecycle operations');
    if (disabled) return disabled;
    const resolved = this.resolveTarget(rest, ctx);
    if (resolved.reply) return { reply: resolved.reply };
    const { project } = resolved;
    try {
      fn(this.configManager, project);
    } catch (error) {
      return { reply: `Could not update ${project}: ${error.message}` };
    }
    this.events?.append({
      type: eventType, project, actor: ctx.actor, payload: { classification: to },
    });
    return { reply: `${verb} ${project} → ${to}.` };
  }

  /**
   * `/roots`, `/roots add <path>`, `/roots remove <path>` — Phase 13 M4.
   * Not destructive: adding/removing a discovery root neither deletes
   * anything nor stops any project from running (`ConfigManager.getProject()`
   * never consults `operator.projectRoots` at all — the effect is purely
   * "what /scan looks at").
   */
  commandRoots(rest, ctx) {
    const disabled = this.guardLiveConfig();
    if (disabled) return disabled;
    const trimmed = (rest ?? '').trim();
    if (!trimmed) return { reply: this.renderRoots() };

    const addMatch = trimmed.match(/^add\s+(.+)$/i);
    if (addMatch) return this.commandRootsAdd(addMatch[1].trim(), ctx);
    const removeMatch = trimmed.match(/^remove\s+(.+)$/i);
    if (removeMatch) return this.commandRootsRemove(removeMatch[1].trim(), ctx);

    return { reply: 'Usage: /roots, /roots add <path>, or /roots remove <path>.' };
  }

  renderRoots() {
    const roots = this.operatorConfig.projectRoots ?? [];
    if (!roots.length) {
      return 'No project roots configured yet. /roots add <path> to add one.';
    }
    return [`Project roots (${roots.length}):`, ...roots.map((root) => `• ${root}`)].join('\n');
  }

  commandRootsAdd(rawPath, ctx) {
    const resolved = path.resolve(rawPath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return { reply: `"${rawPath}" is not a real folder on this machine.` };
    }
    const current = this.operatorConfig.projectRoots ?? [];
    if (current.some((root) => path.resolve(root).toLowerCase() === resolved.toLowerCase())) {
      return { reply: `${resolved} is already a project root.` };
    }
    this.liveConfig.applyPatch({ 'operator.projectRoots': [...current, resolved] });
    this.events?.append({
      type: 'config.changed', actor: ctx.actor, payload: { key: 'operator.projectRoots' },
    });
    return { reply: `Added ${resolved}. /scan will include it immediately — no restart needed.` };
  }

  commandRootsRemove(rawPath, ctx) {
    const resolved = path.resolve(rawPath);
    const current = this.operatorConfig.projectRoots ?? [];
    const next = current.filter((root) => path.resolve(root).toLowerCase() !== resolved.toLowerCase());
    if (next.length === current.length) {
      return { reply: `${resolved} is not a configured root.` };
    }
    this.liveConfig.applyPatch({ 'operator.projectRoots': next });
    this.events?.append({
      type: 'config.changed', actor: ctx.actor, payload: { key: 'operator.projectRoots' },
    });

    // Non-blocking: removing a root only ever affects discovery. A project
    // already registered under it keeps running exactly as before —
    // ConfigManager.getProject() never consults projectRoots at all — but
    // that's easy to assume otherwise, so it's said plainly here.
    const affected = this.registry.names().filter((name) => {
      const raw = this.configManager.getRawProject?.(name);
      if (!raw?.workingDirectory) return false;
      const real = path.resolve(raw.workingDirectory).toLowerCase();
      const base = resolved.toLowerCase();
      return real === base || real.startsWith(`${base}${path.sep}`);
    });
    const note = affected.length
      ? `\n\nNote: ${affected.join(', ')} still work exactly as before — removing a root only affects ` +
        '/scan discovery, never a registered project\'s ability to run.'
      : '';
    return { reply: `Removed ${resolved}.${note}` };
  }

  /**
   * `/provider` — Phase 13 M5. Read-only: the machine-wide default, every
   * known driver, and — when a project is selected — that project's own
   * override, shown side by side so "what will my next mission actually
   * use" is never ambiguous. No setter exists for provider in this
   * milestone (only `/model`) — see docs/PHASE_13_PLAN.md M5.
   */
  commandProvider(ctx) {
    const defaultProvider = this.operatorConfig.defaultProvider || 'claude';
    const defaultModel = this.operatorConfig.defaultModel || '';
    const caps = capabilitiesOf(defaultProvider);
    const drivers = this.driverRegistry?.listDrivers() ?? [defaultProvider];

    const lines = ['⚙️ Provider & model', ''];
    lines.push(`Default provider: ${defaultProvider}${caps?.label ? ` — ${caps.label}` : ''}`);
    lines.push(`Default model: ${defaultModel || '(engine default)'}`);
    if (caps?.models.length) lines.push(`Available models: ${caps.models.join(', ')}`);
    lines.push('');
    lines.push(`Known drivers: ${drivers.join(', ')}`);

    const active = this.activeProject(ctx);
    if (active) {
      const raw = this.configManager.getRawProject?.(active);
      if (raw) {
        lines.push('');
        lines.push(`${active}'s own driver: ${raw.driver}`);
        lines.push(`${active}'s own model: ${raw.claude?.model || '(uses the default above)'}`);
      }
    }
    return { reply: lines.join('\n') };
  }

  /**
   * `/model [name|default]` — Phase 13 M5. With no argument, shows the
   * current default. `default` clears it back to per-project/engine
   * behaviour. Otherwise validates against the default provider's known
   * models (`capabilities.js`) before applying — a typo must not silently
   * become the model every future mission launches with.
   *
   * Resolution happens only inside `ClaudeDriver.buildArgs()`, called once
   * per launch — an in-flight mission's process is already spawned with
   * whatever model it started with, so "never interrupts an active
   * mission, new missions inherit the change" needs no special-casing here.
   */
  commandModel(rest, ctx) {
    const disabled = this.guardLiveConfig();
    if (disabled) return disabled;

    const trimmed = (rest ?? '').trim();
    if (!trimmed) {
      const current = this.operatorConfig.defaultModel;
      return {
        reply: current
          ? `Default model: ${current}`
          : 'No default model set — each project uses its own setting, or the engine default. /model <name> to set one.',
      };
    }

    const previous = this.operatorConfig.defaultModel || '';
    if (trimmed.toLowerCase() === 'default') {
      this.liveConfig.applyPatch({ 'operator.defaultModel': '' });
      this.events?.append({
        type: 'provider.model-changed', actor: ctx.actor, payload: { model: '', previousModel: previous },
      });
      return { reply: 'Default model cleared. New missions use each project\'s own setting, or the engine default.' };
    }

    const provider = this.operatorConfig.defaultProvider || 'claude';
    const caps = capabilitiesOf(provider);
    const model = trimmed.toLowerCase();
    if (caps?.models.length && !caps.models.includes(model)) {
      return { reply: `"${trimmed}" is not a known ${provider} model. Valid: ${caps.models.join(', ')}.` };
    }

    this.liveConfig.applyPatch({ 'operator.defaultModel': model });
    this.events?.append({
      type: 'provider.model-changed', actor: ctx.actor, payload: { model, previousModel: previous },
    });
    return { reply: `Default model set to "${model}". Applies to the next mission that starts — never one already running.` };
  }

  /**
   * `/safemode [on|off]` — reconciliation pass, 2026-07-30. A global
   * override, independent of any project's own `permissionMode`: while on,
   * `ClaudeDriver` never forwards `permissionMode`/`dangerouslySkipPermissions`
   * to the engine, so every mission on every project runs the same
   * already-existing headless-default behaviour (auto-deny writes) that a
   * project with no `permissionMode` set gets today — see
   * `config/projects/example.json`'s own `$comment` for that existing rule.
   * Not a new safety mechanism, just a machine-wide way to force the one
   * that already exists, for looking at an unfamiliar project before
   * trusting it with write access.
   *
   * Same isolation guarantee as `/model`: a worker reads its config once at
   * construction, so this can never interrupt a mission already running —
   * only the next one to start.
   */
  commandSafeMode(rest, ctx) {
    const disabled = this.guardLiveConfig();
    if (disabled) return disabled;

    const trimmed = (rest ?? '').trim().toLowerCase();
    const current = Boolean(this.operatorConfig.safeMode);
    if (!trimmed) {
      return {
        reply: current
          ? '🔒 Safe Mode is ON — every project runs headless-read-only, regardless of its own permissionMode.'
          : 'Safe Mode is off — projects run with their own configured permissionMode. /safemode on to force read-only globally.',
      };
    }
    if (trimmed !== 'on' && trimmed !== 'off') {
      return { reply: 'Usage: /safemode, /safemode on, or /safemode off.' };
    }

    const next = trimmed === 'on';
    if (next === current) {
      return { reply: next ? 'Safe Mode is already on.' : 'Safe Mode is already off.' };
    }
    this.liveConfig.applyPatch({ 'operator.safeMode': next });
    this.events?.append({
      type: 'operator.safemode-changed', actor: ctx.actor, payload: { safeMode: next },
    });
    return {
      reply: next
        ? '🔒 Safe Mode ON. New missions on every project run headless-read-only until /safemode off. Already-running missions are unaffected.'
        : 'Safe Mode OFF. New missions use each project\'s own permissionMode again.',
    };
  }

  /**
   * `/notify [status|telegram on|off|email on|off|discord on|off|webhook on|off|severity <level>]`
   * — Phase 14 M8. The last of the settings an owner used to have to reach
   * `config/local.json` by hand for: which channels are enabled, and the
   * minimum severity that reaches any of them. Same shape and same
   * isolation guarantee as `/safemode`/`/model` — a live-config patch, never
   * a restart, never touching an in-flight mission.
   *
   * Deliberately narrow: this only ever flips `<channel>.enabled` and
   * `minSeverity`. Credentials (botToken, chatId, SMTP host/user/pass) are
   * never set, changed, or displayed here — same boundary this codebase
   * already draws for `nvidia.apiKey`: real secrets stay a `config/
   * local.json` edit, never a chat message.
   */
  commandNotify(rest, ctx) {
    const disabled = this.guardLiveConfig();
    if (disabled) return disabled;

    const CHANNELS = ['telegram', 'email', 'discord', 'webhook'];
    const trimmed = (rest ?? '').trim();
    const words = trimmed.split(/\s+/).filter(Boolean);
    const first = (words[0] ?? '').toLowerCase();

    if (!first || first === 'status') {
      const cfg = this.notificationsConfig;
      const lines = ['🔔 Notifications', ''];
      for (const channel of CHANNELS) {
        const label = channel[0].toUpperCase() + channel.slice(1);
        lines.push(`${label}: ${cfg[channel]?.enabled ? 'Enabled' : 'Disabled'}`);
      }
      lines.push('');
      lines.push(`Minimum severity: ${cfg.minSeverity || 'info'}`);
      return { reply: lines.join('\n') };
    }

    if (CHANNELS.includes(first)) {
      const label = first[0].toUpperCase() + first.slice(1);
      const arg = (words[1] ?? '').toLowerCase();
      if (arg !== 'on' && arg !== 'off') {
        return { reply: `Usage: /notify ${first} on, or /notify ${first} off.` };
      }
      const next = arg === 'on';
      const current = Boolean(this.notificationsConfig[first]?.enabled);
      if (next === current) {
        return { reply: `${label} notifications are already ${next ? 'on' : 'off'}.` };
      }
      this.liveConfig.applyPatch({ [`notifications.${first}.enabled`]: next });
      this.events?.append({
        type: 'notifications.channel-changed',
        actor: ctx.actor,
        payload: { channel: first, enabled: next },
      });
      return { reply: `${label} notifications ${next ? 'ON' : 'OFF'}.` };
    }

    if (first === 'severity') {
      const levels = ['info', 'warning', 'critical'];
      const level = (words[1] ?? '').toLowerCase();
      if (!levels.includes(level)) {
        return { reply: `Usage: /notify severity <${levels.join('|')}>.` };
      }
      const current = this.notificationsConfig.minSeverity || 'info';
      if (level === current) {
        return { reply: `Minimum severity is already "${level}".` };
      }
      this.liveConfig.applyPatch({ 'notifications.minSeverity': level });
      this.events?.append({
        type: 'notifications.severity-changed',
        actor: ctx.actor,
        payload: { severity: level, previousSeverity: current },
      });
      return { reply: `Minimum notification severity set to "${level}".` };
    }

    return {
      reply: 'Usage: /notify, /notify telegram on|off, /notify email on|off, ' +
        '/notify discord on|off, /notify webhook on|off, or /notify severity <info|warning|critical>.',
    };
  }

  // --------------------------------------------------------------- files ----

  /**
   * The active project's real, on-disk root, or a `{reply}` explaining why
   * there isn't one. Shared by all three file commands — unlike `/status`/
   * `/tasks`, `/files` and `/file` deliberately do NOT accept a project name
   * as part of their own argument (their `rest` is a filesystem path, and a
   * path and a project name are both free-form strings with no way to tell
   * them apart) — see docs/PHASE_13_M6_REPORT.md for why this differs from
   * `resolveTarget()`. `/download-project` is the exception: it names a
   * project instead of a path, so it uses `resolveTarget()` directly.
   *
   * @returns {{project?: string, root?: string, reply?: string}}
   */
  activeProjectRoot(ctx) {
    const active = this.activeProject(ctx);
    if (!active) {
      return { reply: NO_ACTIVE_PROJECT_REPLY };
    }
    let project;
    try {
      project = this.configManager.getProject(active);
    } catch (error) {
      return { reply: `Cannot access ${active}: ${error.message}` };
    }
    return { project: active, root: project.workingDirectory };
  }

  /**
   * Every `FileAccessError` becomes its own message; anything else is
   * unexpected and re-thrown. A REFUSAL (traversal, escape, missing project
   * root — `error.code !== 'not-found'`) is recorded in the durable event
   * log, not just answered — "every real outcome becomes an event" applies
   * to a security refusal on this surface at least as much as to a success;
   * a genuinely hostile probe must leave a trail an operator can review
   * later, not just a reply nobody but the sender ever saw. A plain
   * not-found (a typo, a file that was never there) is not attack evidence
   * and is left out of the log for the same reason `/scan`'s own "no
   * candidates" result isn't logged per candidate — noise, not signal.
   */
  fileErrorReply(error, { project, path: attemptedPath, actor } = {}) {
    if (!(error instanceof FileAccessError)) throw error;
    if (error.code !== 'not-found') {
      this.events?.append({
        type: 'file.served',
        project,
        actor,
        payload: { path: attemptedPath, mode: 'refused', reason: error.message },
      });
    }
    return { reply: error.message };
  }

  /**
   * `/files [path]` — one directory level of the active project.
   *
   * A trailing bare number is read as a page ("/files src 2"); a single bare
   * word is always a path ("/files 2024" means the folder "2024", not page
   * 2) — pagination only kicks in once a path already precedes it, which
   * matches how the command is actually going to be typed in practice.
   */
  commandFiles(rest, ctx) {
    const disabled = this.guardEnabled('files', 'File access');
    if (disabled) return disabled;
    const located = this.activeProjectRoot(ctx);
    if (located.reply) return { reply: located.reply };

    const { page, rest: subPath } = this.splitTrailingPage(rest);

    let listing;
    try {
      listing = listFiles(located.root, subPath, { page });
    } catch (error) {
      return this.fileErrorReply(error, { project: located.project, path: subPath, actor: ctx.actor });
    }
    this.events?.append({
      type: 'file.served',
      project: located.project,
      actor: ctx.actor,
      payload: { path: listing.path, mode: 'list', count: listing.entries.length },
    });
    return { reply: renderFileListing(located.project, listing) };
  }

  /**
   * `/file <path>` — read one file from the active project. Small text files
   * are shown inline, in full; anything binary or larger than
   * `INLINE_MAX_BYTES` is sent as a real Telegram document instead — never
   * truncated either way (see fileAccess.js and docs/PHASE_13_M6_REPORT.md).
   */
  commandFile(rest, ctx) {
    const disabled = this.guardEnabled('files', 'File access');
    if (disabled) return disabled;
    if (!rest) return { reply: 'Usage: /file <path>. Try /files to see what is there.' };
    const located = this.activeProjectRoot(ctx);
    if (located.reply) return { reply: located.reply };

    let target;
    try {
      target = resolveWithinProject(located.root, rest);
    } catch (error) {
      return this.fileErrorReply(error, { project: located.project, path: rest, actor: ctx.actor });
    }

    let stat;
    try {
      stat = fs.statSync(target);
    } catch (error) {
      return { reply: `Could not read "${rest}": ${error.message}` };
    }
    if (stat.isDirectory()) {
      return { reply: `"${rest}" is a directory. Try /files ${rest}` };
    }

    if (stat.size > MAX_DOCUMENT_BYTES) {
      return {
        reply: `"${rest}" is ${formatBytes(stat.size)} — too large even to send as a file ` +
          `(Telegram's ${formatBytes(MAX_DOCUMENT_BYTES)} document limit). ` +
          'Read it directly on the machine, or /download-project for the rest of the project.',
      };
    }

    const binary = stat.size > 0 && looksBinary(target);
    if (binary || stat.size > INLINE_MAX_BYTES) {
      this.events?.append({
        type: 'file.served',
        project: located.project,
        actor: ctx.actor,
        payload: { path: rest, bytes: stat.size, mode: 'attachment' },
      });
      return {
        reply: `📄 ${rest} (${formatBytes(stat.size)}) — sending as a file.`,
        attachment: { filePath: target, caption: `${located.project} — ${rest}` },
      };
    }

    let content;
    try {
      content = fs.readFileSync(target, 'utf8');
    } catch (error) {
      return { reply: `Could not read "${rest}": ${error.message}` };
    }
    this.events?.append({
      type: 'file.served',
      project: located.project,
      actor: ctx.actor,
      payload: { path: rest, bytes: stat.size, mode: 'inline' },
    });
    return { reply: renderFileInline(rest, content) };
  }

  // --------------------------------------------------------------- search ---

  /**
   * Shared body of `/grep` and `/symbol` — Phase 14 M3. Both operate on the
   * ACTIVE project only, deliberately with no `[project]` argument: a query
   * and a project name are both free-form text with no delimiter between
   * them, and several real project names contain spaces ("THE FINISHER") —
   * the exact ambiguous-split problem Phase 14 M9 already ran into and
   * avoided for the same reason (see `docs/PHASE_14_PLAN.md`'s M9 section).
   * Select a project first with `/project <name>`, same as `/files`/`/file`.
   *
   * A trailing bare number is a page, but ONLY once the query is already
   * more than one word — mirrors `commandFiles()`'s identical convention and
   * accepts the identical, already-shipped tradeoff: a literally-numeric
   * one-word query (`/grep 500`) is never misread as an empty query plus a
   * page number.
   */
  runSearch(rest, ctx, { label, buildPattern }) {
    const disabled = this.guardEnabled('search', 'Repository search');
    if (disabled) return disabled;
    const { page, rest: query } = this.splitTrailingPage(rest);
    if (!query) {
      return { reply: `Usage: /${label} <${label === 'symbol' ? 'name' : 'pattern'}>.` };
    }

    const located = this.activeProjectRoot(ctx);
    if (located.reply) return { reply: located.reply };

    const regex = buildPattern(query);

    let results;
    try {
      results = searchFiles(located.root, regex, { page });
    } catch (error) {
      return this.fileErrorReply(error, { project: located.project, path: query, actor: ctx.actor });
    }

    this.events?.append({
      type: 'search.performed',
      project: located.project,
      actor: ctx.actor,
      payload: { mode: label, query, matches: results.total, truncated: results.truncated },
    });
    return { reply: renderSearchResults(located.project, label, query, results) };
  }

  /** `/grep <pattern>` — see `runSearch()`. */
  commandGrep(rest, ctx) {
    return this.runSearch(rest, ctx, { label: 'grep', buildPattern: buildGrepPattern });
  }

  /** `/symbol <name>` — see `runSearch()`. */
  commandSymbol(rest, ctx) {
    return this.runSearch(rest, ctx, { label: 'symbol', buildPattern: buildSymbolPattern });
  }

  /**
   * `/download-project [project]` — ZIP the active (or named) project's
   * source, excluding `operator.download.exclude` (node_modules/.git/build
   * output/…), size-guarded BEFORE zipping so an oversized project fails
   * fast rather than after minutes of streaming.
   */
  async commandDownloadProject(rest, ctx) {
    const disabled = this.guardEnabled('files', 'File access');
    if (disabled) return disabled;
    if (!this.paths?.downloadsDir) {
      return { reply: 'This interface cannot generate downloads from here.' };
    }
    const resolved = this.resolveTarget(rest, ctx);
    if (resolved.reply) return { reply: resolved.reply };
    const projectName = resolved.project;

    let project;
    try {
      project = this.configManager.getProject(projectName);
    } catch (error) {
      return { reply: `Cannot download ${projectName}: ${error.message}` };
    }

    const downloadConfig = this.operatorConfig.download ?? {};
    const maxBytes = downloadConfig.maxProjectBytes ?? (200 * 1024 * 1024);
    const ignore = downloadConfig.exclude;

    let size;
    try {
      size = estimateArchiveSize(project.workingDirectory, { ignore });
    } catch (error) {
      return { reply: `Could not measure ${projectName}: ${error.message}` };
    }
    if (size.bytes > maxBytes) {
      return {
        reply: `${projectName} is ${formatBytes(size.bytes)} (excluding node_modules/.git/build output) ` +
          `— over the ${formatBytes(maxBytes)} download limit. Zip it by hand on the machine instead.`,
      };
    }
    if (size.bytes > MAX_DOCUMENT_BYTES) {
      return {
        reply: `${projectName} is ${formatBytes(size.bytes)} — the ZIP would exceed Telegram's ` +
          `${formatBytes(MAX_DOCUMENT_BYTES)} document limit even though it's under the ` +
          'download limit. Read individual files with /file instead, or fetch it on the machine.',
      };
    }

    let archivePath;
    try {
      archivePath = await createProjectArchive(project.workingDirectory, projectName, {
        downloadsDir: this.paths.downloadsDir, ignore,
      });
    } catch (error) {
      return { reply: `Could not create the archive: ${error.message}` };
    }
    try {
      pruneOldDownloads(this.paths.downloadsDir, downloadConfig.retentionMs ?? 86_400_000);
    } catch (error) {
      this.logger?.warn('Could not prune old downloads', { error: error.message });
    }

    this.events?.append({
      type: 'project.downloaded',
      project: projectName,
      actor: ctx.actor,
      payload: { bytes: size.bytes, files: size.files },
    });
    return {
      reply: `📦 ${projectName} — ${formatBytes(size.bytes)}, ${size.files} file(s) zipped.`,
      attachment: { filePath: archivePath, caption: `${projectName}.zip` },
    };
  }

  // ------------------------------------------------------------ destructive --

  /**
   * Build the confirmation for a destructive command: what will happen, and
   * the closure that does it. Returns `{reply}` instead when the command
   * cannot proceed at all (so the owner is not asked to confirm a no-op).
   */
  async prepareDestructive(name, rest, ctx) {
    if (name === 'shutdown') {
      if (!this.requestShutdown) {
        return { reply: 'This service cannot be stopped remotely.' };
      }
      const workers = this.supervisor.list();
      const running = workers.length
        ? ` ${workers.length} running mission(s) (${workers.map((w) => w.project).join(', ')}) keep running and will be adopted when it starts again.`
        : '';
      return {
        summary: `Stop the AI-Orchestrator Core Service.${running} Remote control stops working until it is started again on the machine.`,
        // No 'daemon.stopped' event is appended here: the service's own stop()
        // writes it with the real reason, and two records of one shutdown
        // would make the log lie about how many times it happened.
        perform: () => {
          this.requestShutdown();
          return 'Stopping the Core Service. This is the last message until it is running again.';
        },
      };
    }

    const resolved = this.resolveTarget(rest, ctx);
    if (resolved.reply) return { reply: resolved.reply };
    const project = resolved.project;

    if (name === 'stop') {
      const holder = this.supervisor.holderOf(project);
      if (!holder) return { reply: `${project} has no mission running.` };
      return {
        project,
        summary: `Stop the mission running on ${project} (pid ${holder.pid}). The session stays resumable — /start ${project} continues it.`,
        perform: () => {
          const result = this.supervisor.stop(project, { reason: `stopped by operator via ${ctx.channel}` });
          if (!result.ok) return `Could not stop ${project}: ${result.reason}`;
          this.events?.append({
            type: 'worker.stopped',
            project,
            actor: ctx.actor,
            payload: { via: result.via },
          });
          return `⏹️ ${project} — stop requested. The session stays resumable.`;
        },
      };
    }

    if (name === 'reset') {
      const session = this.sessionManager.getResumableSession(project);
      if (!session) return { reply: `${project} has no interrupted session to abandon.` };
      if (this.supervisor.holderOf(project)) {
        return { reply: `${project} is running right now. /stop ${project} first, then /reset ${project}.` };
      }
      return {
        project,
        summary: `Abandon ${project}'s interrupted session (started ${session.createdAt}, ${session.runs} run(s)). ` +
          'Its progress record is archived and the next start begins from scratch. Files on disk are NOT touched.',
        perform: () => {
          this.sessionManager.closeSession(session, 'stopped');
          this.events?.append({
            type: 'mission.cancelled',
            project,
            actor: ctx.actor,
            payload: { sessionId: session.id, via: 'reset' },
          });
          return `${project}: interrupted session abandoned. The next start begins fresh.`;
        },
      };
    }

    if (name === 'forget') {
      const disabled = this.guardEnabled('lifecycle', 'Lifecycle operations');
      if (disabled) return disabled;
      const holder = this.supervisor.holderOf(project);
      if (holder) {
        return { reply: `${project} has a mission running (pid ${holder.pid}). /stop it first, then /forget it.` };
      }
      return {
        project,
        summary: `Forget ${project} — removes it from the registry. Files on disk are NOT touched.`,
        perform: () => {
          try {
            forget(this.configManager, project);
          } catch (error) {
            return `Could not forget ${project}: ${error.message}`;
          }
          this.events?.append({ type: 'project.forgotten', project, actor: ctx.actor, payload: {} });
          return `🗑️ ${project} forgotten. Files on disk are untouched — re-import any time with /import <path>.`;
        },
      };
    }

    return { reply: `"/${name}" is marked destructive but has no handler. This is a bug — please report it.` };
  }

  // -------------------------------------------------------------- free text --

  /**
   * Free text. The single most security-relevant path in the whole phase, and
   * therefore the most conservative: it creates a proposal and nothing else.
   */
  async handleFreeText(parsed, ctx) {
    if (this.operatorConfig.acceptFreeText === false) {
      return { reply: renderHelp({ active: this.activeProject(ctx) }) };
    }

    const active = this.activeProject(ctx);
    if (!active) {
      return {
        reply: 'No project is selected, so I do not know what that applies to.\n\n' +
          'Pick one with /projects then /project <name>, and say it again.',
      };
    }

    const objective = parsed.text.trim();
    const minChars = this.operatorConfig.minObjectiveChars ?? 12;
    if (objective.length < minChars) {
      return {
        reply: `That is too short to act on (${objective.length} characters).\n\n` +
          'Describe what you want done, or use /help for the command list.',
      };
    }

    const request = this.requests.create({
      project: active,
      objective,
      by: ctx.from,
      via: ctx.channel,
      context: this.missionContextFor(active),
    });
    if (!request) {
      return { reply: 'Mission requests are unavailable (no request store is configured).' };
    }

    this.events?.append({
      type: 'mission.created',
      project: active,
      actor: ctx.actor,
      payload: { id: request.id, objective: truncate(objective, 200) },
    });
    return { reply: renderMissionProposal(request) };
  }

  /**
   * Facts captured when a request is raised — all measured, none predicted.
   * See renderMissionProposal for why there is no estimate of THIS objective's
   * size here.
   */
  missionContextFor(projectName) {
    const record = this.registry.describe(projectName, { health: false });
    const queue = this.taskQueue.load(projectName);
    const context = {
      path: record.path ?? null,
      branch: record.git?.branch ?? null,
      dirty: record.git?.dirty ?? null,
      commit: record.git?.commit ?? null,
      queuedTasks: queue ? Math.max(0, queue.tasks.length - queue.currentIndex) : 0,
      // The single most important thing to know BEFORE approving: whether
      // approving this can produce anything at all.
      simulated: record.simulated === true,
    };
    const history = this.historyFor(projectName);
    if (history) context.history = history;
    return context;
  }

  /** This project's own measured history, or null when it has none. */
  historyFor(projectName) {
    if (!this.ledger) return null;
    const runs = this.ledger.recent(projectName, 20);
    if (!runs.length) return null;
    const durations = runs.map((r) => r.durationMs).filter((d) => Number.isFinite(d) && d > 0);
    const history = { missions: runs.length };
    if (durations.length) {
      history.averageRunMs = Math.round(durations.reduce((sum, d) => sum + d, 0) / durations.length);
    }
    const queue = this.taskQueue.load(projectName);
    let passed = 0;
    let total = 0;
    for (const task of queue?.tasks ?? []) {
      // Completion markers are excluded for the same reason Mission Cards
      // exclude them: a run whose only "verifier" was the agent announcing its
      // own success would otherwise report a 100% pass rate forever.
      for (const result of (task.checkpoint?.verify?.results ?? []).filter(isEvidenceVerifier)) {
        total += 1;
        if (result.passed) passed += 1;
      }
    }
    if (total) history.verifierPassRate = Math.round((passed / total) * 100);
    return history;
  }

  // ----------------------------------------------------------------- shared --

  handleUnknown(parsed, ctx) {
    this.events?.append({
      type: 'command.rejected',
      actor: ctx.actor,
      payload: { name: parsed.name, reason: parsed.decisionVerb ? 'bad-request-id' : 'unknown-command' },
    });
    if (parsed.decisionVerb) {
      return {
        reply: `"${parsed.name}" is not a request id. Decisions look like:\n` +
          '  APPROVE A7   (an approval)\n' +
          '  APPROVE M3   (a mission request)\n\n' +
          'Use /approvals or /missions to see what is waiting.',
      };
    }
    return {
      reply: `I do not know the command "/${parsed.name}".\n\nTry /help for everything I can do.`,
    };
  }

  /** The project this channel is pointed at, or null. */
  activeProject(ctx) {
    return this.context.activeProject(ctx.channel, ctx.chatId);
  }

  /**
   * `null` when `operatorConfig[key].enabled` isn't explicitly `false`, else
   * the `{reply}` refusal every kill switch already worded the same way —
   * shared instead of re-typed at each of the dozen call sites that gate a
   * whole command on one boolean.
   */
  guardEnabled(key, label) {
    if (this.operatorConfig[key]?.enabled === false) {
      return { reply: `${label} is disabled (operator.${key}.enabled: false).` };
    }
    return null;
  }

  /**
   * The two-check guard every live-config-writing command (`/roots`,
   * `/model`, `/safemode`, `/notify`, `/approvals mode`) opens with: the
   * `operator.liveConfig` kill switch, then whether this interface even has
   * a `LiveConfigLayer` to write through (a bare standalone process has
   * none). `null` when both pass.
   */
  guardLiveConfig() {
    if (this.operatorConfig.liveConfig?.enabled === false) {
      return { reply: 'Live configuration is disabled (operator.liveConfig.enabled: false).' };
    }
    if (!this.liveConfig) {
      return { reply: 'This interface cannot change configuration from here.' };
    }
    return null;
  }

  /**
   * Split a trailing bare number off `rest` as a page number — but only once
   * more than one word already precedes it, so a single numeric word/query
   * ("/files 2024", "/grep 500") is never misread as an empty argument plus
   * a page. Shared by every paginated command (`/files`, `/log`, `/grep`,
   * `/symbol`) — they all typed this identical split out separately before.
   *
   * @returns {{page: number, rest: string}}
   */
  splitTrailingPage(rest) {
    const words = (rest ?? '').trim().split(/\s+/).filter(Boolean);
    let page = 1;
    if (words.length > 1 && /^\d+$/.test(words.at(-1))) page = Number(words.pop());
    return { page, rest: words.join(' ') };
  }

  /**
   * Resolve "which project does this command mean": the named one, else the
   * active one. Returns `{reply}` when it cannot be answered, so callers can
   * pass the message straight through.
   *
   * @returns {{project?: string, reply?: string}}
   */
  resolveTarget(rest, ctx) {
    if (rest) {
      const { match, candidates } = this.registry.resolveName(rest);
      if (!match) return { reply: this.noSuchProject(rest, candidates) };
      return { project: match };
    }
    const active = this.activeProject(ctx);
    if (!active) {
      return {
        reply: 'No project selected, and none named.\n\n' +
          'Try /projects, then /project <name> — or name one directly, e.g. /status calculator.',
      };
    }
    if (!this.registry.has(active)) {
      this.context.clear(ctx.channel, ctx.chatId);
      return { reply: `The selected project "${active}" no longer exists. Pick another with /projects.` };
    }
    return { project: active };
  }

  /** One consistent "I could not find that project" message. */
  noSuchProject(input, candidates) {
    if (candidates?.length > 1) {
      return `"${input}" matches ${candidates.length} projects: ${candidates.join(', ')}.\n` +
        'Say which one.';
    }
    const known = this.registry.names();
    return known.length
      ? `No project matches "${input}".\n\nKnown projects: ${known.join(', ')}.`
      : `No project matches "${input}", and none are defined yet.`;
  }
}

export default CommandRouter;
