/**
 * verifiers/jsonSchema.js — Phase P6: does a JSON file conform to a schema?
 *
 * Config: `{ type: "json-schema", path: "config.json", schema: {...} }` or
 * `{ type: "json-schema", path: "config.json", schemaFile: "schemas/config.schema.json" }`
 * (`schemaFile` is relative to the project's `workingDirectory`, or absolute).
 *
 * Deliberately a small, dependency-free validator rather than a full
 * JSON Schema draft implementation (no ajv/etc. — this codebase keeps its
 * dependency footprint to what's load-bearing). Supported keywords:
 * `type` (string or array of strings), `required`, `properties`,
 * `items`, `enum`, `minimum`/`maximum`, `minLength`/`maxLength`, `pattern`.
 * NOT supported: `$ref`, `oneOf`/`anyOf`/`allOf`, `additionalProperties`,
 * format validators, or draft version negotiation. This is a documented,
 * bounded subset — good enough to catch "the agent produced malformed
 * config" without pulling in a schema-validation dependency for it.
 */

import fs from 'node:fs';
import path from 'node:path';

export const type = 'json-schema';

/** Cap how many validation errors are quoted in the failure detail. */
const MAX_ERRORS_SHOWN = 5;

/**
 * @param {{path: string, schema?: object, schemaFile?: string}} config
 * @param {{workingDirectory: string}} context
 * @returns {{passed: boolean, detail: string}}
 */
export function run(config, context) {
  if (!config.path) {
    return { passed: false, detail: 'json-schema verifier is missing "path"' };
  }
  if (!config.schema && !config.schemaFile) {
    return { passed: false, detail: 'json-schema verifier needs either "schema" or "schemaFile"' };
  }

  const target = resolve(config.path, context.workingDirectory);
  if (!fs.existsSync(target)) {
    return { passed: false, detail: `Not found: ${config.path}` };
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (error) {
    return { passed: false, detail: `${config.path} is not valid JSON: ${error.message}` };
  }

  let schema = config.schema;
  if (!schema) {
    const schemaTarget = resolve(config.schemaFile, context.workingDirectory);
    if (!fs.existsSync(schemaTarget)) {
      return { passed: false, detail: `Schema file not found: ${config.schemaFile}` };
    }
    try {
      schema = JSON.parse(fs.readFileSync(schemaTarget, 'utf8'));
    } catch (error) {
      return { passed: false, detail: `${config.schemaFile} is not valid JSON: ${error.message}` };
    }
  }

  const errors = validate(data, schema, '$');
  if (!errors.length) {
    return { passed: true, detail: `${config.path} conforms to the schema` };
  }
  const shown = errors.slice(0, MAX_ERRORS_SHOWN);
  const more = errors.length > shown.length ? ` (+${errors.length - shown.length} more)` : '';
  return { passed: false, detail: `${config.path} does not conform to the schema: ${shown.join('; ')}${more}` };
}

function resolve(target, workingDirectory) {
  return path.isAbsolute(target) ? target : path.join(workingDirectory, target);
}

/** Recursively validate `value` against `schema`, collecting error strings. */
function validate(value, schema, at) {
  const errors = [];

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      errors.push(`at "${at}": expected ${types.join(' or ')}, got ${actualType(value)}`);
      return errors; // further checks would be meaningless against the wrong type
    }
  }

  if (schema.enum && !schema.enum.some((allowed) => deepEqual(allowed, value))) {
    errors.push(`at "${at}": expected one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`);
  }

  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) {
      errors.push(`at "${at}": length ${value.length} is below minLength ${schema.minLength}`);
    }
    if (schema.maxLength != null && value.length > schema.maxLength) {
      errors.push(`at "${at}": length ${value.length} exceeds maxLength ${schema.maxLength}`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`at "${at}": does not match pattern ${schema.pattern}`);
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) {
      errors.push(`at "${at}": ${value} is below minimum ${schema.minimum}`);
    }
    if (schema.maximum != null && value > schema.maximum) {
      errors.push(`at "${at}": ${value} exceeds maximum ${schema.maximum}`);
    }
  }

  if (schema.properties && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const required of schema.required ?? []) {
      if (!(required in value)) {
        errors.push(`at "${at}": missing required property "${required}"`);
      }
    }
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (key in value) {
        errors.push(...validate(value[key], propSchema, `${at}.${key}`));
      }
    }
  }

  if (schema.items && Array.isArray(value)) {
    value.forEach((item, index) => {
      errors.push(...validate(item, schema.items, `${at}[${index}]`));
    });
  }

  return errors;
}

function matchesType(value, expected) {
  switch (expected) {
    case 'array': return Array.isArray(value);
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'null': return value === null;
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    default: return typeof value === expected;
  }
}

function actualType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export default { type, run };
