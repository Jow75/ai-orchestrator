/**
 * onboarding/init.js — Phase 11A: the first-run flow (`ai-orchestrator init`).
 *
 * One guided path from a clean install to a working project and a phone
 * that receives approvals — without editing a single JSON file. It only
 * orchestrates the other wizards and a few probes; it is idempotent and
 * re-runnable, and every step is skippable. Nothing here is a required code
 * path — an expert who never runs `init` is entirely unaffected.
 *
 * Everything the flow touches (probes, notify test, auto-resume task, and
 * starting a mission) is injected, so the orchestration is unit-tested
 * without a real environment or a live orchestrator process.
 *
 * Live-walkthrough finding (2026-07-26): finishing the wizard with a
 * `<project>` PLACEHOLDER in the "start a mission" line was actively
 * confusing — a real user tried the literal text `<project>`. The flow now
 * ends with a concrete, copy-pasteable command using a REAL project name,
 * and — since "how do I actually launch this" was the #1 confusion — offers
 * to start a mission right there instead of making the operator go find the
 * command at all.
 */

import { runProjectWizard } from './projectWizard.js';
import { runTelegramSetup, runEmailSetup } from './notifyWizard.js';

/** Quote a project name for a shell command only if it needs it (has whitespace). */
function quoteProjectName(name) {
  return /\s/.test(name) ? `"${name}"` : name;
}

/**
 * Run the first-run flow.
 *
 * @param {object} params
 * @param {import('../config/configManager.js').ConfigManager} params.configManager
 * @param {import('./prompts.js').Prompter} params.prompter
 * @param {() => Promise<Array<{label:string, ok:boolean, detail?:string}>>} params.probe
 *   Environment checks (Node, engine). Rendered but never blocking.
 * @param {() => Promise<Array<{name:string, ok:boolean, error?:string}>>} [params.notifyTest]
 *   Sends a live test through every enabled channel; results are shown.
 * @param {{isInstalled:()=>Promise<boolean>, install:()=>Promise<void>}} [params.autoResume]
 *   Auto-resume task control (null on platforms without it).
 * @param {(projectName:string) => Promise<{complete?:boolean, reason?:string}>} [params.startMission]
 *   Actually launches supervision for one project (mirrors the `start` CLI
 *   command). When omitted, the flow only prints the command instead of
 *   offering to run it — used by tests that don't want a real orchestrator.
 * @param {Function} [params.projectWizard] - Injectable (defaults to the real one).
 * @param {Function} [params.telegramWizard]
 * @param {Function} [params.emailWizard]
 * @returns {Promise<void>}
 */
export async function runInit({
  configManager, prompter, probe, notifyTest, autoResume, startMission,
  projectWizard = runProjectWizard,
  telegramWizard = runTelegramSetup,
  emailWizard = runEmailSetup,
}) {
  const p = prompter;
  p.say('\n════════════════════════════════════════════════════════════');
  p.say('  Welcome to AI-Orchestrator — let\'s get you running.');
  p.say('  Every step is optional; press Ctrl+C anytime and re-run `init`.');
  p.say('════════════════════════════════════════════════════════════');

  // 1. Environment probes (informational).
  p.say('\nChecking your environment…');
  const checks = await probe();
  for (const c of checks) {
    p.say(`  ${c.ok ? '✔' : '✘'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  if (checks.some((c) => /engine|claude/i.test(c.label) && !c.ok)) {
    p.say('  (No engine yet? You can still try everything with the built-in "mock" driver.)');
  }

  // 2. First project.
  const existing = configManager.listProjects();
  if (existing.length) {
    p.say(`\nYou already have ${existing.length} project(s): ${existing.join(', ')}.`);
  }
  const wantProject = await p.confirm(
    existing.length ? 'Create another project?' : 'Create your first project now?',
    { default: existing.length === 0 }
  );
  let justCreated = null;
  if (wantProject) {
    const created = await projectWizard({ configManager, prompter });
    justCreated = created?.name ?? null;
  }

  // 3. Telegram (phone approvals — the headline remote workflow).
  if (await p.confirm('Set up Telegram so you can approve work from your phone?', { default: true })) {
    await telegramWizard({ configManager, prompter });
  }

  // 4. Email.
  if (await p.confirm('Set up email notifications too?', { default: false })) {
    await emailWizard({ configManager, prompter });
  }

  // 5. Auto-resume task (optional, platform-specific).
  if (autoResume) {
    const installed = await autoResume.isInstalled();
    if (installed) {
      p.say('\n✔ Auto-resume task already installed (missions survive a reboot).');
    } else if (await p.confirm('Install the auto-resume task so missions survive a reboot?', { default: false })) {
      try {
        await autoResume.install();
        p.say('  ✔ Auto-resume task installed.');
      } catch (error) {
        p.say(`  ✘ Could not install it: ${error.message}`);
      }
    }
  }

  // 6. Live channel test.
  if (notifyTest) {
    const channels = await notifyTest();
    if (channels?.length) {
      p.say('\nTesting your notification channels…');
      for (const c of channels) {
        p.say(`  ${c.ok ? '✔' : '✘'} ${c.name}${c.error ? ` — ${c.error}` : ''}`);
      }
    }
  }

  // 7. Offer to actually launch a mission — the #1 confusion in the live
  // walkthrough was "how do I launch this at all?". If a project exists
  // (just created or already there), ask and, on yes, start it right here
  // instead of leaving the operator to find the command.
  const projectsNow = configManager.listProjects();
  let startedProject = null;
  if (startMission && projectsNow.length) {
    const wantStart = await p.confirm(
      projectsNow.length === 1
        ? `Start "${projectsNow[0]}" now?`
        : 'Start a mission now?',
      { default: true }
    );
    if (wantStart) {
      const target = projectsNow.length === 1
        ? projectsNow[0]
        : await p.choose('Which project?', projectsNow, { default: justCreated ?? projectsNow[0] });
      p.say(`\nStarting "${target}" — this terminal now supervises it.`);
      const result = await startMission(target);
      if (result?.complete) p.say(`✅ Mission complete: ${result.reason}`);
      else if (result?.reason) p.say(`■ Supervision ended: ${result.reason}`);
      startedProject = target;
    }
  }

  p.say(buildReadySummary(configManager, { startedProject }));
}

/** The closing "you're ready" summary, reflecting what the wizards wrote. */
function buildReadySummary(configManager, { startedProject } = {}) {
  configManager.load(); // pick up everything the wizards persisted
  const projects = configManager.listProjects();
  const notif = configManager.get('notifications', {});
  const channels = ['desktop', 'telegram', 'email', 'discord', 'webhook'].filter((n) => notif[n]?.enabled);
  const mode = configManager.get('approvals.mode', 'balanced');

  let nextStep;
  if (startedProject) {
    nextStep = `    "${startedProject}" is running — stop it safely any time: ai-orchestrator stop`;
  } else if (projects.length) {
    nextStep = `    Start a mission:  ai-orchestrator start ${quoteProjectName(projects[0])}`;
  } else {
    nextStep = '    Create a project:  ai-orchestrator projects add --interactive';
  }

  return [
    '\n════════════════════════════════════════════════════════════',
    "  You're ready.",
    `    Projects:  ${projects.length ? projects.join(', ') : 'none yet — run: projects add --interactive'}`,
    `    Channels:  ${channels.join(', ') || 'desktop only'}`,
    `    Approvals: ${mode} mode — nothing interrupts you except owner gates.`,
    '',
    nextStep,
    '    Watch it live:     ai-orchestrator status  (or the desktop app — docs/DESKTOP_GUIDE.md)',
    '    Re-check setup:    ai-orchestrator doctor',
    '════════════════════════════════════════════════════════════',
  ].join('\n');
}

export default runInit;
