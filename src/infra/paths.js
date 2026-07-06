/**
 * paths.js — Central path resolution for AI-Orchestrator.
 *
 * Every module that touches the filesystem gets its locations from here,
 * so relocating runtime data is a one-line config change, never a code hunt.
 *
 * Layout (relative to the installation root by default):
 *   config/                  User-editable configuration (JSON only)
 *   config/projects/         One JSON file per supervised project
 *   logs/                    Rotated log files
 *   state/                   Machine-owned runtime state (never hand-edited)
 *   state/sessions/          One JSON record per supervised session
 *   status.json              Live status snapshot (read-only for humans/dashboards)
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Absolute path of the repository/installation root. */
export const ROOT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..'
);

/**
 * Resolve all runtime paths, honouring optional overrides from configuration.
 *
 * @param {object} [overrides] - Optional path overrides (from config `paths`).
 * @returns {object} Fully resolved absolute paths.
 */
export function resolvePaths(overrides = {}) {
  const root = overrides.root ? path.resolve(overrides.root) : ROOT_DIR;

  const resolved = {
    root,
    configDir: path.resolve(root, overrides.configDir ?? 'config'),
    projectsDir: path.resolve(root, overrides.projectsDir ?? 'config/projects'),
    logsDir: path.resolve(root, overrides.logsDir ?? 'logs'),
    stateDir: path.resolve(root, overrides.stateDir ?? 'state'),
    statusFile: path.resolve(root, overrides.statusFile ?? 'status.json'),
    pluginsDir: path.resolve(root, overrides.pluginsDir ?? 'plugins'),
  };

  resolved.sessionsDir = path.join(resolved.stateDir, 'sessions');
  resolved.ledgerDir = path.join(resolved.stateDir, 'ledger');
  resolved.timelineDir = path.join(resolved.stateDir, 'timeline');
  resolved.progressDir = path.join(resolved.stateDir, 'progress');
  resolved.tasksDir = path.join(resolved.stateDir, 'tasks');
  resolved.diagnosticsDir = path.join(resolved.stateDir, 'diagnostics');
  resolved.memoryDir = path.join(resolved.stateDir, 'memory');
  resolved.apiTokenFile = path.join(resolved.stateDir, 'api-token.txt');
  resolved.heartbeatFile = path.join(resolved.stateDir, 'heartbeat.json');
  resolved.runtimeHistoryFile = path.join(resolved.stateDir, 'runtime_history.json');

  return resolved;
}

/**
 * Create the writable runtime directories if they do not exist yet.
 * Safe to call repeatedly (idempotent).
 *
 * @param {object} paths - Result of {@link resolvePaths}.
 */
export function ensureRuntimeDirs(paths) {
  for (const dir of [
    paths.logsDir,
    paths.stateDir,
    paths.sessionsDir,
    paths.ledgerDir,
    paths.timelineDir,
    paths.progressDir,
    paths.tasksDir,
    paths.diagnosticsDir,
    paths.memoryDir,
    paths.pluginsDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export default { ROOT_DIR, resolvePaths, ensureRuntimeDirs };
