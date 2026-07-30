/**
 * Tests for drivers/nvidiaDriver.js — the optional fallback text-completion
 * driver added alongside the Phase 14 planning pass. Uses the same injected
 * `fetchFn` pattern notifications/channels/telegram.js is already tested
 * with, rather than a real network call.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NvidiaDriver } from '../src/drivers/nvidiaDriver.js';
import { silentLogger } from '../src/infra/logger.js';

/** A fake fetch that records calls and returns a scripted response. */
function fakeFetch({ ok = true, status = 200, content = 'hello', errorBody = '' } = {}) {
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url, options });
    return {
      ok,
      status,
      json: async () => ({ choices: [{ message: { content } }] }),
      text: async () => errorBody,
    };
  };
  return { fetchFn, calls };
}

function driver({ config = { apiKey: 'nv-key' }, fetch: fetchOverrides } = {}) {
  const { fetchFn, calls } = fakeFetch(fetchOverrides);
  const d = new NvidiaDriver({
    logger: silentLogger,
    nvidiaConfigProvider: () => config,
    fetchFn,
  });
  return { driver: d, calls };
}

test('checkInstallation reports unconfigured when no apiKey is set', async () => {
  const { driver: d } = driver({ config: {} });
  const result = await d.checkInstallation();
  assert.equal(result.ok, false);
  assert.match(result.error, /No NVIDIA API key configured/);
});

test('checkInstallation reports ok when an apiKey is configured', async () => {
  const { driver: d } = driver();
  const result = await d.checkInstallation();
  assert.equal(result.ok, true);
});

test('launch() throws a clear error with no apiKey configured', async () => {
  const { driver: d } = driver({ config: {} });
  await assert.rejects(
    () => d.launch({ project: { name: 'demo' }, prompt: 'hi' }),
    /needs an API key/
  );
});

test('launch() posts the prompt as a chat completion and emits the result', async () => {
  const { driver: d, calls } = driver({
    config: { apiKey: 'nv-key', baseUrl: 'https://integrate.api.nvidia.com/v1', model: 'nvidia/test-model' },
    fetch: { content: 'the answer is 42' },
  });

  const run = await d.launch({ project: { name: 'demo' }, prompt: 'what is the answer?' });

  const resultEvent = await new Promise((resolve) => run.on('result', resolve));
  const exit = await run.waitForExit();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://integrate.api.nvidia.com/v1/chat/completions');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer nv-key');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, 'nvidia/test-model');
  assert.equal(body.messages[0].content, 'what is the answer?');

  assert.equal(resultEvent.text, 'the answer is 42');
  assert.equal(resultEvent.isError, false);
  assert.equal(exit.code, 0);
  assert.equal(exit.resultText, 'the answer is 42');
});

test('a project-level nvidia.model override wins over the global default', async () => {
  const { driver: d, calls } = driver({
    config: { apiKey: 'nv-key', model: 'nvidia/global-default' },
  });
  await d.launch({ project: { name: 'demo', nvidia: { model: 'nvidia/per-project' } }, prompt: 'hi' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(JSON.parse(calls[0].options.body).model, 'nvidia/per-project');
});

test('a non-ok HTTP response finishes as an error without throwing', async () => {
  const { driver: d } = driver({ fetch: { ok: false, status: 429, errorBody: 'rate limited' } });
  const run = await d.launch({ project: { name: 'demo' }, prompt: 'hi' });
  const exit = await run.waitForExit();
  assert.equal(exit.resultIsError, true);
  assert.match(exit.outputTail, /NVIDIA API error 429/);
});

test('requestStop() aborts the in-flight request and finishes the run', async () => {
  const calls = [];
  const fetchFn = (url, options) => {
    calls.push(options);
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  };
  const d = new NvidiaDriver({
    logger: silentLogger,
    nvidiaConfigProvider: () => ({ apiKey: 'nv-key' }),
    fetchFn,
  });
  const run = await d.launch({ project: { name: 'demo' }, prompt: 'hi' });
  await run.requestStop('operator stop');
  const exit = await run.waitForExit();
  assert.equal(exit.signal, 'SIGTERM');
});
