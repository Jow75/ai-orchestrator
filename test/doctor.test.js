/**
 * Tests for doctor/doctor.js (Phase 11 M3): structured findings, the
 * renderer, and fix application. This is also the golden-path guard the
 * plan calls for — a healthy fixture must yield ok findings for every
 * check, matching the pre-M3 doctor's own behaviour exactly (same checks,
 * same conditions, same early-return on bad config).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigManager } from '../src/config/configManager.js';
import { DriverRegistry } from '../src/drivers/driverRegistry.js';
import { silentLogger } from '../src/infra/logger.js';
import {
  buildDoctorFindings, renderDoctorFindings, applyDoctorFix,
} from '../src/doctor/doctor.js';

/**
 * A throwaway installation root with config files, mirroring other test
 * files. Each project definition may be a plain object/string OR a
 * `(root) => definition` thunk — needed whenever a project's own
 * workingDirectory is the scratch root itself (only known once created).
 */
function scaffold({ orchestrator, projects = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-doctor-'));
  fs.mkdirSync(path.join(root, 'config', 'projects'), { recursive: true });
  if (orchestrator) {
    fs.writeFileSync(path.join(root, 'config', 'orchestrator.json'), JSON.stringify(orchestrator));
  }
  for (const [name, def] of Object.entries(projects)) {
    const definition = typeof def === 'function' ? def(root) : def;
    fs.writeFileSync(
      path.join(root, 'config', 'projects', `${name}.json`),
      typeof definition === 'string' ? definition : JSON.stringify(definition)
    );
  }
  return root;
}

/** A healthy mock project: no engine to install, no permission-mode gap. */
function healthyProject(workingDirectory) {
  const promptFile = path.join(workingDirectory, 'doctor-test-prompt.md');
  if (!fs.existsSync(promptFile)) fs.writeFileSync(promptFile, '# prompt\n');
  return { driver: 'mock', workingDirectory, promptFile: 'doctor-test-prompt.md' };
}

function findingsFor(root, overrides = {}) {
  return buildDoctorFindings({
    configManager: new ConfigManager({ rootDir: root }),
    driverRegistry: new DriverRegistry({ logger: silentLogger }),
    platform: 'linux', // skip the Windows-only scheduled-task check by default
    ...overrides,
  });
}

function byId(findings, id) { return findings.find((f) => f.id === id); }

test('golden path: a healthy single-project setup yields only ok findings', async () => {
  const root = scaffold({
    projects: { demo: (r) => healthyProject(r) }, // workingDirectory must exist; root itself does
  });
  // A real permissionMode avoids the write-permission warning for a non-claude driver anyway (mock).
  const findings = await findingsFor(root);

  assert.equal(byId(findings, 'node-version').status, 'ok');
  assert.equal(byId(findings, 'global-config').status, 'ok');
  assert.equal(byId(findings, 'projects-defined').status, 'ok');
  assert.equal(byId(findings, 'project-valid:demo').status, 'ok');
  assert.equal(byId(findings, 'engine:demo').status, 'ok');
  assert.equal(byId(findings, 'engine:demo').detail, 'mock-1.0.0');
  assert.equal(byId(findings, 'state-dir-writable').status, 'ok');
  // desktop is enabled by default -> notification-channels ok, but no remote channel -> warn.
  assert.equal(byId(findings, 'notification-channels').status, 'ok');
  assert.equal(byId(findings, 'remote-channel').status, 'warn');
  // No claude project -> no write-permission finding at all.
  assert.equal(byId(findings, 'write-permission:demo'), undefined);
  // …but a mock project IS a fixture, and doctor is where an owner arrives
  // after a mission "worked" over an empty workspace.
  assert.equal(byId(findings, 'simulated:demo').status, 'warn');
  // No fail-status findings at all in the healthy path (remote-channel is warn, expected).
  assert.deepEqual(findings.filter((f) => f.status === 'fail'), []);
});

test('invalid global config: stops right after (node-version check runs first, matching pre-M3 order)', async () => {
  const root = scaffold();
  fs.writeFileSync(path.join(root, 'config', 'orchestrator.json'), '{ not json');
  const findings = await findingsFor(root);
  assert.deepEqual(findings.map((f) => f.id), ['node-version', 'global-config']);
  const config = byId(findings, 'global-config');
  assert.equal(config.status, 'fail');
  assert.match(config.cause, /Invalid JSON/);
});

test('zero projects: fails with a fix that launches the project wizard', async () => {
  const root = scaffold();
  const findings = await findingsFor(root);
  const finding = byId(findings, 'projects-defined');
  assert.equal(finding.status, 'fail');
  assert.ok(finding.fix);
  assert.equal(finding.fix.safe, false);

  let called = null;
  const result = await applyDoctorFix(finding, {
    configManager: new ConfigManager({ rootDir: root }),
    projectWizard: async (args) => { called = args; return { name: 'new-project' }; },
  });
  assert.ok(called);
  assert.deepEqual(result, { ok: true, message: 'Project "new-project" created.' });
});

test('an invalid project surfaces its ConfigError message as cause, and stops the loop for that project only', async () => {
  const root = scaffold({
    projects: { good: (r) => healthyProject(r), bad: { driver: 'mock', workingDirectory: '/no/such/dir' } },
  });
  const findings = await findingsFor(root);
  assert.equal(byId(findings, 'project-valid:good').status, 'ok');
  const bad = byId(findings, 'project-valid:bad');
  assert.equal(bad.status, 'fail');
  assert.match(bad.cause, /workingDirectory/);
  // The good project still gets its OWN engine check despite the bad one.
  assert.equal(byId(findings, 'engine:good').status, 'ok');
});

/** A claude-driver project fixture with a real promptFile (validateProject requires one). */
function claudeProject(workingDirectory, extra = {}) {
  const promptFile = path.join(workingDirectory, 'doctor-test-prompt.md');
  if (!fs.existsSync(promptFile)) fs.writeFileSync(promptFile, '# prompt\n');
  return { driver: 'claude', workingDirectory, promptFile: 'doctor-test-prompt.md', ...extra };
}

test('a claude project missing permissionMode warns, with a safe fix that patches the project file', async () => {
  const root = scaffold({ projects: { proj: (r) => claudeProject(r) } });
  const findings = await findingsFor(root);
  const finding = byId(findings, 'write-permission:proj');
  assert.equal(finding.status, 'warn');
  assert.equal(finding.fix.safe, true);

  const configManager = new ConfigManager({ rootDir: root });
  const result = await applyDoctorFix(finding, { configManager, paths: configManager.getPaths() });
  assert.equal(result.ok, true);
  const written = JSON.parse(fs.readFileSync(path.join(root, 'config', 'projects', 'proj.json'), 'utf8'));
  assert.equal(written.claude.permissionMode, 'acceptEdits');

  // Re-running the check after the fix must no longer warn.
  const after = await findingsFor(root);
  assert.equal(byId(after, 'write-permission:proj'), undefined);
});

test('dangerouslySkipPermissions also satisfies the write-permission check (no warning)', async () => {
  const root = scaffold({
    projects: { proj: (r) => claudeProject(r, { claude: { dangerouslySkipPermissions: true } }) },
  });
  const findings = await findingsFor(root);
  assert.equal(byId(findings, 'write-permission:proj'), undefined);
});

test('telegram enabled but incomplete warns, with a fix that launches the telegram wizard', async () => {
  const root = scaffold({
    orchestrator: { notifications: { telegram: { enabled: true, botToken: '', chatId: '' } } },
    projects: { demo: (r) => healthyProject(r) },
  });
  const findings = await findingsFor(root);
  const finding = byId(findings, 'telegram-incomplete');
  assert.equal(finding.status, 'warn');
  assert.equal(finding.fix.safe, false);

  let called = false;
  const result = await applyDoctorFix(finding, {
    configManager: new ConfigManager({ rootDir: root }),
    telegramWizard: async () => { called = true; return { chatId: '1' }; },
  });
  assert.ok(called);
  assert.equal(result.ok, true);
});

test('email enabled but incomplete warns', async () => {
  const root = scaffold({
    orchestrator: { notifications: { email: { enabled: true, smtp: {} } } },
    projects: { demo: (r) => healthyProject(r) },
  });
  const findings = await findingsFor(root);
  assert.equal(byId(findings, 'email-incomplete').status, 'warn');
});

test('a project with a real remote channel enabled does not warn about "no remote channel"', async () => {
  const root = scaffold({
    orchestrator: { notifications: { telegram: { enabled: true, botToken: 't', chatId: '1' } } },
    projects: { demo: (r) => healthyProject(r) },
  });
  const findings = await findingsFor(root);
  assert.equal(byId(findings, 'remote-channel'), undefined);
});

test('a finding with no fix reports a clear "no automated fix" result', async () => {
  const root = scaffold(); // 0 Node-version-style unfixable case: use node-version finding shape directly
  const fakeFinding = { id: 'node-version', status: 'fail' }; // no .fix
  const result = await applyDoctorFix(fakeFinding, {});
  assert.equal(result.ok, false);
  assert.match(result.message, /no automated fix/i);
});

test('a fix whose apply() throws is reported as a failure, not an uncaught exception', async () => {
  const finding = { id: 'x', fix: { apply: async () => { throw new Error('disk full'); } } };
  const result = await applyDoctorFix(finding, {});
  assert.equal(result.ok, false);
  assert.equal(result.message, 'disk full');
});

// ── Guided recovery: stale/idle sessions ────────────────────────────────

test('a resumable session with no active supervisor is surfaced with both next commands', async () => {
  const root = scaffold({ projects: { demo: (r) => healthyProject(r) } });
  const configManager = new ConfigManager({ rootDir: root });
  const paths = configManager.getPaths();
  fs.mkdirSync(paths.sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(paths.sessionsDir, 'demo.json'), JSON.stringify({
    id: 's1', project: 'demo', driver: 'mock', state: 'waiting-retry', updatedAt: new Date().toISOString(),
  }));
  const findings = await findingsFor(root);
  const finding = byId(findings, 'unfinished-session:demo');
  assert.ok(finding, 'expected an unfinished-session finding');
  assert.equal(finding.status, 'warn');
  assert.match(finding.detail, /ai-orchestrator start demo/);
  assert.match(finding.detail, /ai-orchestrator sessions demo --abandon/);
  assert.ok(!finding.fix); // operator's own call — no auto-fix offered
});

test('a resumable session that IS actively supervised right now is not flagged', async () => {
  const root = scaffold({ projects: { demo: (r) => healthyProject(r) } });
  const configManager = new ConfigManager({ rootDir: root });
  const paths = configManager.getPaths();
  fs.mkdirSync(paths.sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(paths.sessionsDir, 'demo.json'), JSON.stringify({
    id: 's1', project: 'demo', driver: 'mock', state: 'running', updatedAt: new Date().toISOString(),
  }));
  fs.writeFileSync(paths.heartbeatFile, JSON.stringify({ state: 'running', pid: process.pid, project: 'demo' }));
  const findings = await findingsFor(root);
  assert.equal(byId(findings, 'unfinished-session:demo'), undefined);
});

// ── Guided recovery: quarantined corrupt state files ────────────────────

test('quarantined corrupt files are surfaced with a safe delete fix', async () => {
  const root = scaffold({ projects: { demo: (r) => healthyProject(r) } });
  const configManager = new ConfigManager({ rootDir: root });
  const paths = configManager.getPaths();
  fs.mkdirSync(path.join(paths.stateDir, 'tasks'), { recursive: true });
  const corruptFile = path.join(paths.stateDir, 'tasks', 'demo.json.corrupt-12345');
  fs.writeFileSync(corruptFile, 'not json');

  const findings = await findingsFor(root);
  const finding = byId(findings, 'quarantined-state-files');
  assert.ok(finding);
  assert.equal(finding.status, 'warn');
  assert.equal(finding.fix.safe, true);

  const result = await applyDoctorFix(finding, {});
  assert.equal(result.ok, true);
  assert.ok(!fs.existsSync(corruptFile));
});

test('no corrupt files means no finding at all', async () => {
  const root = scaffold({ projects: { demo: (r) => healthyProject(r) } });
  const findings = await findingsFor(root);
  assert.equal(byId(findings, 'quarantined-state-files'), undefined);
});

// ── Scheduled task (Windows-only check, exercised via injected platform/checker) ──

test('scheduled task check only runs on win32, and is skippable/injectable', async () => {
  const root = scaffold({ projects: { demo: (r) => healthyProject(r) } });
  const notWindows = await findingsFor(root, { platform: 'linux' });
  assert.equal(byId(notWindows, 'auto-resume-task'), undefined);

  const installed = await findingsFor(root, {
    platform: 'win32', checkScheduledTask: () => ({ installed: true }),
  });
  assert.equal(byId(installed, 'auto-resume-task').status, 'ok');

  const notInstalled = await findingsFor(root, {
    platform: 'win32', checkScheduledTask: () => ({ installed: false }),
  });
  const finding = byId(notInstalled, 'auto-resume-task');
  assert.equal(finding.status, 'warn');
  assert.equal(finding.fix.safe, true);
  let scriptRan = null;
  const result = await applyDoctorFix(finding, { runSchedulerScript: (script) => { scriptRan = script; } });
  assert.equal(scriptRan, 'install-task.ps1');
  assert.equal(result.ok, true);
});

// ── Renderer ─────────────────────────────────────────────────────────────

/** A no-op colorizer so renderer tests assert on plain text, not ANSI codes. */
function plainChalk() {
  const identity = (s) => s;
  return new Proxy(identity, { get: () => identity });
}

test('renderer prints the right mark per status and includes cause-free detail text', () => {
  const lines = [];
  const originalLog = console.log;
  console.log = (line = '') => lines.push(line);
  try {
    renderDoctorFindings([
      { id: 'a', status: 'ok', label: 'All good', detail: 'yep' },
      { id: 'b', status: 'warn', label: 'Careful', detail: 'hmm' },
      { id: 'c', status: 'fail', label: 'Broken', detail: 'oh no' },
    ], plainChalk());
  } finally {
    console.log = originalLog;
  }
  const body = lines.join('\n');
  assert.match(body, /✔ All good — yep/);
  assert.match(body, /⚠ Careful — hmm/);
  assert.match(body, /✘ Broken — oh no/);
});

test('renderer preserves the special running-instance line format', () => {
  const lines = [];
  const originalLog = console.log;
  console.log = (line = '') => lines.push(line);
  try {
    renderDoctorFindings([{ id: 'running-instance', status: 'ok', label: 'pid 1234' }], plainChalk());
  } finally {
    console.log = originalLog;
  }
  assert.ok(lines.some((l) => l.includes('An orchestrator is currently running (pid 1234).')));
  // Must NOT be rendered with a ✔/⚠/✘ mark like a normal finding.
  assert.ok(!lines.some((l) => /[✔⚠✘].*running/.test(l)));
});

test('a simulated project is warned about, and a real one is not', async () => {
  // Born from the 2026-07-28 incident: a mock-driver project reported a React
  // and Electron calculator complete over an empty workspace. `doctor` is the
  // first place an owner looks when that happens, and it used to be silent.
  const root = scaffold({
    projects: { sandbox: (r) => healthyProject(r), real: (r) => claudeProject(r, { claude: { permissionMode: 'acceptEdits' } }) },
  });
  const findings = await findingsFor(root);

  const sandbox = byId(findings, 'simulated:sandbox');
  assert.equal(sandbox.status, 'warn', 'a fixture project is expected to exist — warn, never fail');
  assert.match(sandbox.impact, /without producing any artifacts/);
  assert.match(sandbox.fix.description, /claude/);
  assert.equal(sandbox.fix.safe, false, 'switching a project to a real engine is the owner\'s call');

  assert.equal(byId(findings, 'simulated:real'), undefined,
    'a real project must produce no simulation finding at all');
});

test('an explicit simulated flag is honoured over the driver id', async () => {
  const root = scaffold({
    projects: {
      pretend: (r) => claudeProject(r, { simulated: true, claude: { permissionMode: 'acceptEdits' } }),
    },
  });
  const findings = await findingsFor(root);
  assert.equal(byId(findings, 'simulated:pretend').status, 'warn');
});
