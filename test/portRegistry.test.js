/**
 * portRegistry.test.js — Phase 12 M2.1: no two projects on one port.
 *
 * The probe is injected in almost every test. Binding real sockets would make
 * the suite depend on which ports happen to be free on the machine running it,
 * which is exactly the non-determinism this module exists to remove. One test
 * at the end exercises the REAL probe, because a fake that never meets the
 * kernel proves nothing about the kernel.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import {
  PortRegistry, isPortFree, preferredPort, hashKey, DEFAULT_RANGE, NEVER_ALLOCATE,
} from '../src/runtime/portRegistry.js';

/** A registry over a throwaway directory. `busy` lists ports the fake OS holds. */
function registry({ busy = [], range } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-ports-'));
  const taken = new Set(busy);
  const reg = new PortRegistry({
    reservationsFile: path.join(root, 'config', 'ports.json'),
    allocationsFile: path.join(root, 'state', 'ports.json'),
    range,
    probe: async (port) => !taken.has(port),
  });
  return { reg, root, taken };
}

// ────────────────────────────────────────────────────────── determinism ─────

test('a project/service always prefers the same port, on every machine and every run', () => {
  const first = preferredPort('THE FINISHER', 'web');
  const second = preferredPort('THE FINISHER', 'web');
  assert.equal(first, second);
  assert.ok(first >= DEFAULT_RANGE.start && first <= DEFAULT_RANGE.end);

  assert.notEqual(
    preferredPort('THE FINISHER', 'web'),
    preferredPort('THE FINISHER', 'api'),
    'two services of one project must not collide with each other'
  );
});

test('the hash is stable — changing it would move every unregistered project at once', () => {
  // Pinned so a future "improvement" to the hash cannot silently reassign every
  // port on every machine that had not written an allocation down yet.
  assert.equal(hashKey(''), 0x811c9dc5);
  assert.equal(hashKey('a'), 0xe40c292c);
});

test('an allocation is remembered, and asking twice gives the same port', async () => {
  const { reg } = registry();

  const first = await reg.acquire({ project: 'alpha', service: 'web' });
  const second = await reg.acquire({ project: 'alpha', service: 'web' });

  assert.equal(first.ok, true);
  assert.equal(second.port, first.port, 'asking on every start is the intended usage');
  assert.equal(second.moved, false);
});

// ─────────────────────────────────────────────────────────── conflicts ──────

test('a port another project holds is never handed out', async () => {
  const { reg } = registry();
  const alphaPort = (await reg.acquire({ project: 'alpha', service: 'web' })).port;

  const beta = await reg.reserve({ project: 'beta', service: 'web', port: alphaPort });

  assert.equal(beta.ok, false);
  assert.match(beta.reason, /already allocated by alpha\/web/);
});

test('allocation skips ports the operating system says are busy', async () => {
  const wanted = preferredPort('alpha', 'web');
  const { reg } = registry({ busy: [wanted] });

  const result = await reg.acquire({ project: 'alpha', service: 'web' });

  assert.equal(result.ok, true);
  assert.notEqual(result.port, wanted, 'the kernel outranks the hash');
});

test('a preferred port is honoured when free and quietly stepped over when not', async () => {
  const free = registry();
  const chosen = await free.reg.acquire({ project: 'alpha', service: 'web', preferred: 5250 });
  assert.equal(chosen.port, 5250);

  const busy = registry({ busy: [5250] });
  const fallback = await busy.reg.acquire({ project: 'alpha', service: 'web', preferred: 5250 });
  assert.equal(fallback.ok, true);
  assert.notEqual(fallback.port, 5250);
});

test('an allocation stolen by another process moves, and reports that it moved', async () => {
  const { reg, taken } = registry();
  const original = (await reg.acquire({ project: 'alpha', service: 'web' })).port;

  // Something else grabs it while the project was not running.
  taken.add(original);
  const again = await reg.acquire({ project: 'alpha', service: 'web' });

  assert.equal(again.ok, true);
  assert.notEqual(again.port, original);
  assert.equal(again.moved, true, 'a silent move is a debugging session nobody asked for');
  assert.equal(again.previousPort, original);
});

test('a full range fails loudly instead of returning a port it could not verify', async () => {
  const range = { start: 5200, end: 5202 };
  const { reg } = registry({ busy: [5200, 5201, 5202], range });

  const result = await reg.acquire({ project: 'alpha', service: 'web' });

  assert.equal(result.ok, false);
  assert.match(result.reason, /No free port in 5200-5202/);
});

test('never-allocate ports are skipped even when they fall inside the range', async () => {
  const range = { start: 5430, end: 5434 };
  const { reg } = registry({ range });

  const ports = new Set();
  for (const project of ['a', 'b', 'c', 'd', 'e']) {
    // eslint-disable-next-line no-await-in-loop
    const result = await reg.acquire({ project, service: 'web' });
    if (result.ok) ports.add(result.port);
  }

  assert.ok(NEVER_ALLOCATE.includes(5432));
  assert.equal(ports.has(5432), false, 'PostgreSQL must never be handed a dev server');
});

// ────────────────────────────────────────────────────────── reserving ───────

test('a reservation survives the service being down, and outranks allocation', async () => {
  const { reg } = registry();

  const reserved = await reg.reserve({
    project: 'THE FINISHER', service: 'web', port: 5173, note: 'external callers expect this',
  });
  assert.equal(reserved.ok, true);
  assert.equal(reserved.entry.kind, 'reserved');

  const acquired = await reg.acquire({ project: 'THE FINISHER', service: 'web' });
  assert.equal(acquired.port, 5173);
  assert.equal(acquired.kind, 'reserved');
});

test('a reserved port stays reserved even while something else occupies it', async () => {
  const { reg } = registry({ busy: [5173] });

  const result = await reg.reserve({ project: 'THE FINISHER', service: 'web', port: 5173 });

  assert.equal(result.ok, true, 'holding the number is the entire point of a reservation');
  assert.equal(result.occupiedByOther, true, 'but the operator is told, not left to guess');
});

test('moving a project to a different reserved port needs force', async () => {
  const { reg } = registry();
  await reg.reserve({ project: 'alpha', service: 'web', port: 5300 });

  const blocked = await reg.reserve({ project: 'alpha', service: 'web', port: 5301 });
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /already has port 5300/);

  const forced = await reg.reserve({ project: 'alpha', service: 'web', port: 5301, force: true });
  assert.equal(forced.ok, true);
  assert.equal(reg.find('alpha', 'web').port, 5301);
  assert.equal(reg.holderOf(5300), null, 'the old reservation is gone, not duplicated');
});

test('an invalid port is refused rather than stored', async () => {
  const { reg } = registry();
  for (const port of [0, -1, 70_000, 'http']) {
    // eslint-disable-next-line no-await-in-loop
    const result = await reg.reserve({ project: 'alpha', port });
    assert.equal(result.ok, false, `${port} must be refused`);
  }
});

// ──────────────────────────────────────────────────────────── release ───────

test('release frees an allocation but leaves a reservation alone unless asked', async () => {
  const { reg } = registry();
  await reg.acquire({ project: 'alpha', service: 'web' });
  await reg.reserve({ project: 'beta', service: 'web', port: 5311 });

  assert.equal(reg.release({ project: 'alpha', service: 'web' }).removed, 1);
  assert.equal(reg.find('alpha', 'web'), null);

  assert.equal(reg.release({ project: 'beta', service: 'web' }).removed, 0,
    'a reservation exists so that a stopped service keeps its number');
  assert.equal(reg.find('beta', 'web').port, 5311);

  assert.equal(reg.release({ project: 'beta', service: 'web', includeReserved: true }).removed, 1);
  assert.equal(reg.find('beta', 'web'), null);
});

// ───────────────────────────────────────────────────────────── report ───────

test('inspect distinguishes "nobody registered it" from "nothing is listening"', async () => {
  const { reg } = registry({ busy: [5400] });
  await reg.reserve({ project: 'alpha', service: 'web', port: 5401 });

  const squatted = await reg.inspect(5400);
  assert.equal(squatted.free, false);
  assert.equal(squatted.holder, null, 'in use by something this registry knows nothing about');
  assert.equal(squatted.conflict, false);

  const registered = await reg.inspect(5401);
  assert.equal(registered.free, true);
  assert.equal(registered.holder.project, 'alpha');
});

test('a registered port occupied by something else is reported as a conflict', async () => {
  const { reg, taken } = registry();
  await reg.reserve({ project: 'alpha', service: 'web', port: 5402 });
  taken.add(5402);

  const result = await reg.inspect(5402);

  assert.equal(result.conflict, true,
    'the project will fail to start, and EADDRINUSE will name a number rather than a culprit');
});

test('the report lists everything, port-ordered, with live in-use state', async () => {
  const { reg, taken } = registry();
  await reg.reserve({ project: 'zeta', service: 'web', port: 5320 });
  await reg.reserve({ project: 'alpha', service: 'web', port: 5310 });
  taken.add(5320);

  const report = await reg.report();

  assert.deepEqual(report.map((r) => r.port), [5310, 5320], 'ordered by port, not insertion');
  assert.equal(report[0].status, 'free');
  assert.equal(report[1].status, 'in-use');
  assert.equal(report[1].kind, 'reserved');
});

// ───────────────────────────────────────────────── the real kernel probe ────

test('isPortFree agrees with the kernel about a port bound on all interfaces', async () => {
  const server = net.createServer();
  await new Promise((resolve) => { server.listen(0, '0.0.0.0', resolve); });
  const { port } = server.address();

  try {
    assert.equal(await isPortFree(port), false, 'a bound port must never probe free');
  } finally {
    await new Promise((resolve) => { server.close(resolve); });
  }

  // And free again once released — the probe must not cache.
  assert.equal(await isPortFree(port), true);
});

test('a LOOPBACK-bound service is detected — the default for dev servers', async () => {
  // Regression for a false negative found in live validation on 2026-07-28.
  // The probe bound only 0.0.0.0, and on Windows that SUCCEEDS while another
  // process holds 127.0.0.1:<port> — so `ports check 4711` reported "nothing
  // listening" while this project's own API was serving on it. Vite, Next and
  // most dev servers bind loopback, making this the common case, not an edge.
  const server = net.createServer();
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();

  try {
    assert.equal(
      await isPortFree(port), false,
      'a loopback-bound port must not be handed out as free'
    );
  } finally {
    await new Promise((resolve) => { server.close(resolve); });
  }
});
