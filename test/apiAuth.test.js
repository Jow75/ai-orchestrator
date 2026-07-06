/**
 * Tests for the Phase P7 local API token: generation/persistence and the
 * `requireAuth` middleware's accept/reject behavior.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadOrCreateToken, requireAuth } from '../src/api/apiAuth.js';

function tokenFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aio-token-')), 'api-token.txt');
}

test('loadOrCreateToken() generates and persists a token on first use', () => {
  const file = tokenFile();
  assert.ok(!fs.existsSync(file));
  const token = loadOrCreateToken(file);
  assert.match(token, /^[0-9a-f]{48}$/);
  assert.ok(fs.existsSync(file));
});

test('loadOrCreateToken() returns the SAME token on subsequent calls', () => {
  const file = tokenFile();
  const first = loadOrCreateToken(file);
  const second = loadOrCreateToken(file);
  assert.equal(first, second);
});

test('loadOrCreateToken({ rotate: true }) invalidates the previous token', () => {
  const file = tokenFile();
  const first = loadOrCreateToken(file);
  const rotated = loadOrCreateToken(file, { rotate: true });
  assert.notEqual(first, rotated);
  assert.equal(loadOrCreateToken(file), rotated); // the new one persists
});

function fakeReqRes(headers) {
  const req = { get: (name) => headers[name.toLowerCase()] };
  let statusCode = null;
  let body = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(payload) { body = payload; return this; },
  };
  return { req, res, result: () => ({ statusCode, body }) };
}

test('requireAuth: accepts a matching Bearer token and calls next()', () => {
  const middleware = requireAuth('secret-token');
  const { req, res } = fakeReqRes({ authorization: 'Bearer secret-token' });
  let nextCalled = false;
  middleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test('requireAuth: accepts a matching X-API-Token header', () => {
  const middleware = requireAuth('secret-token');
  const { req, res } = fakeReqRes({ 'x-api-token': 'secret-token' });
  let nextCalled = false;
  middleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test('requireAuth: 401s on a missing token', () => {
  const middleware = requireAuth('secret-token');
  const { req, res, result } = fakeReqRes({});
  let nextCalled = false;
  middleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(result().statusCode, 401);
});

test('requireAuth: 401s on a wrong token', () => {
  const middleware = requireAuth('secret-token');
  const { req, res, result } = fakeReqRes({ authorization: 'Bearer wrong' });
  middleware(req, res, () => {});
  assert.equal(result().statusCode, 401);
});

test('requireAuth: always 401s when no token is configured (safe default, never open)', () => {
  const middleware = requireAuth(undefined);
  const { req, res, result } = fakeReqRes({ authorization: 'Bearer anything' });
  middleware(req, res, () => {});
  assert.equal(result().statusCode, 401);
});
