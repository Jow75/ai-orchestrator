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
import {
  archive, restore, hide, unhide, forget, classifyProposal,
} from './projectLifecycleOps.js';
import { DEFAULT_CLASSIFICATION } from '../config/projectClassification.js';
import {
  renderProjectList, renderProjectDetail, renderTasks, renderApprovals,
  renderMissionProposal, renderMissionRequests, renderEvents, renderConfirmation,
  renderHelp, renderServiceStatus, renderScanResults, truncate,
} from './render.js';

/** How many events `/events` returns when no count is given. */
export const DEFAULT_EVENT_COUNT = 12;

/** Upper bound on `/events <n>`, so one message cannot become a wall of text. */
export const MAX_EVENT_COUNT = 40;

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
   * @param {object} deps.config - The full merged global config.
   * @param {() => void} [deps.requestShutdown] - Stops the Core Service.
   * @param {object} deps.logger
   */
  constructor({
    registry, context, requests, confirmations, events, approvalStore, approvalManager,
    supervisor, taskQueue, sessionManager, ledger, configManager, config,
    requestShutdown, serviceReport, logger,
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
    this.config = config ?? {};
    this.requestShutdown = requestShutdown;
    this.serviceReport = serviceReport;
    this.logger = logger;
  }

  get operatorConfig() {
    return this.config.operator ?? {};
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
   * @returns {Promise<{reply: string|null}>}
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
      case 'start': return this.commandStart(rest, ctx);
      case 'tasks': return this.commandTasks(rest, ctx);
      case 'approvals': return this.commandApprovals();
      case 'missions': return this.commandMissions(ctx);
      case 'service': return await this.commandService();
      case 'events': return this.commandEvents(rest, ctx);
      case 'confirm': return await this.commandConfirm(rest, ctx);
      case 'cancel': return this.commandCancel(rest, ctx);
      case 'scan': return this.commandScan(ctx);
      case 'import': return this.commandImport(rest, ctx);
      case 'archive': return this.commandArchive(rest, ctx);
      case 'restore': return this.commandRestore(rest, ctx);
      case 'hide': return this.commandHide(rest, ctx);
      case 'unhide': return this.commandUnhide(rest, ctx);
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
    if (!active) return { reply: 'No project selected. /projects then /project <name>.' };
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

  commandApprovals() {
    return {
      reply: renderApprovals(this.approvalStore.pendingAll(), {
        simulated: this.registry.simulatedNames(),
      }),
    };
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
    if (this.operatorConfig.discovery?.enabled === false) {
      return { reply: 'Discovery is disabled (operator.discovery.enabled: false).' };
    }
    if (!rest) {
      return { reply: 'Usage: /import <path> [as <name>]. Try /scan to see candidates.' };
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
    if (this.operatorConfig.lifecycle?.enabled === false) {
      return { reply: 'Lifecycle operations are disabled (operator.lifecycle.enabled: false).' };
    }
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
      if (this.operatorConfig.lifecycle?.enabled === false) {
        return { reply: 'Lifecycle operations are disabled (operator.lifecycle.enabled: false).' };
      }
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
