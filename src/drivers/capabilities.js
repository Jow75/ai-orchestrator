/**
 * capabilities.js — Phase 13 M5: what a driver can actually do, as data.
 *
 * Reference data only — nothing in this file gates or changes behaviour; no
 * caller was asked to enforce a capability, so none is enforced. This
 * exists purely so `/provider` can answer "what models does this engine
 * support, does it stream, can it be cancelled" without inventing an
 * answer. Matches this codebase's existing preference for plain data over
 * class hierarchies (`BUILTIN_DRIVERS`, `drivers/simulation.js`'s
 * `SIMULATED_DRIVERS` are both plain objects too).
 *
 * `cli`'s `toolUse: 'unknown'` is deliberate, not a lazy placeholder: a
 * generic CLI wrapper cannot introspect an arbitrary engine's real
 * capabilities, and `projectRegistry.js`'s own stated principle — a
 * registry that reports "unknown" is more useful than one that reports a
 * confident fiction — argues directly against inventing `true` or `false`
 * here.
 */

export const DRIVER_CAPABILITIES = Object.freeze({
  claude: Object.freeze({
    label: 'Claude Code',
    models: Object.freeze(['sonnet', 'opus', 'haiku']),
    streaming: true,
    cancellation: true,
    toolUse: true,
  }),
  mock: Object.freeze({
    label: 'Mock (fixture — never writes real files)',
    models: Object.freeze([]),
    streaming: false,
    cancellation: true,
    toolUse: false,
  }),
  cli: Object.freeze({
    label: 'Generic CLI (any engine wrapped via project config)',
    models: Object.freeze([]),
    streaming: true,
    cancellation: true,
    toolUse: 'unknown',
  }),
  nvidia: Object.freeze({
    label: 'NVIDIA NIM (text-completion fallback — no file/tool access)',
    models: Object.freeze(['nvidia/nemotron-3-ultra-550b-a55b', 'openai/gpt-oss-120b']),
    streaming: false,
    cancellation: true,
    toolUse: false,
  }),
});

/** Capabilities for one driver id, or null when the id isn't known. */
export function capabilitiesOf(driverId) {
  return DRIVER_CAPABILITIES[driverId] ?? null;
}

export default { DRIVER_CAPABILITIES, capabilitiesOf };
