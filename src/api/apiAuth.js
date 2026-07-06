/**
 * apiAuth.js — Phase P7: local auth token for the dashboard API's mutating
 * endpoints.
 *
 * The read-only endpoints (`/api/status`, `/api/tasks/:project`, ...) have
 * been open on the local-only bind (`api.host` default `127.0.0.1`) since
 * P0 — observability was never a risk. Mutating endpoints (stop a mission,
 * edit a task queue, resolve a memory failure) are a different matter: a
 * local token, generated once and stored on disk, gates them. This is
 * deliberately NOT a full auth system (no users, no expiry, no scopes) —
 * a single shared secret matching the "one operator, one machine" model
 * the rest of the CLI already assumes.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Load the persisted token, generating and persisting one on first use.
 *
 * @param {string} tokenFile - Path to the token file (see paths.apiTokenFile).
 * @param {{rotate?: boolean}} [options] - `rotate: true` always generates
 *   and persists a fresh token, invalidating the previous one.
 * @returns {string} The current token.
 */
export function loadOrCreateToken(tokenFile, { rotate = false } = {}) {
  if (!rotate && fs.existsSync(tokenFile)) {
    return fs.readFileSync(tokenFile, 'utf8').trim();
  }
  const token = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  return token;
}

/**
 * Express middleware: requires `Authorization: Bearer <token>` (or the
 * equivalent `X-API-Token` header, for clients that can't easily set
 * Authorization) matching the configured token, else 401s.
 *
 * @param {string} token
 */
export function requireAuth(token) {
  return (req, res, next) => {
    const header = req.get('authorization') ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
    const provided = bearer ?? req.get('x-api-token');
    if (!token || provided !== token) {
      res.status(401).json({ error: 'Unauthorized — missing or invalid API token' });
      return;
    }
    next();
  };
}

export default { loadOrCreateToken, requireAuth };
