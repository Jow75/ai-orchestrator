/**
 * verifierRegistry.js — Verification Engine (core).
 *
 * The project's guiding principle, stated plainly in the master prompt:
 * **Claude does not determine success. Verification determines success.**
 * A task is complete only when its verifiers pass — never merely because
 * the agent said so or a marker string appeared.
 *
 * P2 shipped the core registry (`file-exists`, `command`,
 * `output-contains`, `files-changed`). Phase P6 extends the SAME registry
 * — not a rewrite — with `json-schema`, `lint`, and `dependency`; this
 * module and its `runVerifiers()` contract do not change shape as that
 * happens, and neither does anything that calls it.
 *
 * Deliberately NOT plugin-extensible in this phase: verifier types are
 * eagerly validated at config-load time (see configManager.js), which
 * requires a closed, known set. If verifier plugins become a real need
 * later, that is a considered extension, not a default.
 */

import fileExists from './verifiers/fileExists.js';
import command from './verifiers/command.js';
import outputContains from './verifiers/outputContains.js';
import filesChanged from './verifiers/filesChanged.js';
import jsonSchema from './verifiers/jsonSchema.js';
import lint from './verifiers/lint.js';
import dependency from './verifiers/dependency.js';

/** type string -> verifier implementation ({ type, run(config, context) }). */
const VERIFIERS = new Map(
  [fileExists, command, outputContains, filesChanged, jsonSchema, lint, dependency]
    .map((v) => [v.type, v])
);

/** All known verifier type strings, for validation error messages. */
export function listVerifierTypes() {
  return [...VERIFIERS.keys()].sort();
}

/** Is `type` a registered verifier? */
export function isKnownVerifierType(type) {
  return VERIFIERS.has(type);
}

/**
 * Run a list of verifier configs against a run's context.
 *
 * Each verifier is isolated: one throwing or misconfigured verifier fails
 * only itself (`passed: false`), never the whole verification pass or the
 * orchestrator — consistent with the platform's "observability/edges never
 * bring down supervision" rule.
 *
 * @param {{type: string, [key: string]: *}[]} verifiers - Verifier configs.
 * @param {object} context - Whatever the verifiers need:
 *   `workingDirectory`, `resultText`, `outputTail`,
 *   `changes` (from `progressEngine.analyze()`, or null).
 * @returns {{passed: boolean, results: {type: string, passed: boolean, detail: string}[]}}
 */
export function runVerifiers(verifiers, context) {
  const results = (verifiers ?? []).map((config) => {
    const impl = VERIFIERS.get(config.type);
    if (!impl) {
      return {
        type: config.type,
        passed: false,
        detail: `Unknown verifier type "${config.type}". Known types: ${listVerifierTypes().join(', ')}.`,
      };
    }
    try {
      const { passed, detail } = impl.run(config, context);
      return { type: config.type, passed, detail };
    } catch (error) {
      return { type: config.type, passed: false, detail: `Verifier threw: ${error.message}` };
    }
  });

  return { passed: results.every((r) => r.passed), results };
}

export default { listVerifierTypes, isKnownVerifierType, runVerifiers };
