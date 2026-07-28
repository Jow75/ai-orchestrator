/**
 * portRegistry.js — Phase 12 M2.1: one machine, many projects, no collisions.
 *
 * THE PROBLEM. A developer's machine now runs THE FINISHER, AI-Orchestrator,
 * and a growing set of Electron and web apps, each of which picks a localhost
 * port by writing a number into a config file. Ports chosen independently
 * collide by default: 3000 and 5173 and 8080 are what every framework's
 * scaffold suggests, so every second project starts on a port some other
 * project already wanted. The failure is loud but uninformative — EADDRINUSE
 * names a port, never the project holding it.
 *
 * THE DESIGN. A registry with three ideas, in order of importance:
 *
 *  1. THE OS IS THE AUTHORITY ON "IN USE", NOT THIS FILE. Availability is
 *     tested by binding the port. A registry that answered from its own
 *     records would happily hand out a port that Docker, SQL Server, or a
 *     stale node process is already listening on — and be confidently wrong at
 *     the exact moment it matters. The registry records INTENT; the kernel
 *     reports REALITY; an allocation requires both to agree.
 *
 *  2. STABLE WITHOUT BOOKKEEPING. A port is derived deterministically from
 *     `project:service` (FNV-1a over the name, modulo the range). The same
 *     service gets the same port on every machine and every run, before
 *     anything has been written down, and a project that is deleted and
 *     recreated lands where it was. Linear probing from that offset resolves
 *     the rare hash collision. This is what makes the registry usable by a
 *     project that has not opted in yet: ask, and the answer is already stable.
 *
 *  3. RESERVATIONS ARE A HUMAN DECISION, ALLOCATIONS ARE NOT. THE FINISHER
 *     needs 5173 forever because something outside this machine expects it
 *     there. That is a fact about the world, so it lives in `config/ports.json`
 *     where a human wrote it and a human can read it. Dynamic allocations are
 *     machine-owned state and live under `state/`, on the same config/state
 *     split every other module in this project uses.
 *
 * WHAT THIS DELIBERATELY IS NOT. It does not start, stop, supervise or proxy
 * anything. "Development Runtime Manager" was the request; a port broker is
 * the part of it that is real today, and a module that also claimed to manage
 * runtimes while only managing ports would be the kind of overreach this
 * project's mission cards refuse. Process supervision already exists one layer
 * up (daemon/workerSupervisor.js) and is where any future runtime management
 * belongs.
 */

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic, readJsonSafe } from '../state/statePersistence.js';

/**
 * Default allocation window.
 *
 * Chosen to sit ABOVE the ports frameworks scaffold into (3000 React/Next,
 * 4200 Angular, 5173 Vite, 8080 everything else) and BELOW the IANA ephemeral
 * range Windows allocates outbound sockets from (49152+). Allocating inside
 * the ephemeral range is the classic intermittent bug: the port is free when
 * checked and stolen by an outbound connection thirty seconds later.
 */
export const DEFAULT_RANGE = Object.freeze({ start: 5200, end: 5899 });

/** Ports never allocated automatically, whatever the range says. */
export const NEVER_ALLOCATE = Object.freeze([
  5432, // PostgreSQL
  5672, // RabbitMQ
  5900, // VNC
]);

/** How long a bind probe may take before the port is treated as unknown. */
export const PROBE_TIMEOUT_MS = 1_000;

/**
 * Interfaces a port must be bindable on before it is called free.
 *
 * BOTH are required, and finding out why cost a live validation. Probing only
 * `0.0.0.0` reports a loopback-bound service as FREE on Windows: binding the
 * wildcard address while another process holds `127.0.0.1:<port>` succeeds,
 * because they are different addresses. That is not an edge case — it is the
 * DEFAULT for development servers. Vite, Next, and this project's own API all
 * bind loopback, so a wildcard-only probe would confidently hand out a port
 * something was already serving on.
 *
 *     $ ports check 4711        # the Core Service is listening RIGHT NOW
 *       Listening:  nothing     # ...said the wildcard-only probe
 *
 * Probing loopback alone has the mirror flaw: a service bound to 0.0.0.0 would
 * not be seen. So a port is free only when every address in this list is.
 */
export const PROBE_HOSTS = Object.freeze(['0.0.0.0', '127.0.0.1']);

/** One bind attempt. True when this process could take the port on that host. */
function canBind(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      server.removeAllListeners();
      if (server.listening) server.close(() => resolve(value));
      else resolve(value);
    };
    const timer = setTimeout(() => settle(false), PROBE_TIMEOUT_MS);
    timer.unref?.();

    server.once('error', () => { clearTimeout(timer); settle(false); });
    server.once('listening', () => { clearTimeout(timer); settle(true); });
    try {
      server.listen({ port, host, exclusive: true });
    } catch {
      clearTimeout(timer);
      settle(false);
    }
  });
}

/**
 * Is this port bindable right now, on every interface that matters?
 *
 * `EADDRINUSE` means someone is listening; `EACCES` means the OS refuses this
 * process the port (privileged, or a Hyper-V/WSL exclusion range) — both are
 * "not available to us", which is the question actually being asked.
 *
 * @param {number} port
 * @param {{hosts?: string[]}} [options]
 * @returns {Promise<boolean>}
 */
export async function isPortFree(port, { hosts = PROBE_HOSTS } = {}) {
  const results = await Promise.all(hosts.map((host) => canBind(port, host)));
  return results.every(Boolean);
}

/**
 * FNV-1a, 32-bit. A hash rather than a counter so the answer is stable across
 * machines and survives the registry file being deleted — the property that
 * lets a project ask for its port without ever having registered.
 */
export function hashKey(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** The port a given project/service prefers, before availability is considered. */
export function preferredPort(project, service, range = DEFAULT_RANGE) {
  const span = range.end - range.start + 1;
  return range.start + (hashKey(`${project}:${service}`) % span);
}

export class PortRegistry {
  /**
   * @param {object} options
   * @param {string} options.reservationsFile - config/ports.json (human-owned).
   * @param {string} options.allocationsFile - state/ports.json (machine-owned).
   * @param {{start: number, end: number}} [options.range]
   * @param {(port: number) => Promise<boolean>} [options.probe] - Injectable (tests).
   * @param {object} [options.logger]
   */
  constructor({ reservationsFile, allocationsFile, range, probe, logger } = {}) {
    this.reservationsFile = reservationsFile;
    this.allocationsFile = allocationsFile;
    this.range = range ?? DEFAULT_RANGE;
    this.probe = probe ?? isPortFree;
    this.logger = logger;
  }

  // ------------------------------------------------------------- storage --

  /** Human-written permanent reservations. Never modified without an explicit call. */
  reservations() {
    const data = readJsonSafe(this.reservationsFile, { logger: this.logger });
    return Array.isArray(data?.reservations) ? data.reservations : [];
  }

  /** Machine-owned dynamic allocations. */
  allocations() {
    const data = readJsonSafe(this.allocationsFile, { logger: this.logger });
    return Array.isArray(data?.allocations) ? data.allocations : [];
  }

  writeReservations(reservations) {
    fs.mkdirSync(path.dirname(this.reservationsFile), { recursive: true });
    writeJsonAtomic(this.reservationsFile, {
      $comment:
        'Permanent port reservations. Hand-edited and safe to commit: these are ports that ' +
        'something outside this machine expects to find a service on. Dynamic allocations live ' +
        'in state/ports.json and are machine-owned — do not put them here.',
      reservations,
    });
  }

  writeAllocations(allocations) {
    fs.mkdirSync(path.dirname(this.allocationsFile), { recursive: true });
    writeJsonAtomic(this.allocationsFile, { allocations, updatedAt: new Date().toISOString() });
  }

  // -------------------------------------------------------------- lookup --

  /** Every entry, reservations first — they win every conflict. */
  entries() {
    return [
      ...this.reservations().map((r) => ({ ...r, kind: 'reserved' })),
      ...this.allocations().map((a) => ({ ...a, kind: 'allocated' })),
    ];
  }

  /** The registry's own record for one project/service, or null. */
  find(project, service = 'default') {
    return this.entries().find((e) => e.project === project && e.service === service) ?? null;
  }

  /**
   * Who does the registry believe holds this port? Null when nobody does —
   * which is NOT the same as the port being free (see `inspect`).
   */
  holderOf(port) {
    return this.entries().find((e) => e.port === Number(port)) ?? null;
  }

  /**
   * The honest, complete answer about one port: what the registry thinks, and
   * what the operating system says. They disagree more often than anyone
   * expects, and every real conflict lives in that gap.
   *
   * @returns {Promise<{port: number, free: boolean, holder: object|null, conflict: boolean}>}
   */
  async inspect(port) {
    const number = Number(port);
    const [free, holder] = await Promise.all([this.probe(number), this.holderOf(number)]);
    return {
      port: number,
      free,
      holder,
      // Registered to a project, but something else already has it. This is the
      // case worth naming: the project will fail to start and the error will
      // blame a port number rather than the process holding it.
      conflict: Boolean(holder) && !free,
    };
  }

  // ----------------------------------------------------------- reserving --

  /**
   * Permanently reserve a port. Fails rather than overwriting when another
   * project already reserved it — a reservation silently reassigned is worse
   * than one refused, because the displaced project fails somewhere else.
   *
   * @param {object} params
   * @param {string} params.project
   * @param {string} [params.service]
   * @param {number} params.port
   * @param {string} [params.note] - Why this port specifically.
   * @param {boolean} [params.force] - Replace this project's own reservation.
   * @returns {Promise<{ok: boolean, entry?: object, reason?: string}>}
   */
  async reserve({ project, service = 'default', port, note, force = false }) {
    const number = Number(port);
    if (!Number.isInteger(number) || number < 1 || number > 65_535) {
      return { ok: false, reason: `${port} is not a valid port number.` };
    }

    const holder = this.holderOf(number);
    if (holder && !(holder.project === project && holder.service === service)) {
      return {
        ok: false,
        reason: `Port ${number} is already ${holder.kind} by ${holder.project}/${holder.service}.`,
      };
    }

    const existing = this.find(project, service);
    if (existing && existing.port !== number && !force) {
      return {
        ok: false,
        reason: `${project}/${service} already has port ${existing.port}. Pass force to move it.`,
      };
    }

    // Reserved but occupied is allowed — the point of a reservation is to hold
    // the number even when the service is down. The occupant is REPORTED so
    // the operator can act, rather than silently accepted or silently refused.
    const probe = await this.inspect(number);

    const reservations = this.reservations()
      .filter((r) => !(r.project === project && r.service === service));
    const entry = {
      project,
      service,
      port: number,
      note: note ?? null,
      reservedAt: new Date().toISOString(),
    };
    reservations.push(entry);
    this.writeReservations(reservations);

    // Drop any dynamic allocation this supersedes.
    const allocations = this.allocations()
      .filter((a) => !(a.project === project && a.service === service));
    this.writeAllocations(allocations);

    return {
      ok: true,
      entry: { ...entry, kind: 'reserved' },
      occupiedByOther: !probe.free,
    };
  }

  // ---------------------------------------------------------- allocating --

  /**
   * The port this project/service should use — allocating one if it has none.
   *
   * Idempotent by design: calling it on every start is the intended usage, and
   * a service that asks twice must get the same answer both times. An existing
   * reservation or allocation is returned as-is unless the port has since been
   * taken by something else, in which case a NEW one is allocated and the move
   * is reported rather than hidden.
   *
   * @param {object} params
   * @param {string} params.project
   * @param {string} [params.service] - 'web', 'api', 'devserver', …
   * @param {number} [params.preferred] - Try this first (a project's own default).
   * @returns {Promise<{ok: boolean, port?: number, kind?: string, moved?: boolean, reason?: string}>}
   */
  async acquire({ project, service = 'default', preferred } = {}) {
    if (!project) return { ok: false, reason: 'A project name is required.' };

    const existing = this.find(project, service);
    if (existing) {
      const probe = await this.inspect(existing.port);
      // Free, or occupied by this very service on a previous run — either way
      // it is still theirs.
      if (probe.free || existing.kind === 'reserved') {
        return { ok: true, port: existing.port, kind: existing.kind, moved: false };
      }
      this.logger?.warn?.('Allocated port is occupied by something else; reallocating', {
        project, service, port: existing.port,
      });
    }

    const candidates = this.candidateOrder({ project, service, preferred });
    for (const candidate of candidates) {
      if (this.holderOf(candidate)) continue; // spoken for by another project
      // eslint-disable-next-line no-await-in-loop
      if (!(await this.probe(candidate))) continue; // something is listening
      const entry = {
        project, service, port: candidate, allocatedAt: new Date().toISOString(),
      };
      const allocations = this.allocations()
        .filter((a) => !(a.project === project && a.service === service));
      allocations.push(entry);
      this.writeAllocations(allocations);
      return {
        ok: true,
        port: candidate,
        kind: 'allocated',
        moved: Boolean(existing) && existing.port !== candidate,
        previousPort: existing?.port ?? null,
      };
    }

    return {
      ok: false,
      reason:
        `No free port in ${this.range.start}-${this.range.end}. ` +
        'Widen "ports.range" in config/orchestrator.json, or release something with "ports release".',
    };
  }

  /**
   * Ports to try, in order: the caller's preference, then the deterministic
   * one, then a linear walk of the whole range from there. The walk wraps, so
   * a range is fully explored regardless of where the hash landed.
   */
  candidateOrder({ project, service, preferred }) {
    const span = this.range.end - this.range.start + 1;
    const start = preferredPort(project, service, this.range);
    const order = [];
    if (Number.isInteger(preferred) && preferred >= 1 && preferred <= 65_535) {
      order.push(preferred);
    }
    for (let i = 0; i < span; i += 1) {
      const port = this.range.start + (((start - this.range.start) + i) % span);
      if (!NEVER_ALLOCATE.includes(port)) order.push(port);
    }
    return [...new Set(order)];
  }

  /**
   * Give a port back. Reservations are only released with `includeReserved`,
   * because a reservation exists precisely so that a service being down does
   * not surrender its number.
   */
  release({ project, service = 'default', includeReserved = false }) {
    const before = this.allocations();
    const allocations = before.filter((a) => !(a.project === project && a.service === service));
    let removed = before.length - allocations.length;
    if (removed) this.writeAllocations(allocations);

    if (includeReserved) {
      const wasReserved = this.reservations();
      const reservations = wasReserved.filter(
        (r) => !(r.project === project && r.service === service)
      );
      if (reservations.length !== wasReserved.length) {
        this.writeReservations(reservations);
        removed += wasReserved.length - reservations.length;
      }
    }
    return { ok: removed > 0, removed };
  }

  /**
   * The whole picture, with the OS consulted for every entry — the view that
   * answers "why will my app not start?" in one command.
   *
   * @returns {Promise<object[]>}
   */
  async report() {
    const entries = this.entries();
    const probed = await Promise.all(entries.map(async (entry) => ({
      ...entry,
      inUse: !(await this.probe(entry.port)),
    })));
    return probed
      .map((entry) => ({
        ...entry,
        // Reserved + in use is normal (the service is running). Allocated +
        // in use is also normal. The pathological case is a port held by the
        // registry for one project while a DIFFERENT process listens on it,
        // which nothing here can distinguish without OS-level ownership — so
        // this reports the facts and does not speculate about the culprit.
        status: entry.inUse ? 'in-use' : 'free',
      }))
      .sort((a, b) => a.port - b.port);
  }
}

export default PortRegistry;
