/**
 * src/infra/telegramFetch.js — Resilient IPv4 transport for Telegram Bot API.
 *
 * Background:
 * On dual-stack Windows hosts where IPv6 routes may be unreachable or broken,
 * Node.js's built-in fetch (Undici) attempts IPv6 first and stalls on
 * api.telegram.org (which advertises both A and AAAA records), leading to
 * UND_ERR_CONNECT_TIMEOUT or AbortSignal timeouts.
 *
 * Furthermore, residential or cellular network paths to Telegram's European
 * data centers frequently drop initial TCP SYN packets, requiring 1-3
 * retransmissions (taking up to 16-17s) for cold connections.
 *
 * This module provides:
 * 1. An IPv4-enforced (family: 4) HTTPS agent with TCP keep-alive enabled,
 *    allowing subsequent polling/webhook calls to complete in ~150-250ms
 *    over the established connection rather than paying cold SYN costs.
 * 2. Automatic token redaction in any network error messages to prevent
 *    accidental secret leakage in logs or diagnostics.
 * 3. Full Web Fetch Response compatibility (status, ok, json(), text(),
 *    headers, FormData support) for seamless drop-in injection into
 *    TelegramApprovalProvider and TelegramChannel.
 */

import https from 'node:https';

let sharedAgent = null;

/**
 * Get or create the shared Telegram HTTPS agent with IPv4 and keep-alive.
 * @returns {https.Agent}
 */
export function getTelegramAgent() {
  if (!sharedAgent) {
    sharedAgent = new https.Agent({
      keepAlive: true,
      keepAliveMsecs: 60_000,
      maxSockets: 10,
      family: 4,
    });
  }
  return sharedAgent;
}

/**
 * Destroy the shared agent (useful in tests and teardowns).
 */
export function resetTelegramAgent() {
  if (sharedAgent) {
    sharedAgent.destroy();
    sharedAgent = null;
  }
}

/**
 * Mask bot tokens in URLs or error strings to prevent secret leakage.
 * @param {string} text
 * @returns {string}
 */
export function sanitizeTelegramString(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/\/bot[a-zA-Z0-9_\-:]+/g, '/bot[REDACTED]');
}

/**
 * Resilient fetch function specifically tailored for api.telegram.org.
 *
 * @param {string|URL} url
 * @param {object} [options]
 * @param {string} [options.method='GET']
 * @param {object|Headers} [options.headers]
 * @param {string|Buffer|FormData} [options.body]
 * @param {AbortSignal} [options.signal]
 * @param {https.Agent} [options.agent]
 * @param {number} [options.retries=2]
 * @returns {Promise<{ok: boolean, status: number, statusText: string, headers: Headers, text: () => Promise<string>, json: () => Promise<any>}>}
 */
export async function telegramFetch(url, options = {}) {
  const maxRetries = options.retries ?? 2;
  let lastErr = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (options.signal?.aborted) {
      const err = new Error(options.signal.reason?.message || 'The operation was aborted due to timeout');
      err.name = 'AbortError';
      throw err;
    }

    try {
      return await performSingleRequest(url, options);
    } catch (err) {
      lastErr = err;
      if (err.name === 'AbortError' || options.signal?.aborted) {
        throw err;
      }
      const isConnError = ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED'].includes(err.code) ||
                          (typeof err.message === 'string' && (err.message.includes('ETIMEDOUT') || err.message.includes('ECONNRESET')));
      if (!isConnError || attempt === maxRetries) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  throw lastErr;
}

async function performSingleRequest(url, options = {}) {
  const urlObj = typeof url === 'string' ? new URL(url) : url;
  const agent = options.agent ?? getTelegramAgent();

  const headers = {};
  if (options.headers) {
    if (typeof options.headers.forEach === 'function') {
      options.headers.forEach((val, key) => { headers[key.toLowerCase()] = val; });
    } else {
      for (const [key, val] of Object.entries(options.headers)) {
        headers[key.toLowerCase()] = val;
      }
    }
  }

  let bodyBuffer = null;
  if (options.body != null) {
    if (typeof FormData !== 'undefined' && options.body instanceof FormData) {
      const dummy = new Response(options.body);
      const ct = dummy.headers.get('content-type');
      if (ct) headers['content-type'] = ct;
      bodyBuffer = Buffer.from(await dummy.arrayBuffer());
    } else if (typeof options.body === 'string') {
      bodyBuffer = Buffer.from(options.body, 'utf8');
    } else if (Buffer.isBuffer(options.body)) {
      bodyBuffer = options.body;
    } else if (options.body instanceof Uint8Array) {
      bodyBuffer = Buffer.from(options.body.buffer, options.body.byteOffset, options.body.byteLength);
    }
  }

  if (bodyBuffer) {
    headers['content-length'] = String(bodyBuffer.length);
  }

  return new Promise((resolve, reject) => {
    const reqOptions = {
      method: options.method || 'GET',
      headers,
      agent,
      family: 4,
    };

    const cleanup = () => {
      clearTimeout(connectTimer);
      if (options.signal && abortListener) {
        options.signal.removeEventListener('abort', abortListener);
      }
    };

    const req = https.request(urlObj.toString(), reqOptions, (res) => {
      connected = true;
      clearTimeout(connectTimer);
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        cleanup();
        const rawText = Buffer.concat(chunks).toString('utf8');
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          statusText: res.statusMessage || '',
          headers: new Headers(res.headers),
          text: async () => rawText,
          json: async () => {
            try {
              return JSON.parse(rawText);
            } catch (err) {
              throw new Error(`Invalid JSON response: ${err.message}`);
            }
          },
        });
      });
    });

    let connected = false;
    const connectTimeoutMs = options.connectTimeoutMs ?? 7500;
    const connectTimer = setTimeout(() => {
      if (!connected) {
        const err = new Error('CONNECT_TIMEOUT');
        err.code = 'ETIMEDOUT';
        if (typeof req.destroy === 'function') {
          req.destroy(err);
        } else {
          req.emit('error', err);
        }
      }
    }, connectTimeoutMs);

    req.on('secureConnect', () => {
      connected = true;
      clearTimeout(connectTimer);
    });

    let abortListener = null;
    if (options.signal) {
      if (options.signal.aborted) {
        req.destroy(new Error(options.signal.reason?.message || 'The operation was aborted due to timeout'));
        return;
      }
      abortListener = () => {
        const err = new Error(options.signal.reason?.message || 'The operation was aborted due to timeout');
        err.name = 'AbortError';
        req.destroy(err);
      };
      options.signal.addEventListener('abort', abortListener, { once: true });
    }

    req.on('error', (err) => {
      cleanup();
      const sanitized = new Error(sanitizeTelegramString(err.message));
      sanitized.code = err.code;
      sanitized.name = err.name;
      reject(sanitized);
    });

    req.on('close', cleanup);

    if (bodyBuffer) {
      req.write(bodyBuffer);
    }
    req.end();
  });
}

export default telegramFetch;
