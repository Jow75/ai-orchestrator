/**
 * verifiers/fileExists.js — Does a file (or directory) exist?
 *
 * Config: `{ type: "file-exists", path: "src/index.js" }`
 * `path` is relative to the project's working directory, or absolute.
 */

import fs from 'node:fs';
import path from 'node:path';

export const type = 'file-exists';

/**
 * @param {{path: string}} config
 * @param {{workingDirectory: string}} context
 * @returns {{passed: boolean, detail: string}}
 */
export function run(config, context) {
  if (!config.path) {
    return { passed: false, detail: 'file-exists verifier is missing "path"' };
  }
  const target = path.isAbsolute(config.path)
    ? config.path
    : path.join(context.workingDirectory, config.path);
  const exists = fs.existsSync(target);
  return {
    passed: exists,
    detail: exists ? `Found ${config.path}` : `Not found: ${config.path}`,
  };
}

export default { type, run };
