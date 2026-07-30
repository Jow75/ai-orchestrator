/**
 * projectInspector.js — Phase 14 M9: detect a project's language, framework,
 * package manager, and build/test commands from files already on disk.
 *
 * Deliberately deterministic and shallow, the same discipline
 * `projectDiscovery.js` uses for finding projects at all: this reads a
 * handful of well-known manifest files (package.json, requirements.txt,
 * pyproject.toml, Cargo.toml) and does simple text/dependency-key matching —
 * no AST parsing, no dependency-tree resolution, no new runtime dependency.
 * A project outside these ecosystems (Go, C/C++, Java, ...) is reported
 * honestly as `language: 'unknown'`, `confidence: 'low'` rather than guessed
 * at with a growing pile of special cases.
 *
 * Every fact this module reports must be traceable to something it actually
 * read — `signals` records what was found so a generated mission prompt can
 * disclose its own basis instead of asserting facts silently.
 */

import fs from 'node:fs';
import path from 'node:path';

const NODE_FRAMEWORKS = [
  { name: 'electron', tags: ['desktop'], test: (deps) => deps.has('electron') },
  { name: 'next.js', tags: ['web', 'frontend'], test: (deps) => deps.has('next') },
  { name: 'react', tags: ['web', 'frontend'], test: (deps) => deps.has('react') },
  { name: 'vue', tags: ['web', 'frontend'], test: (deps) => deps.has('vue') },
  { name: 'nestjs', tags: ['backend', 'api'], test: (deps) => [...deps].some((d) => d.startsWith('@nestjs/')) },
  { name: 'express', tags: ['backend', 'api'], test: (deps) => deps.has('express') },
  { name: 'fastify', tags: ['backend', 'api'], test: (deps) => deps.has('fastify') },
];

const PYTHON_FRAMEWORKS = [
  { name: 'django', tags: ['backend', 'api'], pattern: /\bdjango\b/i },
  { name: 'flask', tags: ['backend', 'api'], pattern: /\bflask\b/i },
  { name: 'fastapi', tags: ['backend', 'api'], pattern: /\bfastapi\b/i },
];

const RUST_FRAMEWORKS = [
  { name: 'actix-web', tags: ['backend', 'api'], pattern: /\bactix-web\b/i },
  { name: 'rocket', tags: ['backend', 'api'], pattern: /\brocket\b/i },
];

const AI_DEPENDENCY_PATTERN = /openai|anthropic|langchain|tensorflow|torch|transformers/i;
const PLACEHOLDER_TEST_SCRIPT = /no test specified/i;

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readTextSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function exists(dir, name) {
  return fs.existsSync(path.join(dir, name));
}

function detectNode(dir, signals) {
  signals.push('found package.json');
  const pkg = readJsonSafe(path.join(dir, 'package.json')) ?? {};
  const deps = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);

  const language = deps.has('typescript') || exists(dir, 'tsconfig.json') ? 'typescript' : 'javascript';
  if (language === 'typescript') signals.push('typescript detected');

  let packageManager = 'npm';
  if (exists(dir, 'pnpm-lock.yaml')) packageManager = 'pnpm';
  else if (exists(dir, 'yarn.lock')) packageManager = 'yarn';
  else if (exists(dir, 'package-lock.json')) packageManager = 'npm';
  signals.push(`package manager: ${packageManager}`);

  const match = NODE_FRAMEWORKS.find((f) => f.test(deps));
  if (match) signals.push(`${match.name} in dependencies`);

  const scripts = pkg.scripts ?? {};
  const buildCommand = scripts.build ? `${packageManager} run build` : null;
  let testCommand = null;
  if (scripts.test && !PLACEHOLDER_TEST_SCRIPT.test(scripts.test)) {
    testCommand = packageManager === 'npm' ? 'npm test' : `${packageManager} test`;
  } else if (scripts.test) {
    signals.push('test script is a placeholder (ignored)');
  }

  const tags = new Set(match?.tags ?? []);
  if (AI_DEPENDENCY_PATTERN.test([...deps].join(' '))) tags.add('ai');

  return {
    language,
    framework: match?.name ?? null,
    packageManager,
    buildCommand,
    testCommand,
    tags: [...tags].sort(),
  };
}

function detectPython(dir, signals) {
  const requirements = readTextSafe(path.join(dir, 'requirements.txt')) ?? '';
  const pyproject = readTextSafe(path.join(dir, 'pyproject.toml')) ?? '';
  signals.push(requirements ? 'found requirements.txt' : 'found pyproject.toml');

  const packageManager = /\[tool\.poetry\]/.test(pyproject) ? 'poetry' : 'pip';
  signals.push(`package manager: ${packageManager}`);

  const combined = `${requirements}\n${pyproject}`;
  const match = PYTHON_FRAMEWORKS.find((f) => f.pattern.test(combined));
  if (match) signals.push(`${match.name} in dependencies`);

  const hasPytest = /\bpytest\b/i.test(combined) || fs.existsSync(path.join(dir, 'tests'));
  if (hasPytest) signals.push('pytest detected');

  const tags = new Set(match?.tags ?? []);
  if (AI_DEPENDENCY_PATTERN.test(combined)) tags.add('ai');

  return {
    language: 'python',
    framework: match?.name ?? null,
    packageManager,
    buildCommand: null,
    testCommand: hasPytest ? 'pytest' : null,
    tags: [...tags].sort(),
  };
}

function detectRust(dir, signals) {
  signals.push('found Cargo.toml');
  const cargoToml = readTextSafe(path.join(dir, 'Cargo.toml')) ?? '';
  const match = RUST_FRAMEWORKS.find((f) => f.pattern.test(cargoToml));
  if (match) signals.push(`${match.name} in dependencies`);

  return {
    language: 'rust',
    framework: match?.name ?? null,
    packageManager: 'cargo',
    buildCommand: 'cargo build',
    testCommand: 'cargo test',
    tags: match?.tags ? [...match.tags].sort() : [],
  };
}

function computeConfidence({ language, framework }) {
  if (language === 'unknown') return 'low';
  return framework ? 'high' : 'medium';
}

/**
 * Inspect a project's working directory and report its detected stack.
 *
 * Deterministic and read-only: no network access, no code execution, no
 * mutation of anything on disk. Every field is either read directly from a
 * manifest file or `null`/`'unknown'` — nothing is invented.
 *
 * @param {string} workingDirectory
 * @returns {{
 *   language: string, framework: string|null, packageManager: string|null,
 *   buildCommand: string|null, testCommand: string|null, tags: string[],
 *   confidence: 'high'|'medium'|'low', signals: string[],
 * }}
 */
export function inspectProject(workingDirectory) {
  const signals = [];
  let detected;

  if (exists(workingDirectory, 'package.json')) {
    detected = detectNode(workingDirectory, signals);
  } else if (exists(workingDirectory, 'requirements.txt') || exists(workingDirectory, 'pyproject.toml')) {
    detected = detectPython(workingDirectory, signals);
  } else if (exists(workingDirectory, 'Cargo.toml')) {
    detected = detectRust(workingDirectory, signals);
  } else {
    signals.push('no recognized manifest found');
    detected = {
      language: 'unknown', framework: null, packageManager: null,
      buildCommand: null, testCommand: null, tags: [],
    };
  }

  return { ...detected, confidence: computeConfidence(detected), signals };
}

/**
 * Render the starter `promptFile` content for an auto-detected project.
 * Follows the docs/QUICKSTART.md contract: the work, then an explicit
 * instruction to output the project's actual completion marker — never a
 * hardcoded string, since `mission.completionMarker` is per-project
 * overridable.
 *
 * @param {ReturnType<typeof inspectProject>} detected
 * @param {{completionMarker: string}} options
 * @returns {string}
 */
export function buildAutoMissionPrompt(detected, { completionMarker }) {
  const {
    language, framework, packageManager, buildCommand, testCommand, tags, signals,
  } = detected;
  const subject = tags[0] ?? (framework || language);

  const lines = [
    '# Mission',
    '',
    `Build and maintain this ${subject} project.`,
    `Detected stack: ${language}${framework ? ` / ${framework}` : ''}. Package manager: ${packageManager ?? 'unknown'}.`,
  ];
  const commandBits = [
    buildCommand ? `Build with \`${buildCommand}\`.` : null,
    testCommand ? `Test with \`${testCommand}\`.` : null,
  ].filter(Boolean);
  if (commandBits.length) lines.push(commandBits.join(' '));
  lines.push('Follow the existing code style and structure. Read the README first if one exists.');
  lines.push('');
  lines.push(
    `This context was auto-detected on ${new Date().toISOString().slice(0, 10)} from files on disk — `
    + 'verify before relying on it for anything safety-critical.'
  );
  lines.push(`Detected because: ${signals.join('; ') || 'no manifest found'}.`);
  lines.push('');
  lines.push('When — and only when — the entire mission is finished, output the exact text');
  lines.push('on its own line:');
  lines.push('');
  lines.push(completionMarker);
  lines.push('');
  return lines.join('\n');
}

export default { inspectProject, buildAutoMissionPrompt };
