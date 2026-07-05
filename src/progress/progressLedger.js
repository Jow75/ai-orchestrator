/**
 * progressLedger.js — Per-run audit trail (the record the incident lacked).
 *
 * Appends one record per agent run to `state/ledger/<project>.jsonl`:
 * timestamp, run number, exit cause, whether the workspace progressed, the
 * signature, and a bounded excerpt of the agent's final response. This is
 * the evidence base for diagnostics and — in later phases — the memory and
 * execution-history subsystems.
 *
 * Append-only and torn-line tolerant (see statePersistence.appendJsonl): a
 * power loss can cost at most the final record, never the history.
 */

import path from 'node:path';
import { appendJsonl, readJsonl } from '../state/statePersistence.js';

/** Cap the stored result text so the ledger stays small and greppable. */
const MAX_RESULT_CHARS = 2_000;

export class ProgressLedger {
  /**
   * @param {object} options
   * @param {string} options.ledgerDir - Directory for per-project ledgers.
   * @param {object} options.logger - Module logger.
   */
  constructor({ ledgerDir, logger }) {
    this.ledgerDir = ledgerDir;
    this.logger = logger;
  }

  ledgerFile(project) {
    return path.join(this.ledgerDir, `${project}.jsonl`);
  }

  /**
   * Record one completed run.
   *
   * @param {object} entry
   * @param {string} entry.project
   * @param {string} entry.sessionId
   * @param {number} entry.run - Run number within the session.
   * @param {string} entry.cause - Exit cause (from the classifier).
   * @param {boolean} entry.progressed - Did the workspace change?
   * @param {string|null} entry.signature - Workspace signature hash.
   * @param {string} entry.signatureMethod - 'git' | 'filescan' | 'none'.
   * @param {number} entry.consecutiveNoProgress
   * @param {string|null} [entry.resultText] - Agent's final response.
   * @param {object} [entry.blocked] - detectBlockedState() result, if any.
   */
  record(entry) {
    const record = {
      at: new Date().toISOString(),
      ...entry,
      resultText: truncate(entry.resultText ?? '', MAX_RESULT_CHARS),
    };
    try {
      appendJsonl(this.ledgerFile(entry.project), record);
    } catch (error) {
      // The ledger is an audit aid; never let it disrupt supervision.
      this.logger.warn('Failed to append progress ledger record', {
        project: entry.project,
        error: error.message,
      });
    }
    return record;
  }

  /**
   * Return the most recent `n` records for a project (oldest → newest).
   *
   * @param {string} project
   * @param {number} [n]
   * @returns {object[]}
   */
  recent(project, n = 10) {
    const all = readJsonl(this.ledgerFile(project));
    return all.slice(-n);
  }
}

function truncate(text, maxChars) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}

export default ProgressLedger;
