/**
 * Unit tests for operator/projectLifecycleOps.js (Phase 13 M3): archive,
 * restore, hide, unhide, forget, and the classification migration proposal.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ConfigManager from '../src/config/configManager.js';
import {
  archive, restore, hide, unhide, forget, classifyProposal,
} from '../src/operator/projectLifecycleOps.js';
import { ROOT_DIR } from '../src/infra/paths.js';

function scaffold(projects = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-lifecycle-'));
  fs.mkdirSync(path.join(root, 'config', 'projects'), { recursive: true });
  for (const [name, definition] of Object.entries(projects)) {
    fs.writeFileSync(
      path.join(root, 'config', 'projects', `${name}.json`),
      JSON.stringify(definition)
    );
  }
  const config = new ConfigManager({ rootDir: root });
  config.load();
  return config;
}

test('archive sets classification to archived', () => {
  const config = scaffold({ p: { workingDirectory: '/w', driver: 'claude' } });
  archive(config, 'p');
  assert.equal(config.getProjectFileContents('p').classification, 'archived');
});

test('hide sets classification to hidden, and restore/unhide both return to development', () => {
  const config = scaffold({ p: { workingDirectory: '/w', driver: 'claude' } });
  hide(config, 'p');
  assert.equal(config.getProjectFileContents('p').classification, 'hidden');
  unhide(config, 'p');
  assert.equal(config.getProjectFileContents('p').classification, 'development');

  archive(config, 'p');
  restore(config, 'p');
  assert.equal(config.getProjectFileContents('p').classification, 'development');
});

test('forget removes the project file and never touches its real folder', () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-work-'));
  fs.writeFileSync(path.join(workDir, 'real-code.js'), 'still here');
  const config = scaffold({ p: { workingDirectory: workDir, driver: 'claude' } });

  forget(config, 'p');

  assert.equal(config.listProjects().length, 0);
  assert.ok(fs.existsSync(path.join(workDir, 'real-code.js')));
});

// ── classifyProposal ─────────────────────────────────────────────────────

test('classifyProposal never proposes anything for an already-classified project', () => {
  const config = scaffold({
    p: { workingDirectory: '/w', driver: 'claude', classification: 'production' },
  });
  assert.deepEqual(classifyProposal(config), []);
});

test('classifyProposal proposes "demo" for a simulated (mock-driver) project', () => {
  const config = scaffold({ p: { workingDirectory: '/w', driver: 'mock', simulated: true } });
  const [proposal] = classifyProposal(config);
  assert.equal(proposal.proposed, 'demo');
  assert.match(proposal.reason, /simulated/);
});

test('classifyProposal proposes "demo" for a project living inside AI-Orchestrator\'s own install', () => {
  const insideDir = path.join(ROOT_DIR, 'examples', 'demo-project');
  const config = scaffold({ p: { workingDirectory: insideDir, driver: 'claude' } });
  const [proposal] = classifyProposal(config);
  assert.equal(proposal.proposed, 'demo');
  assert.match(proposal.reason, /own installation/);
});

test('classifyProposal proposes "validation" when the comment/description says so', () => {
  const config = scaffold({
    p: {
      workingDirectory: '/w', driver: 'claude',
      $comment: 'Phase 10.5 operational-validation demo, tiny on purpose.',
    },
  });
  const [proposal] = classifyProposal(config);
  assert.equal(proposal.proposed, 'validation');
});

test('classifyProposal falls back to "development" with no strong signal', () => {
  const config = scaffold({ p: { workingDirectory: '/w', driver: 'claude' } });
  const [proposal] = classifyProposal(config);
  assert.equal(proposal.proposed, 'development');
});

test('classifyProposal reproduces the real 6-project migration table', () => {
  const config = scaffold({
    'THE FINISHER': {
      workingDirectory: '/w/finisher', driver: 'claude',
      claude: { $comment: 'Replace promptFile with a real mission prompt before the first serious run.' },
    },
    'calculator-proof': {
      workingDirectory: '/w/calc', driver: 'claude',
      $comment: 'REAL project — the control... Deliberately the exact opposite of validation-sandbox.',
      description: 'Calculator Proof — real engine, real files. Control for the simulated-mission investigation.',
    },
    example: { workingDirectory: path.join(ROOT_DIR, 'examples', 'demo-project'), driver: 'claude' },
    'phone-demo': {
      workingDirectory: '/w/phone', driver: 'claude',
      $comment: 'Phase 10.5 phone-workflow validation (2026-07-13).',
    },
    'validation-demo': {
      workingDirectory: '/w/vdemo', driver: 'claude',
      $comment: 'Phase 10.5 operational-validation demo (2026-07-13).',
    },
    'validation-sandbox': {
      workingDirectory: '/w/sandbox', driver: 'mock', simulated: true,
      description: 'Validation Sandbox — simulated. Exercises the approval flow; never writes files.',
    },
  });

  const byName = Object.fromEntries(classifyProposal(config).map((p) => [p.name, p.proposed]));
  assert.deepEqual(byName, {
    'THE FINISHER': 'development',
    'calculator-proof': 'validation',
    example: 'demo',
    'phone-demo': 'validation',
    'validation-demo': 'validation',
    'validation-sandbox': 'demo',
  });
});
