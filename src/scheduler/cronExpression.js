/**
 * cronExpression.js — Phase 10G: a dependency-free 5-field cron parser.
 *
 * Supports the classic `minute hour day-of-month month day-of-week` shape
 * with `*`, single values, lists (`1,15`), ranges (`1-5`), and slash steps
 * (star/15, `10-50/10`). Day-of-week accepts 0-7 (0 and 7 = Sunday) and
 * English names (sun..sat); months accept 1-12 and names (jan..dec).
 *
 * Matching semantics follow POSIX cron: when BOTH day-of-month and
 * day-of-week are restricted, a date matches if EITHER matches.
 *
 * Pure logic; times are local (the machine the orchestrator runs on —
 * matching how a human writes "07:30 every day" for their own laptop).
 */

const FIELD_RANGES = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dayOfMonth', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dayOfWeek', min: 0, max: 7 }, // 0 and 7 are both Sunday
];

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * Parse a cron expression into per-field allowed-value sets.
 *
 * @param {string} expression - e.g. "30 7 * * mon-fri".
 * @returns {{minute: Set, hour: Set, dayOfMonth: Set, month: Set, dayOfWeek: Set,
 *            domRestricted: boolean, dowRestricted: boolean}}
 * @throws {Error} With a message naming the offending field.
 */
export function parseCron(expression) {
  const fields = String(expression ?? '').trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `Invalid cron "${expression}": expected 5 fields (minute hour day month weekday), got ${fields.length}.`
    );
  }

  const parsed = {};
  for (const [i, spec] of fields.entries()) {
    const { name, min, max } = FIELD_RANGES[i];
    const names = name === 'month' ? MONTH_NAMES : (name === 'dayOfWeek' ? DAY_NAMES : null);
    parsed[name] = parseField(spec, { min, max, names, field: name });
  }

  // Normalize Sunday: 7 → 0 so matching only ever checks 0-6.
  if (parsed.dayOfWeek.has(7)) {
    parsed.dayOfWeek.delete(7);
    parsed.dayOfWeek.add(0);
  }

  parsed.domRestricted = fields[2] !== '*';
  parsed.dowRestricted = fields[4] !== '*';
  return parsed;
}

/** Parse one field spec ("*", star/5, "1,2,10-20/2", "mon-fri") into a Set. */
function parseField(spec, { min, max, names, field }) {
  const values = new Set();
  for (const part of spec.split(',')) {
    const stepMatch = part.match(/^(.+?)\/(\d+)$/);
    const step = stepMatch ? Number(stepMatch[2]) : 1;
    const base = stepMatch ? stepMatch[1] : part;
    if (step < 1) throw new Error(`Invalid cron ${field} "${part}": step must be >= 1.`);

    let lo;
    let hi;
    if (base === '*') {
      lo = min;
      hi = max;
    } else {
      const rangeMatch = base.match(/^(.+?)-(.+)$/);
      if (rangeMatch) {
        lo = valueOf(rangeMatch[1], names, field);
        hi = valueOf(rangeMatch[2], names, field);
      } else {
        lo = valueOf(base, names, field);
        hi = stepMatch ? max : lo; // "N/step" means "from N to max, stepping"
      }
    }
    if (Number.isNaN(lo) || Number.isNaN(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`Invalid cron ${field} "${part}": values must be ${min}-${max}.`);
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
}

/** A single field value: numeric or a recognized name. */
function valueOf(token, names, field) {
  const lower = token.toLowerCase();
  if (names) {
    const index = names.indexOf(lower.slice(0, 3));
    if (index !== -1) return field === 'month' ? index + 1 : index;
  }
  if (!/^\d+$/.test(token)) return NaN;
  return Number(token);
}

/** Whether a Date matches a parsed cron expression. */
export function cronMatches(parsed, date) {
  if (!parsed.minute.has(date.getMinutes())) return false;
  if (!parsed.hour.has(date.getHours())) return false;
  if (!parsed.month.has(date.getMonth() + 1)) return false;

  const domMatch = parsed.dayOfMonth.has(date.getDate());
  const dowMatch = parsed.dayOfWeek.has(date.getDay());
  // POSIX rule: both restricted ⇒ either may match; otherwise both must.
  if (parsed.domRestricted && parsed.dowRestricted) return domMatch || dowMatch;
  return domMatch && dowMatch;
}

/**
 * The next occurrence of a cron expression strictly AFTER `after`.
 * Efficient field-skipping walk (never minute-by-minute over years);
 * returns null if nothing matches within ~4 years (an impossible spec,
 * e.g. Feb 30).
 *
 * @param {string|object} expression - Cron string or a parseCron() result.
 * @param {Date} [after]
 * @returns {Date|null}
 */
export function nextCronOccurrence(expression, after = new Date()) {
  const parsed = typeof expression === 'string' ? parseCron(expression) : expression;

  // Start at the next whole minute.
  const candidate = new Date(after.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  const limit = new Date(after.getTime());
  limit.setFullYear(limit.getFullYear() + 4);

  while (candidate <= limit) {
    if (!parsed.month.has(candidate.getMonth() + 1)) {
      candidate.setMonth(candidate.getMonth() + 1, 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }
    const domMatch = parsed.dayOfMonth.has(candidate.getDate());
    const dowMatch = parsed.dayOfWeek.has(candidate.getDay());
    const dayMatches = parsed.domRestricted && parsed.dowRestricted
      ? (domMatch || dowMatch)
      : (domMatch && dowMatch);
    if (!dayMatches) {
      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }
    if (!parsed.hour.has(candidate.getHours())) {
      candidate.setHours(candidate.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!parsed.minute.has(candidate.getMinutes())) {
      candidate.setMinutes(candidate.getMinutes() + 1, 0, 0);
      continue;
    }
    return candidate;
  }
  return null;
}

export default { parseCron, cronMatches, nextCronOccurrence };
