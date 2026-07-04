/**
 * Tests for session lifecycle: creation, updates, resumability rules, and
 * archival to history.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager, SessionState } from '../src/state/sessionManager.js';
import { silentLogger } from '../src/infra/logger.js';

function manager() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-sessions-'));
  return new SessionManager({ sessionsDir: dir, logger: silentLogger });
}

test('createSession persists and is retrievable', () => {
  const sessions = manager();
  const created = sessions.createSession('proj', 'claude');
  const loaded = sessions.getActiveSession('proj');
  assert.equal(loaded.id, created.id);
  assert.equal(loaded.state, SessionState.RUNNING);
  assert.equal(loaded.driver, 'claude');
});

test('update persists changes atomically', () => {
  const sessions = manager();
  const session = sessions.createSession('proj', 'claude');
  sessions.update(session, { engineSessionId: 'engine-1', runs: 3 });

  const loaded = sessions.getActiveSession('proj');
  assert.equal(loaded.engineSessionId, 'engine-1');
  assert.equal(loaded.runs, 3);
});

test('running, waiting, and gave-up sessions are resumable; none is none', () => {
  const sessions = manager();
  assert.equal(sessions.getResumableSession('proj'), null);

  const session = sessions.createSession('proj', 'claude');
  assert.ok(sessions.getResumableSession('proj'));

  sessions.update(session, { state: SessionState.WAITING_RATE_LIMIT });
  assert.ok(sessions.getResumableSession('proj'));

  // Give-up preserves the mission: still resumable on the next start.
  sessions.update(session, { state: SessionState.GAVE_UP });
  assert.ok(sessions.getResumableSession('proj'));
});

test('closeSession archives to history and clears the active slot', () => {
  const sessions = manager();
  const session = sessions.createSession('proj', 'claude');
  sessions.closeSession(session, SessionState.COMPLETED);

  assert.equal(sessions.getActiveSession('proj'), null);
  const history = sessions.getHistory('proj');
  assert.equal(history.length, 1);
  assert.equal(history[0].id, session.id);
  assert.equal(history[0].state, SessionState.COMPLETED);
});

test('listActiveSessions reports every project with an active session', () => {
  const sessions = manager();
  sessions.createSession('alpha', 'claude');
  sessions.createSession('beta', 'mock');
  const active = sessions.listActiveSessions().map((s) => s.project).sort();
  assert.deepEqual(active, ['alpha', 'beta']);
});
