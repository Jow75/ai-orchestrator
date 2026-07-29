/**
 * configManager.js — Configuration Manager.
 *
 * All behaviour is driven by JSON files the user edits; no code changes are
 * required for normal operation.
 *
 *   config/orchestrator.json      Global settings (merged over defaults)
 *   config/projects/<name>.json   One file per supervised project
 *
 * Responsibilities:
 *  - Load + deep-merge defaults and user overrides.
 *  - Validate project definitions with actionable error messages.
 *  - Expose dotted-path lookups (`config.get('rateLimit.maxWaitMs')`).
 */

import fs from 'node:fs';
import path from 'node:path';
import { ORCHESTRATOR_DEFAULTS, PROJECT_DEFAULTS } from './defaults.js';
import { resolvePaths } from '../infra/paths.js';
import { isLegacyMission, normalizeAndValidateTasks } from '../mission/missionPlan.js';
import { PROJECT_CLASSIFICATIONS, isKnownClassification } from './projectClassification.js';

/** Error type thrown for any user-fixable configuration problem. */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Deep-clone plain objects AND arrays (scalars/functions/etc. pass through
 * by reference — nothing to alias-protect there). Arrays need cloning too,
 * not just objects: `deepMerge`'s MERGE semantics already treat an array as
 * atomic (replaced wholesale, never element-merged), but an untouched array
 * — e.g. `operator.projectRoots` when nothing overrides it — would otherwise
 * stay the exact same array instance as the one inside the shared,
 * module-level defaults, and an in-place array mutation (`.push()`, not
 * just a whole-array reassignment) would corrupt it same as an object would.
 */
function cloneDeep(value) {
  if (Array.isArray(value)) return value.map(cloneDeep);
  if (value === null || typeof value !== 'object') return value;
  const clone = {};
  for (const [key, nested] of Object.entries(value)) clone[key] = cloneDeep(nested);
  return clone;
}

/**
 * Recursively merge `source` over `target` without mutating either.
 *
 * Every nested plain object in the result is a fresh clone — including
 * branches `source` never touches — NOT merely a shallow `{...target}`
 * spread. That guarantee matters beyond "don't mutate the inputs": `load()`
 * calls this as `deepMerge(ORCHESTRATOR_DEFAULTS, overrides)`, and a branch
 * `overrides` doesn't touch would otherwise be the EXACT SAME object as the
 * one living inside the shared, module-level `ORCHESTRATOR_DEFAULTS` — so a
 * later in-place mutation of the live config (Phase 13 M4's
 * `LiveConfigLayer`, the first caller to ever do this) would silently
 * corrupt that singleton for every other `ConfigManager` in the same
 * process. Cloning here, once, is cheaper and far safer than requiring
 * every future mutator to know that landmine exists.
 */
export function deepMerge(target, source) {
  const result = {};
  for (const [key, value] of Object.entries(target ?? {})) {
    result[key] = cloneDeep(value);
  }
  for (const [key, value] of Object.entries(source ?? {})) {
    const existing = result[key];
    if (
      value && typeof value === 'object' && !Array.isArray(value) &&
      existing && typeof existing === 'object' && !Array.isArray(existing)
    ) {
      result[key] = deepMerge(existing, value);
    } else if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

/** Read and parse a JSON file, converting syntax errors into ConfigError. */
function readJsonFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new ConfigError(`Cannot read config file ${filePath}: ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(
      `Invalid JSON in ${filePath}: ${error.message}. ` +
      'Fix the syntax (a JSON linter or editor will pinpoint the problem).'
    );
  }
}

export class ConfigManager {
  /**
   * @param {object} [options]
   * @param {string} [options.rootDir] - Override the installation root (tests).
   */
  constructor(options = {}) {
    this.rootDir = options.rootDir;
    this.config = null;
    this.paths = null;
  }

  /** Load global configuration. Idempotent; call again to reload. */
  load() {
    // Bootstrap paths with defaults first so we can find orchestrator.json,
    // then re-resolve in case the user overrode path locations in it.
    let paths = resolvePaths(this.rootDir ? { root: this.rootDir } : {});
    const globalFile = path.join(paths.configDir, 'orchestrator.json');

    let overrides = {};
    if (fs.existsSync(globalFile)) {
      overrides = readJsonFile(globalFile);
    }

    // config/local.json — machine-local overrides merged over
    // orchestrator.json. Git-ignored since P0, so credentials (SMTP
    // passwords, bot tokens) belong here, never in the tracked file.
    const localFile = path.join(paths.configDir, 'local.json');
    if (fs.existsSync(localFile)) {
      overrides = deepMerge(overrides, readJsonFile(localFile));
    }

    this.config = deepMerge(ORCHESTRATOR_DEFAULTS, overrides);
    paths = resolvePaths({
      ...(this.rootDir ? { root: this.rootDir } : {}),
      ...this.config.paths,
    });
    this.paths = paths;
    return this.config;
  }

  /** Dotted-path lookup, e.g. get('api.port'). */
  get(key, fallback = undefined) {
    if (!this.config) this.load();
    let value = this.config;
    for (const part of key.split('.')) {
      if (value === null || value === undefined) return fallback;
      value = value[part];
    }
    return value === undefined ? fallback : value;
  }

  /** The full merged global configuration object. */
  getAll() {
    if (!this.config) this.load();
    return this.config;
  }

  /** Resolved absolute runtime paths (logs, state, status.json, ...). */
  getPaths() {
    if (!this.paths) this.load();
    return this.paths;
  }

  /** List the names of all defined projects (JSON files in projectsDir). */
  listProjects() {
    const dir = this.getPaths().projectsDir;
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.basename(f, '.json'))
      .sort();
  }

  /**
   * Load and validate a project definition.
   *
   * @param {string} name - Project name (file name without .json).
   * @returns {object} Fully merged, validated project configuration.
   * @throws {ConfigError} With a message that tells the user exactly what to fix.
   */
  getProject(name) {
    if (!name) {
      throw new ConfigError(
        'No project specified. Pass a project name or set "defaultProject" in config/orchestrator.json.'
      );
    }

    const file = path.join(this.getPaths().projectsDir, `${name}.json`);
    if (!fs.existsSync(file)) {
      const available = this.listProjects();
      throw new ConfigError(
        `Project "${name}" not found (expected ${file}). ` +
        (available.length
          ? `Available projects: ${available.join(', ')}.`
          : 'No projects defined yet — create one with "ai-orchestrator projects add".')
      );
    }

    const project = deepMerge(PROJECT_DEFAULTS, readJsonFile(file));
    project.name = name;
    this.validateProject(project, file);
    return project;
  }

  /**
   * Load a project definition WITHOUT validating it — merged defaults +
   * file contents only. `validateProject()` collapses every problem into one
   * thrown error, which is right for "can this mission run?" but wrong for a
   * caller (ProjectRegistry, Phase 13 M2) that needs to distinguish "the
   * workingDirectory itself is gone" (a specific, more actionable situation)
   * from "some other validation problem."
   *
   * @param {string} name
   * @returns {object|null} The raw merged definition, or null if the file is
   *   missing or isn't valid JSON — callers fall back to getProject()'s error
   *   message for that case.
   */
  getRawProject(name) {
    if (!name) return null;
    const file = path.join(this.getPaths().projectsDir, `${name}.json`);
    if (!fs.existsSync(file)) return null;
    try {
      const project = deepMerge(PROJECT_DEFAULTS, readJsonFile(file));
      project.name = name;
      return project;
    } catch {
      return null;
    }
  }

  /**
   * Read a project's definition file EXACTLY as written on disk — no
   * `PROJECT_DEFAULTS` merged in at all (unlike `getRawProject()`, which
   * merges defaults but skips validation). Needed wherever "did the owner
   * explicitly set this" matters: `classification` now has a default
   * (`'development'`), so a defaults-merged read would make every project
   * look already classified, which is exactly wrong for Phase 13 M3's
   * migration proposal (`classifyProposal()` in `operator/projectLifecycleOps.js`).
   *
   * @param {string} name
   * @returns {object|null} The raw file contents, or null if missing/invalid.
   */
  getProjectFileContents(name) {
    if (!name) return null;
    const file = path.join(this.getPaths().projectsDir, `${name}.json`);
    if (!fs.existsSync(file)) return null;
    try {
      return readJsonFile(file);
    } catch {
      return null;
    }
  }

  /** Validate a merged project config. Throws ConfigError on problems. */
  validateProject(project, file) {
    const problems = [];

    if (!project.workingDirectory) {
      problems.push('"workingDirectory" is required (the folder the AI agent works in).');
    } else if (!fs.existsSync(project.workingDirectory)) {
      problems.push(`"workingDirectory" does not exist: ${project.workingDirectory}`);
    }

    // A mission-mode project (non-empty "tasks") supplies its own per-task
    // prompts and does not need a single top-level promptFile.
    const missionMode = !isLegacyMission(project);
    if (!missionMode) {
      if (!project.promptFile) {
        problems.push('"promptFile" is required (the mission prompt for fresh sessions).');
      } else {
        const promptPath = path.isAbsolute(project.promptFile)
          ? project.promptFile
          : path.join(project.workingDirectory ?? '', project.promptFile);
        if (!fs.existsSync(promptPath)) {
          problems.push(`"promptFile" not found: ${promptPath}`);
        } else {
          project.resolvedPromptFile = promptPath;
        }
      }
    }

    if (typeof project.driver !== 'string' || !project.driver) {
      problems.push('"driver" must be a driver id string (e.g. "claude").');
    }

    if (missionMode) {
      const { tasks, problems: taskProblems } = normalizeAndValidateTasks(project);
      project.tasks = tasks; // replace raw entries with normalized, resolved ones
      problems.push(...taskProblems);
    }

    if (problems.length) {
      throw new ConfigError(
        `Project config ${file} has problems:\n - ${problems.join('\n - ')}`
      );
    }
  }

  /**
   * Merge a patch into config/local.json (the machine-local, git-ignored
   * overlay that `load()` deep-merges over orchestrator.json). Existing keys
   * are preserved; only the supplied paths are added or overwritten. This is
   * how the Phase 11 onboarding wizards persist credentials and channel
   * settings without ever touching the tracked orchestrator.json.
   *
   * @param {object} patch - Partial config to deep-merge into local.json.
   * @returns {string} The path of config/local.json.
   */
  writeLocalConfig(patch) {
    const dir = this.getPaths().configDir;
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'local.json');
    const existing = fs.existsSync(file) ? readJsonFile(file) : {};
    const merged = deepMerge(existing, patch);
    fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    return file;
  }

  /**
   * Persist a new project definition (used by `projects add`).
   *
   * @param {string} name - Project name.
   * @param {object} definition - Project settings to write.
   * @returns {string} The path of the created file.
   */
  saveProject(name, definition) {
    const dir = this.getPaths().projectsDir;
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.json`);
    if (fs.existsSync(file)) {
      throw new ConfigError(`Project "${name}" already exists at ${file}.`);
    }
    fs.writeFileSync(file, `${JSON.stringify(definition, null, 2)}\n`, 'utf8');
    return file;
  }

  /**
   * Merge `patch` into an existing project's RAW on-disk definition and
   * persist it (Phase 13 M3 — `/archive`, `/hide`, `/restore`, `/unhide`,
   * the classification migration).
   *
   * Reads and writes the raw file — never the `PROJECT_DEFAULTS`-merged
   * object — so applying a patch can never bake defaults permanently into a
   * file that previously relied on them implicitly (the same reasoning
   * `saveProject()` already follows by writing exactly what it's given).
   *
   * Deliberately does NOT run the full `validateProject()` a mission needs
   * to actually run (driver/workingDirectory/promptFile-or-tasks) — a
   * project can be legitimately incomplete (Phase 13 M2's freshly-imported,
   * no-mission-yet projects are exactly this) and lifecycle operations must
   * still work on it; requiring mission-readiness here would make it
   * impossible to archive or hide the very projects most likely to need it.
   * The one thing checked is that a `classification`, if the patch touches
   * it, is a real one — a typo must not silently create a seventh category.
   *
   * @param {string} name
   * @param {object} patch - Deep-merged over the existing raw definition.
   * @returns {object} The new raw definition that was written.
   * @throws {ConfigError} If the project doesn't exist, or the patch sets an
   *   unknown "classification".
   */
  updateProject(name, patch) {
    const file = path.join(this.getPaths().projectsDir, `${name}.json`);
    if (!fs.existsSync(file)) {
      throw new ConfigError(`Project "${name}" not found (expected ${file}).`);
    }
    const raw = readJsonFile(file);
    const merged = deepMerge(raw, patch);
    if (merged.classification !== undefined && !isKnownClassification(merged.classification)) {
      throw new ConfigError(
        `"classification" must be one of: ${PROJECT_CLASSIFICATIONS.join(', ')} (got "${merged.classification}").`
      );
    }
    fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    return merged;
  }

  /**
   * Remove a project's definition file (Phase 13 M3 — `/forget`).
   *
   * Registry-only, by design (see docs/PHASE_13_PLAN.md M3): this NEVER
   * touches the project's actual files on disk. Deleting real code is a
   * deliberate non-goal this system does not implement at all, on any path.
   *
   * @param {string} name
   * @throws {ConfigError} If the project doesn't exist.
   */
  deleteProject(name) {
    const file = path.join(this.getPaths().projectsDir, `${name}.json`);
    if (!fs.existsSync(file)) {
      throw new ConfigError(`Project "${name}" not found (expected ${file}).`);
    }
    fs.rmSync(file);
  }
}

export default ConfigManager;
