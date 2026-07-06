/**
 * verifiers/dependency.js — Phase P6: was a package actually added as a
 * dependency, and installed?
 *
 * Config: `{ type: "dependency", name: "express" }` — checks the project's
 * `package.json` (`workingDirectory/package.json`, or `packageFile` if
 * given) declares `name` under `dependencies`, `devDependencies`, or
 * `peerDependencies` (narrow it with `where: "dependencies"` etc.), and
 * — unless `installed: false` — that `node_modules/<name>` actually
 * exists. Catches the common half-finished case: the agent edited
 * package.json but never ran `npm install`.
 */

import fs from 'node:fs';
import path from 'node:path';

export const type = 'dependency';

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies'];

/**
 * @param {{name: string, where?: string, installed?: boolean, packageFile?: string}} config
 * @param {{workingDirectory: string}} context
 * @returns {{passed: boolean, detail: string}}
 */
export function run(config, context) {
  if (!config.name) {
    return { passed: false, detail: 'dependency verifier is missing "name"' };
  }

  const packageFile = config.packageFile
    ? resolve(config.packageFile, context.workingDirectory)
    : path.join(context.workingDirectory, 'package.json');
  if (!fs.existsSync(packageFile)) {
    return { passed: false, detail: `No package.json found at ${packageFile}` };
  }

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  } catch (error) {
    return { passed: false, detail: `package.json is not valid JSON: ${error.message}` };
  }

  const fields = config.where ? [config.where] : DEPENDENCY_FIELDS;
  const declaredIn = fields.find((field) => pkg[field]?.[config.name]);
  if (!declaredIn) {
    return {
      passed: false,
      detail: `"${config.name}" is not declared in ${fields.join('/')} of package.json`,
    };
  }

  if (config.installed === false) {
    return { passed: true, detail: `"${config.name}" is declared in ${declaredIn}` };
  }

  const installedPath = path.join(context.workingDirectory, 'node_modules', config.name);
  if (!fs.existsSync(installedPath)) {
    return {
      passed: false,
      detail: `"${config.name}" is declared in ${declaredIn} but not installed ` +
        `(node_modules/${config.name} not found) — run npm install`,
    };
  }

  return { passed: true, detail: `"${config.name}" is declared in ${declaredIn} and installed` };
}

function resolve(target, workingDirectory) {
  return path.isAbsolute(target) ? target : path.join(workingDirectory, target);
}

export default { type, run };
