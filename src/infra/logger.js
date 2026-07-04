/**
 * logger.js — Logging engine for AI-Orchestrator.
 *
 * Design goals:
 *  - Everything of consequence is logged (launches, exits, resumes, waits,
 *    crashes, decisions) — the log is the audit trail of the supervisor.
 *  - Daily rotation with size caps so a supervisor that runs for months
 *    never fills the disk.
 *  - Human-readable console output, structured JSON in files.
 *  - Child loggers carry a `module` label so every line is attributable.
 */

import path from 'node:path';
import fs from 'node:fs';
import winston from 'winston';
import 'winston-daily-rotate-file'; // registers winston.transports.DailyRotateFile

/** Log-file naming/rotation defaults. Overridable via config `logging`. */
const DEFAULTS = {
  level: 'info',
  console: true,
  file: true,
  maxFiles: '14d', // keep two weeks of history
  maxSize: '10m', // rotate a file once it reaches 10 MB
};

const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, module: mod, ...meta }) => {
    const label = mod ? ` [${mod}]` : '';
    const rest = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} ${level}${label}: ${message}${rest}`;
  })
);

const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.json()
);

/**
 * Create the root logger.
 *
 * @param {object} [options]
 * @param {string} [options.level] - Minimum level ('debug'|'info'|'warn'|'error').
 * @param {string} [options.directory] - Directory for rotated log files.
 * @param {boolean} [options.console] - Mirror logs to the console.
 * @param {boolean} [options.file] - Write rotated log files.
 * @param {string} [options.maxFiles] - Retention (e.g. '14d' or a count).
 * @param {string} [options.maxSize] - Per-file size cap before rotation.
 * @returns {winston.Logger}
 */
export function createLogger(options = {}) {
  const config = { ...DEFAULTS, ...options };
  const transports = [];

  if (config.console) {
    transports.push(new winston.transports.Console({ format: consoleFormat }));
  }

  if (config.file && config.directory) {
    fs.mkdirSync(config.directory, { recursive: true });

    // Main log: everything at the configured level and above.
    transports.push(
      new winston.transports.DailyRotateFile({
        filename: path.join(config.directory, 'orchestrator-%DATE%.log'),
        datePattern: 'YYYY-MM-DD',
        maxFiles: config.maxFiles,
        maxSize: config.maxSize,
        format: fileFormat,
      })
    );

    // Error log: errors only, kept separate for quick triage.
    transports.push(
      new winston.transports.DailyRotateFile({
        filename: path.join(config.directory, 'error-%DATE%.log'),
        datePattern: 'YYYY-MM-DD',
        maxFiles: config.maxFiles,
        maxSize: config.maxSize,
        level: 'error',
        format: fileFormat,
      })
    );
  }

  return winston.createLogger({
    level: config.level,
    transports,
    // The supervisor must survive its own logging failures.
    exitOnError: false,
  });
}

/**
 * Derive a module-scoped child logger. Lines carry `module` so every log
 * entry is attributable to the component that emitted it.
 *
 * @param {winston.Logger} logger - The root logger.
 * @param {string} moduleName - e.g. 'orchestrator', 'claude-driver'.
 * @returns {winston.Logger}
 */
export function childLogger(logger, moduleName) {
  return logger.child({ module: moduleName });
}

/**
 * A no-op logger for tests and optional components.
 * Matches the winston Logger call surface used in this codebase.
 */
export const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return silentLogger;
  },
};

export default { createLogger, childLogger, silentLogger };
