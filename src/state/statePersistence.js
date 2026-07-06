/**
 * statePersistence.js — Crash-safe JSON state storage.
 *
 * The orchestrator may lose power at any instant, so every state write is
 * atomic: write to a temp file, then rename over the target. A partially
 * written file can never replace good state.
 *
 * Reads are corruption-tolerant: a damaged file is quarantined (renamed to
 * `<file>.corrupt-<timestamp>`) rather than crashing the supervisor, and the
 * caller receives `null` so it can fall back to defaults.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Atomically write a JSON-serialisable value to `filePath`.
 *
 * @param {string} filePath - Destination file.
 * @param {*} value - Value to serialise.
 */
export function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  // Unique temp name so concurrent writers can never collide mid-write.
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );

  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    // The rename can fail transiently on Windows (EPERM when another handle,
    // e.g. antivirus or an editor, briefly holds the target). Never leave the
    // temp file orphaned on disk — clean it up before surfacing the error.
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Best effort: if even cleanup fails, the caller's error still wins.
    }
    throw error;
  }
}

/**
 * Read a JSON file written by {@link writeJsonAtomic}.
 *
 * @param {string} filePath - Source file.
 * @param {object} [options]
 * @param {object} [options.logger] - Optional logger for corruption warnings.
 * @returns {*} Parsed value, or `null` if missing or corrupt.
 */
export function readJsonSafe(filePath, { logger } = {}) {
  if (!fs.existsSync(filePath)) return null;

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    // Quarantine instead of deleting: the bytes may still help a human debug.
    const quarantine = `${filePath}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(filePath, quarantine);
    } catch {
      // If even the rename fails we still must not crash the supervisor.
    }
    logger?.warn?.(`Corrupt state file quarantined`, {
      file: filePath,
      quarantine,
      error: error.message,
    });
    return null;
  }
}

/**
 * Append one JSON record to a `.jsonl` history file (one object per line).
 * History appends are not atomic, but a torn final line only ever costs the
 * last record — earlier history stays intact and readers skip bad lines.
 *
 * @param {string} filePath - Destination `.jsonl` file.
 * @param {object} record - Record to append.
 */
export function appendJsonl(filePath, record) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
}

/**
 * Read all intact records from a `.jsonl` file, skipping damaged lines.
 *
 * @param {string} filePath - Source `.jsonl` file.
 * @returns {object[]} Parsed records (empty when the file is missing).
 */
export function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const records = [];
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // Torn or corrupt line — skip it, keep the rest of the history.
    }
  }
  return records;
}

export default { writeJsonAtomic, readJsonSafe, appendJsonl, readJsonl };
