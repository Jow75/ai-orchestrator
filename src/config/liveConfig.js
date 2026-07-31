/**
 * liveConfig.js — Phase 13 M4: the first mechanism for the daemon to accept
 * a config change without a restart.
 *
 * Ground truth this design turns on (see docs/PHASE_13_PLAN.md D2 and E6 in
 * PHASE_12_PLAN.md): "files remain the source of truth… IPC/memory is
 * advisory." A memory-only mutation would make memory the source of truth
 * the instant the daemon restarts and forgets a change from minutes ago — a
 * worse surprise than requiring a restart in the first place. So every
 * patch is written to disk FIRST, via the existing
 * `ConfigManager.writeLocalConfig()` (until now only ever called by one-shot
 * setup wizards), and only THEN mirrored into the exact same in-memory
 * object `daemon.js` already hands to every subsystem at construction
 * (`this.config = this.configManager.getAll()`, held by reference) — no
 * subsystem needs telling to "reload," because nothing ever stopped holding
 * the live object.
 *
 * `LIVE_MUTABLE_PATHS` is a closed allowlist, deliberately not "anything in
 * config": that would silently turn restart-only settings
 * (`daemon.pollIntervalMs`, `api.port`) into ones that look live but
 * aren't — an unaudited surface nobody asked for. Extend it as more of the
 * remote-configuration wishlist gets prioritized.
 */

/** Dotted config paths a running daemon may change without a restart. */
export const LIVE_MUTABLE_PATHS = Object.freeze([
  'operator.projectRoots',
  'operator.defaultModel',
  'operator.defaultProvider',
  'operator.safeMode',
  'notifications.minSeverity',
  'notifications.telegram.enabled',
  'notifications.email.enabled',
  'notifications.discord.enabled',
  'notifications.webhook.enabled',
  'approvals.mode',
]);

/** Set `obj.a.b.c = value` for a dotted path, creating intermediate objects as needed. */
function setDeep(obj, dottedKey, value) {
  const parts = dottedKey.split('.');
  let cursor = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (typeof cursor[part] !== 'object' || cursor[part] === null) cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts.at(-1)] = value;
}

export class LiveConfigLayer {
  /**
   * @param {object} deps
   * @param {import('./configManager.js').ConfigManager} deps.configManager
   */
  constructor({ configManager }) {
    this.configManager = configManager;
  }

  /**
   * Apply a patch of dotted-path → new value.
   *
   * All-or-nothing: if ANY key in the patch isn't on the allowlist, NOTHING
   * is written or mutated — a caller must never have to guess which half of
   * a multi-key patch landed.
   *
   * @param {Record<string, *>} patch - e.g. `{'operator.projectRoots': [...]}`.
   * @returns {string[]} The keys that were changed, in patch order.
   * @throws {Error} If any key is not in `LIVE_MUTABLE_PATHS`.
   */
  applyPatch(patch) {
    const keys = Object.keys(patch ?? {});
    const unknown = keys.filter((key) => !LIVE_MUTABLE_PATHS.includes(key));
    if (unknown.length) {
      throw new Error(
        `Not remotely configurable: ${unknown.join(', ')}. Allowed: ${LIVE_MUTABLE_PATHS.join(', ')}.`
      );
    }
    if (!keys.length) return [];

    // Disk first (see file header for why).
    const nested = {};
    for (const key of keys) setDeep(nested, key, patch[key]);
    this.configManager.writeLocalConfig(nested);

    // Then the live object every subsystem already holds a reference to.
    const config = this.configManager.getAll();
    for (const key of keys) setDeep(config, key, patch[key]);

    return keys;
  }
}

export default LiveConfigLayer;
