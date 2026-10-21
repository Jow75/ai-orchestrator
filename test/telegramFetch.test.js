import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import EventEmitter from 'node:events';
import {
  telegramFetch,
  getTelegramAgent,
  resetTelegramAgent,
  sanitizeTelegramString,
} from '../src/infra/telegramFetch.js';

afterEach(() => {
  resetTelegramAgent();
});

test('sanitizeTelegramString masks bot tokens in URLs and strings', () => {
  const raw = 'https://api.telegram.org/bot123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11/getMe';
  const sanitized = sanitizeTelegramString(raw);
  assert.equal(sanitized, 'https://api.telegram.org/bot[REDACTED]/getMe');
  assert.equal(sanitizeTelegramString('normal error message'), 'normal error message');
});

test('getTelegramAgent returns an https.Agent with keepAlive and IPv4 family', () => {
  const agent = getTelegramAgent();
  assert.ok(agent instanceof https.Agent);
  assert.equal(agent.options.keepAlive, true);
  assert.equal(agent.options.family, 4);
});

test('resetTelegramAgent destroys and cleans up the shared agent', () => {
  const agent1 = getTelegramAgent();
  resetTelegramAgent();
  const agent2 = getTelegramAgent();
  assert.notEqual(agent1, agent2);
});

test('telegramFetch formats GET request and parses JSON response', async () => {
  const origRequest = https.request;
  try {
    let capturedOptions;
    let capturedUrl;
    https.request = (url, options, callback) => {
      capturedUrl = url;
      capturedOptions = options;
      const req = new EventEmitter();
      req.destroy = () => {};
      req.write = () => {};
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = 200;
        res.statusMessage = 'OK';
        res.headers = { 'content-type': 'application/json' };
        callback(res);
        res.emit('data', Buffer.from(JSON.stringify({ ok: true, result: { id: 42 } })));
        res.emit('end');
      };
      return req;
    };

    const res = await telegramFetch('https://api.telegram.org/botTOKEN/getMe');
    assert.equal(res.ok, true);
    assert.equal(res.status, 200);
    assert.equal(res.statusText, 'OK');
    const data = await res.json();
    assert.deepEqual(data, { ok: true, result: { id: 42 } });
    assert.equal(capturedOptions.family, 4);
    assert.equal(capturedUrl, 'https://api.telegram.org/botTOKEN/getMe');
  } finally {
    https.request = origRequest;
  }
});

test('telegramFetch posts string body and handles headers', async () => {
  const origRequest = https.request;
  try {
    let written = '';
    let capturedHeaders;
    https.request = (url, options, callback) => {
      capturedHeaders = options.headers;
      const req = new EventEmitter();
      req.destroy = () => {};
      req.write = (chunk) => { written += chunk.toString(); };
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = 200;
        res.statusMessage = 'OK';
        res.headers = {};
        callback(res);
        res.emit('data', Buffer.from('{"ok":true}'));
        res.emit('end');
      };
      return req;
    };

    const bodyText = JSON.stringify({ chat_id: 123, text: 'hello' });
    const res = await telegramFetch('https://api.telegram.org/botTOKEN/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bodyText,
    });
    assert.equal(res.ok, true);
    assert.equal(written, bodyText);
    assert.equal(capturedHeaders['content-type'], 'application/json');
    assert.equal(capturedHeaders['content-length'], String(Buffer.byteLength(bodyText)));
  } finally {
    https.request = origRequest;
  }
});

test('telegramFetch handles FormData bodies and sets content-type', async () => {
  const origRequest = https.request;
  try {
    let capturedHeaders;
    let writtenBytes = 0;
    https.request = (url, options, callback) => {
      capturedHeaders = options.headers;
      const req = new EventEmitter();
      req.destroy = () => {};
      req.write = (chunk) => { writtenBytes += chunk.length; };
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = 200;
        res.headers = {};
        callback(res);
        res.emit('data', Buffer.from('{"ok":true}'));
        res.emit('end');
      };
      return req;
    };

    const form = new FormData();
    form.append('chat_id', '12345');
    form.append('text', 'message with form data');

    const res = await telegramFetch('https://api.telegram.org/botTOKEN/sendMessage', {
      method: 'POST',
      body: form,
    });
    assert.equal(res.ok, true);
    assert.ok(capturedHeaders['content-type'].includes('multipart/form-data'));
    assert.ok(writtenBytes > 0);
  } finally {
    https.request = origRequest;
  }
});

test('telegramFetch redacts bot token on network errors', async () => {
  const origRequest = https.request;
  try {
    https.request = () => {
      const req = new EventEmitter();
      req.end = () => {
        process.nextTick(() => {
          req.emit('error', new Error('connect ETIMEDOUT https://api.telegram.org/bot123456:SECRET_KEY_HERE/getMe'));
        });
      };
      return req;
    };

    await assert.rejects(
      () => telegramFetch('https://api.telegram.org/bot123456:SECRET_KEY_HERE/getMe'),
      (err) => {
        assert.ok(err.message.includes('/bot[REDACTED]/getMe'));
        assert.ok(!err.message.includes('SECRET_KEY_HERE'));
        return true;
      }
    );
  } finally {
    https.request = origRequest;
  }
});

test('telegramFetch aborts on AbortSignal', async () => {
  const origRequest = https.request;
  try {
    let destroyed = false;
    https.request = () => {
      const req = new EventEmitter();
      req.destroy = (err) => {
        destroyed = true;
        process.nextTick(() => req.emit('error', err));
      };
      req.end = () => {};
      return req;
    };

    const controller = new AbortController();
    const promise = telegramFetch('https://api.telegram.org/botTOKEN/getMe', {
      signal: controller.signal,
    });
    controller.abort();

    await assert.rejects(promise);
    assert.equal(destroyed, true);
  } finally {
    https.request = origRequest;
  }
});
