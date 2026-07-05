/**
 * verifiers/outputContains.js — Does the agent's final output mention
 * something specific?
 *
 * Config: `{ type: "output-contains", pattern: "all tests passed" }` (plain
 * substring, case-sensitive) or `{ type: "output-contains", pattern: "\\d+
 * passed", regex: true, flags: "i" }`.
 *
 * This is the same class of signal as the mission completion marker, scoped
 * to a single task — useful for lightweight tasks that don't warrant a file
 * or command check.
 */

export const type = 'output-contains';

/**
 * @param {{pattern: string, regex?: boolean, flags?: string}} config
 * @param {{resultText: string, outputTail: string}} context
 * @returns {{passed: boolean, detail: string}}
 */
export function run(config, context) {
  if (!config.pattern) {
    return { passed: false, detail: 'output-contains verifier is missing "pattern"' };
  }
  const text = `${context.resultText ?? ''}\n${context.outputTail ?? ''}`;

  let passed;
  try {
    passed = config.regex
      ? new RegExp(config.pattern, config.flags ?? '').test(text)
      : text.includes(config.pattern);
  } catch (error) {
    return { passed: false, detail: `Invalid regex pattern: ${error.message}` };
  }

  return {
    passed,
    detail: passed
      ? `Output matched "${config.pattern}"`
      : `Output did not match "${config.pattern}"`,
  };
}

export default { type, run };
