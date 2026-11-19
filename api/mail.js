'use strict';

const net = require('net');
const tls = require('tls');

function configured() {
  return !!String(process.env.SMTP_HOST || '').trim();
}

function envelope(value) {
  const raw = String(value || '').trim();
  const wrapped = raw.match(/<([^>]+)>/);
  return (wrapped ? wrapped[1] : raw).trim();
}

function readReply(socket) {
  return new Promise((resolve, reject) => {
    let buf = '';
    function onData(chunk) {
      buf += chunk.toString('utf8');
      const lines = buf.split(/\r?\n/);
      if (!buf.endsWith('\n')) return;
      const complete = lines.filter(Boolean);
      const last = complete[complete.length - 1] || '';
      if (!/^\d{3}[ -]/.test(last) || last[3] === '-') return;
      cleanup();
      resolve({ code: Number(last.slice(0, 3)), lines: complete });
    }
    function onError(err) { cleanup(); reject(err); }
    function cleanup() {
      socket.off('data', onData);
      socket.off('error', onError);
    }
    socket.on('data', onData);
    socket.on('error', onError);
  });
}

function command(socket, line) {
  socket.write(line + '\r\n');
  return readReply(socket);
}

function assertOk(reply, step) {
  if (!reply || reply.code >= 400) {
    const detail = reply && reply.lines ? reply.lines[0] : 'no reply';
    const err = new Error(step + ' ' + detail);
    err.status = 503;
    err.code = 'unavailable';
    throw err;
  }
}

function message(from, to, subject, text) {
  const encoded = '=?UTF-8?B?' + Buffer.from(subject, 'utf8').toString('base64') + '?=';
  const body = String(text).replace(/\r?\n/g, '\r\n').split('\r\n').map(line => (line.startsWith('.') ? '.' + line : line)).join('\r\n');
  return [
    'From: ' + from,
    'To: ' + to,
    'Subject: ' + encoded,
    'Date: ' + new Date().toUTCString(),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    body,
    '.'
  ].join('\r\n');
}

function connect() {
  const host = String(process.env.SMTP_HOST || '').trim();
  const port = Number(process.env.SMTP_PORT || 25);
  const secure = /^(1|true|yes)$/i.test(String(process.env.SMTP_SECURE || ''));
  if (!host) {
    const err = new Error('SMTP_HOST is empty');
    err.status = 503;
    err.code = 'unavailable';
    throw err;
  }
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: false })
      : net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(Object.assign(new Error('SMTP timeout'), { status: 503, code: 'unavailable' }));
    }, 20000);
    socket.once('error', err => {
      clearTimeout(timer);
      reject(Object.assign(err, { status: 503, code: 'unavailable' }));
    });
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
  });
}

async function sendMail({ to, subject, text }) {
  const from = String(process.env.SMTP_FROM || 'Huawei Return <huawei-return@synnex.co.th>').trim();
  const socket = await connect();
  try {
    assertOk(await readReply(socket), 'banner');
    assertOk(await command(socket, 'EHLO huawei-return'), 'ehlo');
    const user = String(process.env.SMTP_USER || '');
    const password = String(process.env.SMTP_PASSWORD || '');
    if (user) {
      assertOk(await command(socket, 'AUTH LOGIN'), 'auth');
      assertOk(await command(socket, Buffer.from(user, 'utf8').toString('base64')), 'auth-user');
      assertOk(await command(socket, Buffer.from(password, 'utf8').toString('base64')), 'auth-pass');
    }
    assertOk(await command(socket, 'MAIL FROM:<' + envelope(from) + '>'), 'from');
    assertOk(await command(socket, 'RCPT TO:<' + envelope(to) + '>'), 'to');
    assertOk(await command(socket, 'DATA'), 'data');
    assertOk(await command(socket, message(from, to, subject, text)), 'body');
    try { await command(socket, 'QUIT'); } catch (e) { /* the message is already accepted */ }
  } finally {
    socket.end();
  }
}

module.exports = { configured, sendMail, envelope };
