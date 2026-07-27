/**
 * Unit tests for daemonRecord.js — Phase 12 M1.
 *
 * The record answers one question ("is the Core Service up, and where?") with
 * the same three-outcome contract the heartbeat has always used, so operators
 * meet a familiar model. These tests pin that contract, and pin the separation
 * from heartbeat.json that the whole backwards-compatibility story rests on.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DaemonRecord, readDaemon } from '../src/daemon/daemonRecord.js';
import { writeJsonAtomic } from '../src/state/statePersistence.js';
import { silentLogger } from '../src/infra/logger.js';
import { VERSION } from '../src/infra/version.js';

function tempFile(name = 'daemon.json') {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aio-daemon-')), name);
}

/** A pid that is certainly not running (max pid + 1 is unusable). */
const DEAD_PID = 0x7ffffff0;

test('no record at all is a clean start', () => {
  const record = new DaemonRecord({ daemonFile: tempFile(), logger: silentLogger });
  const result = record.inspectPrevious();
  assert.equal(result.kind, 'clean');
  assert.equal(result.previous, null);
});

test('a "stopped" record is a clean start', () => {
  const file = tempFile();
  writeJsonAtomic(file, { state: 'stopped', pid: process.pid });
  const record = new DaemonRecord({ daemonFile: file, logger: silentLogger });
  assert.equal(record.inspectPrevious().kind, 'clean');
});

test('a "running" record with a LIVE pid refuses a second service', () => {
  const file = tempFile();
  writeJsonAtomic(file, { state: 'running', pid: process.pid });
  const record = new DaemonRecord({ daemonFile: file, logger: silentLogger });
  const result = record.inspectPrevious();
  assert.equal(result.kind, 'already-running');
  assert.equal(result.previous.pid, process.pid);
});

test('a "running" record with a DEAD pid is an unclean shutdown, not a conflict', () => {
  const file = tempFile();
  writeJsonAtomic(file, { state: 'running', pid: DEAD_PID });
  const record = new DaemonRecord({ daemonFile: file, logger: silentLogger });
  assert.equal(record.inspectPrevious().kind, 'unclean-shutdown');
});

test('start() stamps pid, version and context; stop() records "stopped"', () => {
  const file = tempFile();
  const record = new DaemonRecord({ daemonFile: file, logger: silentLogger, intervalMs: 60_000 });
  record.start({ port: 4711 });

  const running = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(running.state, 'running');
  assert.equal(running.pid, process.pid);
  assert.equal(running.version, VERSION);
  assert.equal(running.port, 4711);

  record.stop();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).state, 'stopped');
});

test('setContext merges into later stamps', () => {
  const file = tempFile();
  const record = new DaemonRecord({ daemonFile: file, logger: silentLogger, intervalMs: 60_000 });
  record.start({ port: 4711 });
  record.setContext({ workers: 2 });
  record.beat('running');

  const stamped = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(stamped.workers, 2);
  assert.equal(stamped.port, 4711, 'earlier context survives a merge');
  record.stop();
});

test('readDaemon distinguishes not-running from died-without-cleanup', () => {
  const missing = tempFile();
  assert.deepEqual(
    readDaemon(missing, { logger: silentLogger }),
    { running: false, record: null, stale: false }
  );

  const stale = tempFile();
  writeJsonAtomic(stale, { state: 'running', pid: DEAD_PID });
  const staleResult = readDaemon(stale, { logger: silentLogger });
  assert.equal(staleResult.running, false);
  assert.equal(staleResult.stale, true, 'a dead pid on a "running" record is stale, not absent');

  const live = tempFile();
  writeJsonAtomic(live, { state: 'running', pid: process.pid, port: 4711 });
  const liveResult = readDaemon(live, { logger: silentLogger });
  assert.equal(liveResult.running, true);
  assert.equal(liveResult.stale, false);
  assert.equal(liveResult.record.port, 4711);
});

test('the daemon record never touches the heartbeat file (the compatibility invariant)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-daemon-sep-'));
  const daemonFile = path.join(dir, 'daemon.json');
  const heartbeatFile = path.join(dir, 'heartbeat.json');
  writeJsonAtomic(heartbeatFile, { state: 'stopped', pid: 1234, project: 'legacy' });

  const record = new DaemonRecord({ daemonFile, logger: silentLogger, intervalMs: 60_000 });
  record.start({ port: 4711 });
  record.stop();

  // Whatever the daemon did, the standalone orchestrator's lock is untouched:
  // that file is the ONLY thing pre-Phase-12 commands consult.
  assert.deepEqual(
    JSON.parse(fs.readFileSync(heartbeatFile, 'utf8')),
    { state: 'stopped', pid: 1234, project: 'legacy' }
  );
});
