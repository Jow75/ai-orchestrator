/**
 * onboarding/prompts.js — Phase 11A: a tiny, testable prompt harness.
 *
 * The onboarding wizards (project creation, `init`, `notify setup`) need to
 * ask the operator questions on the terminal. This wraps
 * `readline/promises` behind a small API and — crucially — makes every flow
 * unit-testable WITHOUT a TTY by injecting the `ask` function and the output
 * stream. Tests feed a scripted answer queue; production uses real readline.
 *
 * Nothing here reads `process.stdin` directly, so a wizard can be driven
 * entirely from a test.
 */

import readline from 'node:readline/promises';

/**
 * Create a prompter.
 *
 * @param {object} [options]
 * @param {NodeJS.ReadableStream} [options.input] - Defaults to process.stdin.
 * @param {NodeJS.WritableStream} [options.output] - Defaults to process.stdout.
 * @param {(query: string) => Promise<string>} [options.ask] - Injectable line
 *   reader (tests). When absent, a lazy readline interface over input/output
 *   is used. Providing this bypasses readline entirely.
 * @returns {Prompter}
 */
export function createPrompter({ input = process.stdin, output = process.stdout, ask } = {}) {
  let rl = null;
  const askLine = ask ?? (async (query) => {
    if (!rl) rl = readline.createInterface({ input, output });
    return rl.question(query);
  });

  /** Print a line of information/instructions to the operator. */
  const say = (text = '') => { output.write(`${text}\n`); };

  /**
   * Free-text question. Re-asks until `validate` passes (if supplied).
   *
   * @param {string} question
   * @param {object} [opts]
   * @param {string} [opts.default] - Returned when the operator presses Enter.
   * @param {(value: string) => true|string} [opts.validate] - Return `true`
   *   to accept, or an error string to reject and re-ask.
   * @param {boolean} [opts.allowEmpty] - Accept an empty answer (no default).
   * @returns {Promise<string>}
   */
  const text = async (question, { default: def, validate, allowEmpty = false } = {}) => {
    for (;;) {
      const suffix = def !== undefined && def !== '' ? ` [${def}]` : '';
      // eslint-disable-next-line no-await-in-loop
      const raw = (await askLine(`${question}${suffix}: `)).trim();
      const value = raw === '' && def !== undefined ? def : raw;
      if (value === '' && !allowEmpty && def === undefined) {
        say('  A value is required.');
        continue;
      }
      if (validate) {
        const verdict = validate(value);
        if (verdict !== true) {
          say(`  ${verdict}`);
          continue;
        }
      }
      return value;
    }
  };

  /**
   * A secret/credential question. Identical to `text` but the caller should
   * never echo the value back in a confirmation line. (No terminal masking —
   * pasted tokens are visible, exactly as when editing the JSON by hand.)
   */
  const secret = async (question, opts = {}) => text(question, { ...opts, allowEmpty: false });

  /**
   * Yes/No question.
   *
   * @param {string} question
   * @param {object} [opts]
   * @param {boolean} [opts.default] - Default when Enter is pressed (false).
   * @returns {Promise<boolean>}
   */
  const confirm = async (question, { default: def = false } = {}) => {
    const hint = def ? '[Y/n]' : '[y/N]';
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const raw = (await askLine(`${question} ${hint}: `)).trim().toLowerCase();
      if (raw === '') return def;
      if (['y', 'yes'].includes(raw)) return true;
      if (['n', 'no'].includes(raw)) return false;
      say('  Please answer y or n.');
    }
  };

  /**
   * Choose one option from a list. Accepts the 1-based number or the value.
   *
   * @param {string} question
   * @param {Array<string|{value:string,label?:string,hint?:string}>} choices
   * @param {object} [opts]
   * @param {string} [opts.default] - Pre-selected value (Enter accepts it).
   * @returns {Promise<string>} The chosen value.
   */
  const choose = async (question, choices, { default: def } = {}) => {
    const normalized = choices.map((c) => (typeof c === 'string' ? { value: c } : c));
    say(question);
    normalized.forEach((c, i) => {
      const marker = c.value === def ? ' (default)' : '';
      const hint = c.hint ? ` — ${c.hint}` : '';
      say(`  ${i + 1}) ${c.label ?? c.value}${marker}${hint}`);
    });
    for (;;) {
      const suffix = def !== undefined ? ` [${def}]` : '';
      // eslint-disable-next-line no-await-in-loop
      const raw = (await askLine(`Choose 1-${normalized.length}${suffix}: `)).trim();
      if (raw === '' && def !== undefined) return def;
      const byNumber = Number.parseInt(raw, 10);
      if (Number.isInteger(byNumber) && byNumber >= 1 && byNumber <= normalized.length) {
        return normalized[byNumber - 1].value;
      }
      const byValue = normalized.find((c) => c.value === raw);
      if (byValue) return byValue.value;
      say(`  Enter a number 1-${normalized.length} or one of: ${normalized.map((c) => c.value).join(', ')}.`);
    }
  };

  /** Release the underlying readline interface (no-op when injected). */
  const close = () => { rl?.close(); rl = null; };

  /** @typedef {object} Prompter */
  return { say, text, secret, confirm, choose, close };
}

export default createPrompter;
