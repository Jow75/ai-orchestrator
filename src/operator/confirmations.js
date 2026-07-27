/**
 * confirmations.js — Phase 12 M2, Priority 7: nothing destructive happens on
 * one message.
 *
 * The approval philosophy this project has held since Phase 10 is that the
 * owner decides, explicitly, before anything irreversible. A remote channel
 * makes that harder in two specific ways, and both are designed against here:
 *
 *  - A phone fat-fingers. `/stop` is one character from `/status`, and on a
 *    small keyboard an accidental send is not hypothetical.
 *  - A message has no context. "yes" arriving twenty minutes after the
 *    question must not confirm anything, because by then it might be
 *    answering something else entirely.
 *
 * So a destructive command produces a PENDING CONFIRMATION carrying a short
 * random code, and only `/confirm <code>` performs it. The code is specific
 * (it names one action on one project), single-use, and expires. A bare "yes"
 * with exactly one pending confirmation is accepted as a convenience — with
 * two or more pending, it is refused and the codes are listed, because
 * guessing which one the owner meant is exactly the failure this module
 * exists to prevent.
 *
 * In memory, deliberately. A confirmation is a five-minute conversational
 * state, not a fact about the system; a service restart SHOULD forget it,
 * because the owner's intent has not survived either.
 */

import crypto from 'node:crypto';

/** Default validity window for a confirmation code. */
export const DEFAULT_TTL_MS = 300_000; // 5 minutes

/** Codes are short enough to retype on a phone, random enough not to collide. */
const CODE_ALPHABET = 'ACDEFHJKLMNPRTUVWXY34679';
const CODE_LENGTH = 4;

export class ConfirmationStore {
  /**
   * @param {object} [options]
   * @param {number} [options.ttlMs]
   * @param {() => number} [options.now] - Injectable clock (tests).
   */
  constructor({ ttlMs = DEFAULT_TTL_MS, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    /** code → {code, channel, action, project, summary, createdAt, expiresAt, perform} */
    this.pending = new Map();
  }

  /** A short, unambiguous, phone-typeable code. */
  generateCode() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const bytes = crypto.randomBytes(CODE_LENGTH);
      let code = '';
      for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
      if (!this.pending.has(code)) return code;
    }
    // Astronomically unlikely; falling back to a timestamp keeps it unique
    // rather than looping forever or returning a colliding code.
    return `C${this.now()}`;
  }

  /**
   * Register an action that must be confirmed before it runs.
   *
   * @param {object} params
   * @param {string} params.channel - Confirmations are per channel: a code
   *   issued to Telegram must not be redeemable from somewhere else.
   * @param {string} params.action - Command name ('stop', 'shutdown', …).
   * @param {string} [params.project]
   * @param {string} params.summary - Exactly what will happen, in the owner's
   *   words, so the confirmation message can restate it.
   * @param {() => Promise<*>|*} params.perform - Executed on confirmation.
   * @returns {object} The pending confirmation.
   */
  require({ channel, action, project, summary, perform }) {
    this.prune();
    const code = this.generateCode();
    const confirmation = {
      code,
      channel,
      action,
      project: project ?? null,
      summary,
      perform,
      createdAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(this.now() + this.ttlMs).toISOString(),
    };
    this.pending.set(code, confirmation);
    return confirmation;
  }

  /** Drop everything past its expiry. Returns the dropped confirmations. */
  prune() {
    const now = this.now();
    const dropped = [];
    for (const [code, confirmation] of this.pending) {
      if (Date.parse(confirmation.expiresAt) <= now) {
        this.pending.delete(code);
        dropped.push(confirmation);
      }
    }
    return dropped;
  }

  /** Every live confirmation for one channel. */
  listFor(channel) {
    this.prune();
    return [...this.pending.values()].filter((c) => c.channel === channel);
  }

  /**
   * Redeem a code.
   *
   * @param {string} channel
   * @param {string} [code] - Omitted ⇒ "the one pending confirmation", which
   *   is only honoured when there is exactly one.
   * @returns {{ok: boolean, reason?: string, confirmation?: object, candidates?: object[]}}
   */
  take(channel, code) {
    this.prune();
    const mine = this.listFor(channel);

    if (!code) {
      if (mine.length === 1) {
        this.pending.delete(mine[0].code);
        return { ok: true, confirmation: mine[0] };
      }
      if (mine.length === 0) {
        return { ok: false, reason: 'Nothing is waiting for confirmation.' };
      }
      return {
        ok: false,
        reason: `${mine.length} actions are waiting for confirmation — say which one.`,
        candidates: mine,
      };
    }

    const normalized = String(code).trim().toUpperCase();
    const confirmation = this.pending.get(normalized);
    if (!confirmation) {
      return {
        ok: false,
        reason: `Confirmation code "${normalized}" is not valid (it may have expired).`,
        candidates: mine,
      };
    }
    if (confirmation.channel !== channel) {
      // A code issued elsewhere is not redeemable here, and saying so plainly
      // is better than pretending it does not exist.
      return { ok: false, reason: `Confirmation code "${normalized}" was not issued here.` };
    }
    this.pending.delete(normalized);
    return { ok: true, confirmation };
  }

  /**
   * Discard a pending confirmation without performing it.
   *
   * @returns {{ok: boolean, reason?: string, confirmation?: object, cancelled?: number}}
   */
  cancel(channel, code) {
    this.prune();
    if (!code) {
      const mine = this.listFor(channel);
      for (const confirmation of mine) this.pending.delete(confirmation.code);
      return mine.length
        ? { ok: true, cancelled: mine.length }
        : { ok: false, reason: 'Nothing is waiting for confirmation.' };
    }
    const normalized = String(code).trim().toUpperCase();
    const confirmation = this.pending.get(normalized);
    if (!confirmation || confirmation.channel !== channel) {
      return { ok: false, reason: `Confirmation code "${normalized}" is not valid.` };
    }
    this.pending.delete(normalized);
    return { ok: true, confirmation, cancelled: 1 };
  }
}

export default ConfirmationStore;
