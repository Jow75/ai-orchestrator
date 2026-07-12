/**
 * smtpClient.js — Phase 10C: a minimal, dependency-free SMTP client.
 *
 * This project deliberately avoids new dependencies; SMTP is a simple
 * line protocol, so the long-promised email channel (ROADMAP "carried over
 * from v1.x") is implemented directly on `node:net`/`node:tls`:
 *
 *   - implicit TLS (`secure: true`, typically port 465), or
 *   - STARTTLS upgrade (`starttls: true`, typically port 587), or
 *   - plaintext (local relays only — not recommended)
 *   - AUTH PLAIN / AUTH LOGIN when `user`/`pass` are configured
 *
 * Scope is deliberately bounded: send one text email to one or more
 * recipients. No HTML alternatives, attachments, or connection pooling —
 * notifications and approval requests need none of that.
 */

import net from 'node:net';
import tls from 'node:tls';

/** Abort a silent/hung SMTP conversation after this long. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Send one email.
 *
 * @param {object} params
 * @param {string} params.host - SMTP server hostname.
 * @param {number} [params.port] - Defaults: 465 when secure, else 587.
 * @param {boolean} [params.secure] - Implicit TLS from the first byte.
 * @param {boolean} [params.starttls] - Upgrade via STARTTLS (default true
 *   when not secure).
 * @param {string} [params.user] - AUTH username (with `pass` enables auth).
 * @param {string} [params.pass] - AUTH password.
 * @param {string} params.from - Envelope sender + From header.
 * @param {string|string[]} params.to - Recipient(s).
 * @param {string} params.subject
 * @param {string} params.text - Plain-text body.
 * @param {number} [params.timeoutMs]
 * @returns {Promise<void>} Resolves once the server accepts the message.
 */
export async function sendMail({
  host, port, secure = false, starttls = !secure, user, pass,
  from, to, subject, text, timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!host) throw new Error('smtp: "host" is required');
  if (!from) throw new Error('smtp: "from" is required');
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!recipients.length) throw new Error('smtp: at least one "to" recipient is required');

  const session = new SmtpSession({ host, port: port ?? (secure ? 465 : 587), secure, timeoutMs });
  try {
    await session.connect();
    await session.expect(220); // greeting
    let features = await session.ehlo();

    if (!secure && starttls) {
      if (!/\bSTARTTLS\b/i.test(features)) {
        throw new Error('smtp: server does not offer STARTTLS (set starttls:false only for trusted local relays)');
      }
      await session.command('STARTTLS', 220);
      await session.upgradeToTls();
      features = await session.ehlo(); // capabilities reset after upgrade
    }

    if (user && pass) {
      if (/\bAUTH\b[^\n]*\bPLAIN\b/i.test(features)) {
        const token = Buffer.from(`\u0000${user}\u0000${pass}`, 'utf8').toString('base64');
        await session.command(`AUTH PLAIN ${token}`, 235);
      } else {
        await session.command('AUTH LOGIN', 334);
        await session.command(Buffer.from(user, 'utf8').toString('base64'), 334);
        await session.command(Buffer.from(pass, 'utf8').toString('base64'), 235);
      }
    }

    await session.command(`MAIL FROM:<${from}>`, 250);
    for (const recipient of recipients) {
      // eslint-disable-next-line no-await-in-loop
      await session.command(`RCPT TO:<${recipient}>`, [250, 251]);
    }
    await session.command('DATA', 354);
    await session.command(buildMessage({ from, to: recipients, subject, text }), 250);
    await session.command('QUIT', 221).catch(() => {}); // best-effort goodbye
  } finally {
    session.destroy();
  }
}

/** RFC-5322-enough message with dot-stuffing and CRLF line endings. */
function buildMessage({ from, to, subject, text }) {
  const headers = [
    `From: ${from}`,
    `To: ${to.join(', ')}`,
    `Subject: ${sanitizeHeader(subject ?? '')}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
  ];
  const body = (text ?? '')
    .split(/\r?\n/)
    .map((line) => (line.startsWith('.') ? `.${line}` : line)) // dot-stuffing
    .join('\r\n');
  return `${headers.join('\r\n')}\r\n\r\n${body}\r\n.`;
}

/** Strip CR/LF from header values (header-injection guard). */
function sanitizeHeader(value) {
  return value.replace(/[\r\n]+/g, ' ');
}

/**
 * One SMTP conversation: line-buffered reads, multi-line reply handling
 * ("250-…" continuation lines until "250 …"), command/expect helpers, and
 * an in-place TLS upgrade for STARTTLS.
 */
class SmtpSession {
  constructor({ host, port, secure, timeoutMs }) {
    this.host = host;
    this.port = port;
    this.secure = secure;
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.buffer = '';
    this.waiter = null; // {resolve, reject} for the reply currently awaited
  }

  connect() {
    return new Promise((resolve, reject) => {
      const onError = (error) => reject(new Error(`smtp: connection failed — ${error.message}`));
      this.socket = this.secure
        ? tls.connect({ host: this.host, port: this.port, servername: this.host }, resolve)
        : net.connect({ host: this.host, port: this.port }, resolve);
      this.socket.setTimeout(this.timeoutMs, () => {
        this.fail(new Error('smtp: connection timed out'));
      });
      this.socket.once('error', onError);
      this.socket.on('data', (chunk) => this.onData(chunk));
      this.socket.once('connect', () => this.socket.removeListener('error', onError));
      this.socket.once('secureConnect', () => this.socket.removeListener('error', onError));
    });
  }

  /** Re-wrap the plaintext socket in TLS after STARTTLS was accepted. */
  upgradeToTls() {
    return new Promise((resolve, reject) => {
      const plain = this.socket;
      plain.removeAllListeners('data');
      plain.setTimeout(0);
      this.socket = tls.connect(
        { socket: plain, servername: this.host },
        () => resolve()
      );
      this.socket.setTimeout(this.timeoutMs, () => this.fail(new Error('smtp: TLS upgrade timed out')));
      this.socket.once('error', (error) => reject(new Error(`smtp: TLS upgrade failed — ${error.message}`)));
      this.socket.on('data', (chunk) => this.onData(chunk));
      this.buffer = '';
    });
  }

  onData(chunk) {
    this.buffer += chunk.toString('utf8');
    // A complete reply ends with a "NNN " (space, not dash) final line.
    const lines = this.buffer.split(/\r?\n/);
    for (const line of lines) {
      if (/^\d{3} /.test(line)) {
        const reply = this.buffer;
        this.buffer = '';
        const code = Number(line.slice(0, 3));
        this.waiter?.resolve({ code, reply });
        this.waiter = null;
        return;
      }
    }
  }

  /** Wait for the next complete server reply. */
  read() {
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  fail(error) {
    this.waiter?.reject(error);
    this.waiter = null;
    this.destroy();
  }

  /** Wait for a reply and assert its status code. */
  async expect(codes) {
    const allowed = Array.isArray(codes) ? codes : [codes];
    const { code, reply } = await this.read();
    if (!allowed.includes(code)) {
      throw new Error(`smtp: expected ${allowed.join('/')}, got: ${reply.trim().split('\n')[0]}`);
    }
    return reply;
  }

  /** Send one command and assert the reply code. */
  async command(line, codes) {
    this.socket.write(`${line}\r\n`);
    return this.expect(codes);
  }

  /** EHLO (with HELO fallback); returns the capability listing. */
  async ehlo() {
    try {
      return await this.command('EHLO ai-orchestrator', 250);
    } catch {
      return this.command('HELO ai-orchestrator', 250);
    }
  }

  destroy() {
    try {
      this.socket?.destroy();
    } catch {
      // Already gone — nothing to release.
    }
  }
}

export default { sendMail };
