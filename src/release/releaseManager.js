/**
 * releaseManager.js — Phase 10J: approval-aware release automation.
 *
 * Two halves, deliberately separated:
 *
 *   prepare(project, version)
 *     Reads what the mission system already recorded — task checkpoints,
 *     verification results, ledger stats — and writes DRAFTS under
 *     `state/releases/<project>/<version>/`: release notes, a verification
 *     report, and a machine-readable release.json. Pure generation; changes
 *     nothing in the target project.
 *
 *   apply(project, version)
 *     The mutating half, gated through the Approval Manager (category
 *     `release.approvalCategory`, default 'commit' — automatic in balanced
 *     mode, but one config line makes it owner-gated). When approved it
 *     bumps the target's package.json, prepends the CHANGELOG entry, and
 *     creates a git commit + tag IN THE TARGET PROJECT's repository.
 *     Pushing to a remote is never automated — that stays a human act.
 *
 * Emits 'release:created' after a successful prepare (the notification
 * engine renders it when attached).
 */

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { writeJsonAtomic } from '../state/statePersistence.js';
import { formatDuration } from '../infra/time.js';

export class ReleaseManager extends EventEmitter {
  /**
   * @param {object} deps
   * @param {import('../config/configManager.js').ConfigManager} deps.configManager
   * @param {import('../mission/taskQueue.js').TaskQueue} deps.taskQueue
   * @param {import('../progress/progressLedger.js').ProgressLedger} deps.ledger
   * @param {import('../approvals/approvalManager.js').ApprovalManager} [deps.approvalManager]
   * @param {string} deps.releasesDir - state/releases.
   * @param {object} deps.releaseConfig - The `release` config block.
   * @param {object} deps.logger
   * @param {Function} [deps.execGit] - Injectable git runner (tests).
   */
  constructor({ configManager, taskQueue, ledger, approvalManager, releasesDir, releaseConfig, logger, execGit }) {
    super();
    this.configManager = configManager;
    this.taskQueue = taskQueue;
    this.ledger = ledger;
    this.approvalManager = approvalManager ?? null;
    this.releasesDir = releasesDir;
    this.releaseConfig = releaseConfig ?? {};
    this.logger = logger;
    this.execGit = execGit ?? defaultExecGit;
  }

  dir(project, version) {
    return path.join(this.releasesDir, project, version);
  }

  /**
   * Generate release notes + verification report drafts from mission data.
   *
   * @param {string} projectName
   * @param {{version: string, highlights?: string}} params
   * @returns {{ok: boolean, reason?: string, notesPath?: string, reportPath?: string, release?: object}}
   */
  prepare(projectName, { version, highlights }) {
    if (!validVersion(version)) {
      return { ok: false, reason: `"${version}" is not a valid version (expected e.g. 1.2.0).` };
    }
    const queue = this.taskQueue.load(projectName);
    const runs = this.ledger.recent(projectName, 200);

    const doneTasks = (queue?.tasks ?? []).filter((t) => t.state === 'done');
    const totalMs = runs.reduce((sum, r) => sum + (r.durationMs ?? 0), 0);
    const release = {
      project: projectName,
      version,
      preparedAt: new Date().toISOString(),
      tasksCompleted: doneTasks.length,
      totalRuns: runs.length,
      progressedRuns: runs.filter((r) => r.progressed).length,
      agentTimeMs: totalMs,
      tag: `${this.releaseConfig.tagPrefix ?? 'v'}${version}`,
    };

    const outDir = this.dir(projectName, version);
    fs.mkdirSync(outDir, { recursive: true });

    const notesPath = path.join(outDir, 'RELEASE_NOTES.md');
    fs.writeFileSync(notesPath, this.renderNotes({ release, doneTasks, highlights }), 'utf8');

    const reportPath = path.join(outDir, 'VERIFICATION_REPORT.md');
    fs.writeFileSync(reportPath, this.renderVerificationReport({ release, queue }), 'utf8');

    writeJsonAtomic(path.join(outDir, 'release.json'), release);

    this.logger.info('Release drafts prepared', { project: projectName, version, outDir });
    this.emit('release:created', { project: projectName, version, notesPath });
    return { ok: true, notesPath, reportPath, release };
  }

  /** The owner-facing release notes draft. */
  renderNotes({ release, doneTasks, highlights }) {
    const lines = [
      `# ${release.project} ${release.tag}`,
      '',
      `_Prepared ${new Date(release.preparedAt).toLocaleString()} by AI-Orchestrator._`,
      '',
    ];
    if (highlights) lines.push(highlights, '');
    lines.push('## Completed work', '');
    if (!doneTasks.length) {
      lines.push('_No verified task checkpoints on record — write the summary by hand._', '');
    }
    for (const task of doneTasks) {
      lines.push(`- **${task.id}** — ${task.objective ?? ''}`);
      if (task.checkpoint?.summary) lines.push(`  ${firstLine(task.checkpoint.summary)}`);
    }
    lines.push(
      '',
      '## Mission statistics',
      '',
      `- Runs: ${release.totalRuns} (${release.progressedRuns} made measurable progress)`,
      `- Agent time: ${formatDuration(release.agentTimeMs)}`,
      `- Verified tasks: ${release.tasksCompleted}`,
      ''
    );
    return lines.join('\n');
  }

  /** The verification report draft (what passed, what it checked). */
  renderVerificationReport({ release, queue }) {
    const lines = [
      `# Verification report — ${release.project} ${release.tag}`,
      '',
    ];
    if (!queue?.tasks?.length) {
      lines.push('_No task queue on record (legacy single-prompt mission)._');
      return lines.join('\n');
    }
    for (const task of queue.tasks) {
      lines.push(`## ${task.id} — ${task.state}`, '');
      const results = task.checkpoint?.verify?.results ?? task.lastVerifyResult?.results ?? [];
      if (!results.length) {
        lines.push('_No verifier results recorded._', '');
        continue;
      }
      for (const result of results) {
        lines.push(`- ${result.passed ? '✔' : '✘'} **${result.type}** — ${result.detail}`);
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  /**
   * Apply a prepared release to the target project: version bump, CHANGELOG
   * entry, git commit + tag. Approval-aware and idempotent per step.
   *
   * @param {string} projectName
   * @param {{version: string}} params
   * @returns {Promise<{ok: boolean, reason?: string, pendingRequest?: object, steps?: object[]}>}
   */
  async apply(projectName, { version }) {
    const releaseJson = path.join(this.dir(projectName, version), 'release.json');
    if (!fs.existsSync(releaseJson)) {
      return {
        ok: false,
        reason: `No prepared release ${version} for "${projectName}" — run "release prepare" first.`,
      };
    }
    const project = this.configManager.getProject(projectName);

    // ── Approval gate ───────────────────────────────────────────────────────
    if (this.approvalManager) {
      const category = this.releaseConfig.approvalCategory ?? 'commit';
      const priorApproval = this.findUsableApproval(projectName, version, category);
      if (!priorApproval) {
        const { approved, request } = await this.approvalManager.requestApproval({
          project: projectName,
          category,
          title: `Release ${version} — ${projectName}`,
          summary: `Apply release ${version}: bump package.json, update CHANGELOG.md, ` +
            `git commit + tag ${this.releaseConfig.tagPrefix ?? 'v'}${version}. ` +
            'Nothing is pushed to any remote.',
          details: { action: 'release-apply', version },
          projectConfig: project,
        });
        if (!approved) {
          return {
            ok: false,
            reason: `Approval required (request ${request.id}). Approve it, then run apply again.`,
            pendingRequest: request,
          };
        }
      } else {
        this.approvalManager.store.annotate(projectName, priorApproval.id, {
          consumedAt: new Date().toISOString(),
        });
      }
    }

    // ── The steps ───────────────────────────────────────────────────────────
    const steps = [];
    const workingDirectory = project.workingDirectory;
    const tag = `${this.releaseConfig.tagPrefix ?? 'v'}${version}`;

    // 1. package.json bump (when the target has one).
    const pkgPath = path.join(workingDirectory, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        pkg.version = version;
        fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
        steps.push({ step: 'package.json', ok: true, detail: `version → ${version}` });
      } catch (error) {
        steps.push({ step: 'package.json', ok: false, detail: error.message });
      }
    } else {
      steps.push({ step: 'package.json', ok: true, detail: 'none present — skipped' });
    }

    // 2. CHANGELOG entry (prepended; file created when absent).
    try {
      const changelogPath = path.join(workingDirectory, 'CHANGELOG.md');
      const notes = fs.readFileSync(path.join(this.dir(projectName, version), 'RELEASE_NOTES.md'), 'utf8');
      const existing = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, 'utf8') : '';
      const entry = `## ${tag} — ${new Date().toISOString().slice(0, 10)}\n\n` +
        `${notes.split('\n').slice(2).join('\n').trim()}\n\n`;
      fs.writeFileSync(changelogPath, entry + existing, 'utf8');
      steps.push({ step: 'CHANGELOG.md', ok: true, detail: `${tag} entry prepended` });
    } catch (error) {
      steps.push({ step: 'CHANGELOG.md', ok: false, detail: error.message });
    }

    // 3. git commit + tag (never push).
    const add = this.execGit(['add', 'package.json', 'CHANGELOG.md'], workingDirectory);
    if (add.ok) {
      const commit = this.execGit(['commit', '-m', `Release ${tag}`], workingDirectory);
      steps.push({ step: 'git commit', ok: commit.ok, detail: commit.detail });
      if (commit.ok) {
        const tagResult = this.execGit(['tag', tag], workingDirectory);
        steps.push({ step: 'git tag', ok: tagResult.ok, detail: tagResult.ok ? tag : tagResult.detail });
      }
    } else {
      steps.push({ step: 'git commit', ok: false, detail: `git add failed: ${add.detail}` });
    }

    const ok = steps.every((s) => s.ok);
    this.logger.info('Release applied', { project: projectName, version, ok, steps });
    return { ok, steps };
  }

  /** An already-approved, not-yet-consumed apply request for this version. */
  findUsableApproval(projectName, version, category) {
    if (!this.approvalManager?.store) return null;
    return this.approvalManager.store.list(projectName).find((r) =>
      r.category === category
      && (r.status === 'approved' || r.status === 'modified')
      && r.details?.action === 'release-apply'
      && r.details?.version === version
      && !r.details?.consumedAt) ?? null;
  }
}

function validVersion(version) {
  return /^\d+\.\d+\.\d+(?:[-.][\w.]+)?$/.test(version ?? '');
}

function firstLine(text) {
  return text.split('\n')[0];
}

/** Run one git command; normalized {ok, detail}. */
function defaultExecGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.error) return { ok: false, detail: result.error.message };
  return {
    ok: result.status === 0,
    detail: (result.status === 0 ? result.stdout : result.stderr).trim().split('\n')[0] ?? '',
  };
}

export default ReleaseManager;
