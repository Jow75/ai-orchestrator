/**
 * Unit tests for smtpClient.js — the dependency-free SMTP client, exercised
 * against an in-process fake SMTP server over plain TCP (the STARTTLS/TLS
 * upgrade paths share the same conversation logic; certificates in a unit
 * test would test Node, not this code).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { sendMail } from '../src/notifications/smtpClient.js';

/**
 * A minimal scripted SMTP server. Replies per command; records everything
 * the client sends. AUTH PLAIN accepted when `expectAuth` is set.
 */
function fakeSmtpServer({ expectAuth = false, failRcpt = false } = {}) {
  const received = { commands: [], data: null };
  let inData = false;
  let dataBuffer = '';

  const server = net.createServer((socket) => {
    socket.write('220 fake.test ESMTP\r\n');
    socket.on('data', (chunk) => {
      for (const line of chunk.toString('utf8').split('\r\n')) {
        if (line === '' && !inData) continue;
        if (inData) {
          if (line === '.') {
            inData = false;
            received.data = dataBuffer;
            socket.write('250 OK queued\r\n');
          } else {
            dataBuffer += `${line}\n`;
          }
          continue;
        }
        received.commands.push(line);
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO')) {
          socket.write(`250-fake.test\r\n250${expectAuth ? '-AUTH PLAIN LOGIN\r\n250' : ''} SIZE 1000000\r\n`);
        } else if (upper.startsWith('AUTH PLAIN')) {
          socket.write('235 authenticated\r\n');
        } else if (upper.startsWith('MAIL FROM')) {
          socket.write('250 sender ok\r\n');
        } else if (upper.startsWith('RCPT TO')) {
          socket.write(failRcpt ? '550 no such user\r\n' : '250 recipient ok\r\n');
        } else if (upper === 'DATA') {
          inData = true;
          socket.write('354 go ahead\r\n');
        } else if (upper === 'QUIT') {
          socket.write('221 bye\r\n');
          socket.end();
        } else {
          socket.write('250 ok\r\n');
        }
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, received });
    });
  });
}

test('sends a complete message through the full SMTP conversation', async () => {
  const { server, port, received } = await fakeSmtpServer();
  try {
    await sendMail({
      host: '127.0.0.1', port, secure: false, starttls: false,
      from: 'orchestrator@test', to: 'owner@test',
      subject: 'Mission complete', text: 'All tasks done.\n.leading dot line',
    });
  } finally {
    server.close();
  }
  assert.ok(received.commands.some((c) => c === 'MAIL FROM:<orchestrator@test>'));
  assert.ok(received.commands.some((c) => c === 'RCPT TO:<owner@test>'));
  assert.match(received.data, /Subject: Mission complete/);
  assert.match(received.data, /All tasks done\./);
  // Dot-stuffing applied.
  assert.match(received.data, /\n\.\.leading dot line/);
});

test('authenticates with AUTH PLAIN when the server offers it', async () => {
  const { server, port, received } = await fakeSmtpServer({ expectAuth: true });
  try {
    await sendMail({
      host: '127.0.0.1', port, secure: false, starttls: false,
      user: 'bot', pass: 'hunter2',
      from: 'a@test', to: 'b@test', subject: 's', text: 't',
    });
  } finally {
    server.close();
  }
  const auth = received.commands.find((c) => c.startsWith('AUTH PLAIN '));
  assert.ok(auth, 'expected an AUTH PLAIN command');
  const decoded = Buffer.from(auth.slice('AUTH PLAIN '.length), 'base64').toString('utf8');
  // RFC 4616: NUL authcid NUL passwd (empty authzid).
  assert.equal(decoded, '\u0000bot\u0000hunter2');
});

test('a rejected recipient surfaces as a clear error', async () => {
  const { server, port } = await fakeSmtpServer({ failRcpt: true });
  try {
    await assert.rejects(
      () => sendMail({
        host: '127.0.0.1', port, secure: false, starttls: false,
        from: 'a@test', to: 'nobody@test', subject: 's', text: 't',
      }),
      /550/
    );
  } finally {
    server.close();
  }
});

test('validates required fields before touching the network', async () => {
  await assert.rejects(() => sendMail({ from: 'a@test', to: 'b@test' }), /"host" is required/);
  await assert.rejects(() => sendMail({ host: 'x', to: 'b@test' }), /"from" is required/);
  await assert.rejects(() => sendMail({ host: 'x', from: 'a@test', to: [] }), /recipient/);
});

test('header injection via subject is neutralized', async () => {
  const { server, port, received } = await fakeSmtpServer();
  try {
    await sendMail({
      host: '127.0.0.1', port, secure: false, starttls: false,
      from: 'a@test', to: 'b@test',
      subject: 'hi\r\nBcc: victim@test', text: 'body',
    });
  } finally {
    server.close();
  }
  assert.doesNotMatch(received.data, /^Bcc:/m);
  assert.match(received.data, /Subject: hi Bcc: victim@test/);
});
