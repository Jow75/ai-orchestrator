/**
 * verifiers/filesChanged.js — Were specific files (or a directory) actually
 * created or modified this run?
 *
 * Config: `{ type: "files-changed", paths: ["src/index.js", "src/utils/"] }`
 * Entries ending in `/` match any created/modified file under that
 * directory; other entries must match a changed file exactly.
 *
 * Deliberately reuses the progress engine's already-computed change facts
 * (`src/progress/progressEngine.js`) instead of invoking git a second time —
 * one source of truth for "what changed this run".
 */

export const type = 'files-changed';

/**
 * @param {{paths: string[]}} config
 * @param {{changes: {created: string[], modified: string[]}|null}} context
 * @returns {{passed: boolean, detail: string}}
 */
export function run(config, context) {
  if (!config.paths?.length) {
    return { passed: false, detail: 'files-changed verifier is missing "paths"' };
  }
  if (!context.changes) {
    return {
      passed: false,
      detail: 'No change data available yet (first run of the mission has no prior snapshot)',
    };
  }

  const changed = [...context.changes.created, ...context.changes.modified];
  const missing = config.paths.filter((required) => !matchesAny(required, changed));

  return {
    passed: missing.length === 0,
    detail: missing.length === 0
      ? `All required paths changed: ${config.paths.join(', ')}`
      : `Not changed: ${missing.join(', ')}`,
  };
}

function matchesAny(required, changedFiles) {
  if (required.endsWith('/')) {
    return changedFiles.some((file) => file.startsWith(required));
  }
  return changedFiles.includes(required);
}

export default { type, run };
