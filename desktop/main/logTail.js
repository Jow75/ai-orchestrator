'use strict';

/**
 * logTail.js — Logs Viewer data source.
 *
 * Tails the winston-rotated log files AI-Orchestrator already writes
 * (`logs/orchestrator-YYYY-MM-DD.log`, `logs/error-YYYY-MM-DD.log`) —
 * available regardless of which process (this app, the CLI, or the
 * Scheduler task) started the mission being watched.
 *
 * Known limitation (see desktop/README.md): raw agent stdout is never
 * written to these files (confirmed against src/drivers/claudeDriver.js and
 * src/core/processSupervisor.js — only lifecycle events are logged), so
 * this view shows orchestrator/system events, not a full agent transcript.
 * A live child-stdout pipe was deliberately not built: a detached mission
 * must survive this app closing, and an unread stdio pipe on an
 * unattended child can fill and block the orchestrator's own writes.
 */

const fs = require('node:fs');
const path = require('node:path');

class LogTail {
  /** @param {{logsDir: string}} options */
  constructor({ logsDir }) {
    this.logsDir = logsDir;
    this.offsets = new Map();
  }

  /** Log files present, newest first (lexical sort works: YYYY-MM-DD prefix). */
  listFiles() {
    if (!fs.existsSync(this.logsDir)) return [];
    return fs.readdirSync(this.logsDir).filter((f) => f.endsWith('.log')).sort().reverse();
  }

  /** Today's main log file name (winston's default naming pattern). */
  defaultFile() {
    const date = new Date().toISOString().slice(0, 10);
    return `orchestrator-${date}.log`;
  }

  /**
   * Read a file's content. First call for a given filename returns the
   * last `initialLines`; every subsequent call returns only what's been
   * appended since — the natural shape for a polling renderer.
   *
   * @param {string} filename
   * @param {{initialLines?: number}} [options]
   * @returns {object[]} Parsed log entries (or `{message, raw:true}` for
   *   any non-JSON line, e.g. console-format leftovers).
   */
  poll(filename, { initialLines = 200 } = {}) {
    const file = path.join(this.logsDir, filename);
    if (!fs.existsSync(file)) return [];

    const stat = fs.statSync(file);
    const known = this.offsets.has(filename);

    if (!known) {
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n').filter(Boolean).slice(-initialLines);
      this.offsets.set(filename, stat.size);
      return lines.map(parseLine);
    }

    let start = this.offsets.get(filename);
    if (stat.size < start) start = 0; // rotated/truncated since last poll
    if (stat.size <= start) {
      this.offsets.set(filename, stat.size);
      return [];
    }

    const fd = fs.openSync(file, 'r');
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    fs.closeSync(fd);
    this.offsets.set(filename, stat.size);
    return buffer.toString('utf8').split('\n').filter(Boolean).map(parseLine);
  }

  /** Forget offsets (e.g. when the renderer switches which file it's viewing). */
  reset(filename) {
    this.offsets.delete(filename);
  }
}

function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return { message: line, level: 'info', raw: true };
  }
}

module.exports = { LogTail };
