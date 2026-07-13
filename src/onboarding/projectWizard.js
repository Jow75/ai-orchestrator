/**
 * onboarding/projectWizard.js — Phase 11B: guided project creation.
 *
 * The single biggest new-user failure in Phase 10.5 was a project born
 * unable to write a file. This wizard asks the same questions an expert
 * answers by hand, creates the working directory and a starter prompt when
 * they don't exist, runs the result through the SAME `validateProject` the
 * loader uses, and only then writes a complete, valid project file — the
 * identical shape `projects add` produces. No new config path: it is a
 * config writer, nothing more.
 *
 * Reused by `projects add --interactive` and by `ai-orchestrator init`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_DEFAULTS } from '../config/defaults.js';
import { deepMerge } from '../config/configManager.js';

/** Claude permission modes, most-recommended first. */
const PERMISSION_MODES = [
  { value: 'acceptEdits', label: 'acceptEdits', hint: 'agent edits files unattended (recommended)' },
  { value: 'bypassPermissions', label: 'bypassPermissions', hint: 'agent may also run commands — highest trust' },
  { value: '', label: 'read-only', hint: 'agent cannot write; a real mission will block' },
];

const STARTER_MISSION_PROMPT =
  '# Mission\n\n' +
  'Describe what you want the agent to build here. Be specific about the\n' +
  'goal, the constraints, and how you will know it is done.\n\n' +
  'When the entire mission is finished, output the exact text on its own line:\n\n' +
  'MISSION COMPLETE\n';

const STARTER_TASK_PROMPT =
  '# Task\n\n' +
  'Describe this single task for the agent. Keep it focused — the mission\n' +
  'is the sum of its tasks.\n';

/** Name characters we allow (mirrors what becomes a JSON file name). */
const NAME_PATTERN = /^[A-Za-z0-9 ._-]+$/;

/**
 * Run the project-creation wizard.
 *
 * @param {object} params
 * @param {import('../config/configManager.js').ConfigManager} params.configManager
 * @param {import('./prompts.js').Prompter} params.prompter
 * @param {string} [params.name] - Pre-supplied name (used if valid+unique).
 * @returns {Promise<{name: string, file: string, definition: object}>}
 */
export async function runProjectWizard({ configManager, prompter, name: provided }) {
  const p = prompter;
  p.say('\n── New project ─────────────────────────────────────────────');

  const taken = new Set(configManager.listProjects());
  const nameProblem = (v) => {
    if (!NAME_PATTERN.test(v)) return 'Use letters, numbers, spaces, dot, dash or underscore.';
    if (taken.has(v)) return `A project named "${v}" already exists — pick another.`;
    return true;
  };
  let name = provided;
  if (!name || nameProblem(name) !== true) {
    if (name) p.say(`  ${nameProblem(name)}`);
    name = await p.text('Project name', { validate: nameProblem });
  }

  const workingDirectory = await ensureWorkingDirectory(p);

  const driver = await p.choose('Which engine runs this project?', [
    { value: 'claude', label: 'claude', hint: 'Claude Code (default)' },
    { value: 'mock', label: 'mock', hint: 'scripted driver, for trying the orchestrator' },
  ], { default: 'claude' });

  const shape = await p.choose('How is the work defined?', [
    { value: 'prompt', label: 'Single mission prompt', hint: 'one prompt; agent works until MISSION COMPLETE' },
    { value: 'tasks', label: 'Multi-step task plan', hint: 'ordered tasks; add more later with `tasks add`' },
  ], { default: 'prompt' });

  const definition = { driver, workingDirectory };

  if (shape === 'prompt') {
    definition.promptFile = await ensurePromptFile(
      p, workingDirectory, 'prompt.md', STARTER_MISSION_PROMPT, 'mission prompt'
    );
  } else {
    const taskPrompt = await ensurePromptFile(
      p, workingDirectory, 'task-1.md', STARTER_TASK_PROMPT, 'first task prompt'
    );
    definition.tasks = [{
      id: 'T1',
      objective: await p.text('First task objective', { default: 'Implement the first task' }),
      prompt: taskPrompt,
    }];
  }

  if (driver === 'claude') {
    p.say('\nUnattended runs need write permission, or the agent can do nothing and the mission blocks.');
    const permissionMode = await p.choose('Engine permission mode', PERMISSION_MODES, { default: 'acceptEdits' });
    definition.claude = { permissionMode };
    const tools = (await p.text(
      'Restrict to specific tools? (comma-separated, blank = no restriction)',
      { default: '', allowEmpty: true }
    )).trim();
    if (tools) {
      definition.claude.allowedTools = tools.split(',').map((t) => t.trim()).filter(Boolean);
    }
  }

  // Safety net: validate exactly as the loader would before writing anything.
  const merged = deepMerge(PROJECT_DEFAULTS, definition);
  merged.name = name;
  configManager.validateProject(merged, `<wizard:${name}>`);

  const file = configManager.saveProject(name, definition);
  p.say(`\n✅ Project "${name}" created: ${file}`);
  p.say(`   Start it with:  ai-orchestrator start "${name}"`);
  if (driver === 'claude' && definition.claude?.permissionMode === '') {
    p.say('   ⚠ Read-only mode: set claude.permissionMode before a real mission or it will block.');
  }
  return { name, file, definition };
}

/** Ask for a working directory that exists (offer to create it otherwise). */
async function ensureWorkingDirectory(p) {
  for (;;) {
    const dir = path.resolve(await p.text('Working directory (the folder the agent operates in)'));
    if (fs.existsSync(dir)) {
      if (fs.statSync(dir).isDirectory()) return dir;
      p.say('  That path is a file, not a directory — choose another.');
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    if (await p.confirm(`${dir} does not exist. Create it?`, { default: true })) {
      fs.mkdirSync(dir, { recursive: true });
      p.say(`  Created ${dir}`);
      return dir;
    }
    p.say('  The working directory must exist — enter a path to create or an existing folder.');
  }
}

/**
 * Ask for a prompt file; create a starter from `template` when it's missing.
 * Returns the path as the operator gave it (relative paths are preserved so
 * the project file stays portable), guaranteed to resolve to a real file.
 */
async function ensurePromptFile(p, workingDirectory, defaultName, template, label) {
  for (;;) {
    const rel = await p.text(
      `Path to the ${label} (relative to the working dir, or absolute)`,
      { default: defaultName }
    );
    const abs = path.isAbsolute(rel) ? rel : path.join(workingDirectory, rel);
    if (fs.existsSync(abs)) {
      p.say(`  Using existing ${abs}`);
      return rel;
    }
    // eslint-disable-next-line no-await-in-loop
    if (await p.confirm(`${abs} does not exist. Create a starter file?`, { default: true })) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, template, 'utf8');
      p.say(`  Created ${abs}`);
      return rel;
    }
    p.say('  A prompt file is required — enter a path to create, or an existing file.');
  }
}

export default runProjectWizard;
