'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { Pool } = require('pg');
const logic = require('./logic');
const mailer = require('./mail');

// node-pg returns bigint (oid 20) as a string. Revision numbers stay inside 2^53.
require('pg').types.setTypeParser(20, value => (value == null ? null : Number(value)));

loadEnv(path.join(__dirname, '.env'));

const PREFIX = (process.env.API_PREFIX || '/Huawei-Return/api').replace(/\/$/, '');
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
const PORT = Number(process.env.API_PORT || process.env.PORT || 8787);
const MAX_BODY = 32 * 1024 * 1024;
const MAX_OPS = 500;
const MAX_DOC = 6 * 1024 * 1024;
const PAGE_MAX = 1000;

const pool = new Pool({
  host: process.env.PGHOST || '10.128.19.192',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'huawei_return',
  user: process.env.PGUSER || '',
  password: process.env.PGPASSWORD || '',
  max: Number(process.env.PGPOOL || 4),
  connectionTimeoutMillis: 8000,
  idleTimeoutMillis: 30000,
  application_name: 'huawei-return',
  options: '-c statement_timeout=15000'
});

let bootError = '';
let ready = false;

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null || process.env[key] === '') process.env[key] = value;
  }
}

function send(res, status, body) {
  const raw = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': raw.length,
    'Cache-Control': 'no-store'
  });
  res.end(raw);
}

function fail(res, err) {
  const down = err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT' || err.code === '57P01' || err.code === '3D000' || err.code === '28P01';
  const status = Number(err.status) || (down ? 503 : 500);
  const code = down ? 'unavailable' : (err.code || (status === 500 ? 'internal' : 'unknown'));
  if (status >= 500) console.error(err);
  const message = status >= 500 ? (down ? 'เชื่อมต่อ PostgreSQL ไม่ได้' : 'ทำงานไม่สำเร็จ') : (err.message || code);
  send(res, status, { error: message, code });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(logic.httpError(413, 'invalid-argument', 'ข้อมูลใหญ่เกิน ' + MAX_BODY + ' ไบต์'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(logic.httpError(400, 'invalid-argument', 'JSON ไม่ถูกต้อง')); }
    });
    req.on('error', reject);
  });
}

function routeOf(reqUrl) {
  const url = new URL(reqUrl, 'http://127.0.0.1');
  let pathname = logic.decodePath(url.pathname);
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
  if (pathname === PREFIX) pathname = '/';
  else if (pathname.startsWith(PREFIX + '/')) pathname = pathname.slice(PREFIX.length);
  return { pathname, url };
}

function clampLimit(value) {
  const n = Number(value || 500);
  if (!Number.isFinite(n) || n < 1) return 500;
  return Math.min(PAGE_MAX, Math.floor(n));
}

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

async function nextRev(client) {
  const row = await client.query('UPDATE sync_state SET rev = rev + 1 WHERE id = 1 RETURNING rev');
  if (!row.rowCount) throw logic.httpError(500, 'internal', 'ไม่พบ sync_state');
  return row.rows[0].rev;
}

async function applyOps(client, ops) {
  if (!Array.isArray(ops) || !ops.length) return { rev: null, docs: [] };
  if (ops.length > MAX_OPS) throw logic.httpError(400, 'invalid-argument', 'ส่งได้ไม่เกิน ' + MAX_OPS + ' รายการต่อครั้ง');
  const rev = await nextRev(client);
  const docs = [];
  for (const op of ops) {
    if (!op || (op.op !== 'set' && op.op !== 'merge' && op.op !== 'update')) {
      throw logic.httpError(400, 'invalid-argument', 'op ต้องเป็น set, merge หรือ update');
    }
    const id = logic.checkId(op.id);
    const current = await client.query('SELECT body FROM docs WHERE id = $1 FOR UPDATE', [id]);
    const exists = current.rowCount > 0;
    const prev = exists ? current.rows[0].body : null;
    if (op.op === 'update' && !exists) throw logic.httpError(404, 'not-found', 'ไม่พบเอกสาร ' + id);
    if (op.op === 'set' && logic.isUserDoc(id) && exists) throw logic.httpError(409, 'exists', 'บัญชีนี้มีแล้ว');
    const next = logic.applyPatch(prev, op.data || {}, op.op === 'set' ? 'set' : 'merge');
    const raw = JSON.stringify(next);
    if (Buffer.byteLength(raw) > MAX_DOC) throw logic.httpError(413, 'invalid-argument', 'เอกสาร ' + id + ' ใหญ่เกินไป');
    if (exists) {
      await client.query('UPDATE docs SET body = $2::jsonb, rev = $3, touched_at = now() WHERE id = $1', [id, raw, rev]);
    } else {
      await client.query('INSERT INTO docs (id, body, rev) VALUES ($1, $2::jsonb, $3)', [id, raw, rev]);
    }
    docs.push({ id, rev, body: next });
  }
  return { rev, docs };
}

async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { console.error(e); }
    throw err;
  } finally {
    client.release();
  }
}

function viewBody(id, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  if (typeof id === 'string' && id.startsWith('user~') && id !== 'user~~index') {
    const copy = Object.assign({}, body);
    delete copy.pass;
    delete copy.salt;
    return copy;
  }
  return body;
}

async function syncPage(rev, id, limit, casesOnly) {
  const params = [Number(rev) || 0, String(id || ''), limit];
  const kind = casesOnly ? " AND kind = 'case'" : '';
  const result = await pool.query(
    `SELECT id, body, rev FROM docs
     WHERE (rev, id) > ($1::bigint, $2::text)${kind}
     ORDER BY rev, id
     LIMIT $3`,
    params
  );
  const last = result.rows[result.rows.length - 1];
  return {
    docs: result.rows.map(row => ({ id: row.id, rev: row.rev, body: viewBody(row.id, row.body) })),
    cursor: last ? { rev: last.rev, id: last.id } : { rev: Number(rev) || 0, id: String(id || '') },
    more: result.rows.length === limit
  };
}

async function getDoc(id) {
  logic.checkId(id);
  const result = await pool.query('SELECT id, body, rev FROM docs WHERE id = $1', [id]);
  if (!result.rowCount) return { id, exists: false, rev: 0, body: null };
  const row = result.rows[0];
  return { id: row.id, exists: true, rev: row.rev, body: row.body };
}

async function listUsers() {
  const result = await pool.query("SELECT id, body, rev FROM docs WHERE id LIKE 'user~%'");
  const index = result.rows.find(row => row.id === 'user~~index');
  const names = index && Array.isArray(index.body.users) ? index.body.users : [];
  const byId = new Map(result.rows.filter(row => row.id !== 'user~~index').map(row => [row.id, row]));
  const users = [];
  for (const name of names) {
    const row = byId.get('user~' + String(name).trim().toLowerCase());
    if (row) users.push({ id: row.id, rev: row.rev, body: viewBody(row.id, row.body) });
  }
  return { users };
}

const SEARCH_COLS = ['invoice_no', 'order_no', 'pa_no', 'ro_no', 'cn_no', 'tracking', 'return_tracking', 'serial', 'sku', 'cc_no', 'claim_no'];

async function searchCases(q, limit) {
  const term = String(q || '').trim().toLowerCase();
  if (term.length < 2 || term.length > 80) return { docs: [] };
  const prefix = term.replace(/[\\%_]/g, ch => '\\' + ch) + '%';
  const parts = SEARCH_COLS.map(col => `lower(${col}) LIKE $1 ESCAPE '\\'`);
  const result = await pool.query(
    `SELECT id, body, rev FROM docs
     WHERE kind = 'case' AND (${parts.join(' OR ')})
     ORDER BY updated_at DESC NULLS LAST
     LIMIT $2`,
    [prefix, limit]
  );
  return { docs: result.rows.map(row => ({ id: row.id, rev: row.rev, body: row.body })) };
}

async function handle(req, res) {
  const { pathname, url } = routeOf(req.url);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }
  if (pathname !== '/health' && !ready) {
    send(res, 503, { error: bootError || 'กำลังเตรียมฐานข้อมูล', code: 'unavailable' });
    return;
  }
  if (req.method === 'GET' && pathname === '/health') return health(res);
  if (req.method === 'GET' && pathname === '/sync') {
    const page = await syncPage(url.searchParams.get('rev'), url.searchParams.get('id'), clampLimit(url.searchParams.get('limit')), false);
    return send(res, 200, page);
  }
  if (req.method === 'GET' && pathname === '/backup') {
    const page = await syncPage(url.searchParams.get('rev'), url.searchParams.get('id'), clampLimit(url.searchParams.get('limit')), true);
    return send(res, 200, page);
  }
  if (req.method === 'GET' && pathname === '/search') {
    return send(res, 200, await searchCases(url.searchParams.get('q'), clampLimit(url.searchParams.get('limit') || 50)));
  }
  if (req.method === 'GET' && pathname === '/users') return send(res, 200, await listUsers());
  if (req.method === 'GET' && pathname.startsWith('/docs/')) return send(res, 200, await getDoc(pathname.slice('/docs/'.length)));
  if (req.method === 'GET' && pathname.startsWith('/users/')) {
    const username = pathname.slice('/users/'.length).trim().toLowerCase();
    return send(res, 200, await getDoc('user~' + username));
  }
  if (req.method === 'POST' && (pathname === '/batch' || pathname === '/import')) {
    const body = await readBody(req);
    const ops = Array.isArray(body.ops) ? body.ops : docsToOps(body.docs);
    const result = await withTx(client => applyOps(client, ops));
    return send(res, 200, result);
  }
  if (req.method === 'POST' && pathname === '/users') {
    const body = await readBody(req);
    const username = String(body.username || '').trim().toLowerCase();
    const id = logic.checkId('user~' + username);
    const doc = Object.assign({}, body.body || body);
    delete doc.username;
    doc.username = username;
    const ops = [
      { op: 'merge', id: 'user~~index', data: { users: { __fv: 'arrayUnion', values: [username] }, updatedAt: new Date().toISOString() } },
      { op: 'set', id, data: doc }
    ];
    const result = await withTx(client => applyOps(client, ops));
    return send(res, 201, result);
  }
  if (req.method === 'PATCH' && pathname.startsWith('/users/')) {
    const username = pathname.slice('/users/'.length).trim().toLowerCase();
    const body = await readBody(req);
    const patch = body.body || body;
    delete patch.username;
    delete patch.acctCreatedAt;
    const result = await withTx(client => applyOps(client, [{ op: 'update', id: 'user~' + username, data: patch }]));
    return send(res, 200, result);
  }
  if (req.method === 'POST' && pathname === '/auth/login') return login(req, res);
  if (req.method === 'POST' && pathname === '/auth/forgot') return forgotPassword(req, res);
  if (req.method === 'POST' && pathname === '/auth/reset') return resetPassword(req, res);
  send(res, 404, { error: 'ไม่พบเส้นทาง', code: 'not-found' });
}

function docsToOps(docs) {
  if (!Array.isArray(docs)) throw logic.httpError(400, 'invalid-argument', 'ต้องส่ง ops หรือ docs');
  return docs.map(doc => {
    if (!doc || typeof doc !== 'object') throw logic.httpError(400, 'invalid-argument', 'เอกสารไม่ถูกต้อง');
    const id = doc.id;
    const data = Object.assign({}, doc);
    delete data.id;
    return { op: 'set', id, data };
  });
}

const RESET_TTL_MS = 30 * 60 * 1000;
const forgotRecent = new Map();

function forgotTooSoon(username) {
  const now = Date.now();
  const prev = forgotRecent.get(username) || 0;
  if (now - prev < 60000) return true;
  forgotRecent.set(username, now);
  if (forgotRecent.size > 4000) {
    for (const [key, at] of forgotRecent) {
      if (now - at > 60000) forgotRecent.delete(key);
    }
  }
  return false;
}

async function forgotPassword(req, res) {
  const body = await readBody(req);
  const username = String(body.username || '').trim().toLowerCase();
  if (!username || username.length > 120) {
    return send(res, 400, { error: 'กรุณากรอกอีเมลที่ใช้เข้าสู่ระบบ', code: 'invalid-argument' });
  }
  if (forgotTooSoon(username)) {
    return send(res, 429, { error: 'ส่งคำขอไปแล้วเมื่อสักครู่ กรุณารอแล้วตรวจอีเมล', code: 'rate-limit' });
  }
  let id;
  try { id = logic.checkId('user~' + username); }
  catch (e) { return send(res, 404, { error: 'ไม่พบบัญชีนี้', code: 'not-found' }); }
  const found = await pool.query('SELECT id FROM docs WHERE id = $1', [id]);
  if (!found.rowCount) return send(res, 404, { error: 'ไม่พบบัญชีนี้', code: 'not-found' });
  if (!logic.isEmail(username)) {
    return send(res, 400, { error: 'บัญชีนี้ไม่มีอีเมล ผู้ดูแลระบบต้องรีเซ็ตรหัสผ่านให้จากเมนูจัดการผู้ใช้', code: 'no-email' });
  }
  if (!mailer.configured()) {
    return send(res, 503, { error: 'ระบบส่งอีเมลยังไม่ได้ตั้งค่า — แจ้งผู้ดูแลระบบ', code: 'unavailable' });
  }
  const recent = await pool.query(
    "SELECT 1 FROM password_resets WHERE username = $1 AND created_at > now() - interval '60 seconds' LIMIT 1",
    [username]
  );
  if (recent.rowCount) {
    return send(res, 429, { error: 'ส่งลิงก์ไปแล้วเมื่อสักครู่ กรุณารอแล้วตรวจอีเมล', code: 'rate-limit' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = logic.hashToken(token);
  const link = (process.env.APP_PUBLIC_URL || 'https://10.128.19.191/Huawei-Return').replace(/\/$/, '') + '/?reset=' + token;
  await pool.query(
    'INSERT INTO password_resets (token_hash, username, expires_at) VALUES ($1, $2, $3)',
    [tokenHash, username, new Date(Date.now() + RESET_TTL_MS)]
  );
  try {
    await mailer.sendMail({
      to: username,
      subject: 'ตั้งรหัสผ่านใหม่ — Huawei Return',
      text: [
        'มีคำขอตั้งรหัสผ่านใหม่สำหรับบัญชี ' + username + ' ในระบบ Huawei Return',
        '',
        'เปิดลิงก์นี้ภายใน 30 นาทีเพื่อตั้งรหัสผ่านใหม่:',
        link,
        '',
        'ลิงก์นี้ใช้ได้ครั้งเดียว',
        'ถ้าคุณไม่ได้ขอรีเซ็ต ให้เพิกเฉยอีเมลนี้ รหัสผ่านเดิมยังใช้ได้'
      ].join('\n')
    });
  } catch (err) {
    await pool.query('DELETE FROM password_resets WHERE token_hash = $1', [tokenHash]);
    console.error('smtp', err.message);
    return send(res, 503, { error: 'ส่งอีเมลไม่สำเร็จ — ลองใหม่ภายหลัง', code: 'unavailable' });
  }
  send(res, 200, { ok: true });
}

async function resetPassword(req, res) {
  const body = await readBody(req);
  const token = String(body.token || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!/^[a-f0-9]{64}$/.test(token)) {
    return send(res, 400, { error: 'ลิงก์ไม่ถูกต้องหรือหมดอายุแล้ว', code: 'invalid-argument' });
  }
  if (password.length < 6 || password.length > 200) {
    return send(res, 400, { error: 'รหัสผ่านอย่างน้อย 6 ตัว', code: 'invalid-argument' });
  }
  const tokenHash = logic.hashToken(token);
  const username = await withTx(async client => {
    const row = await client.query(
      'SELECT username, expires_at, used_at FROM password_resets WHERE token_hash = $1 FOR UPDATE',
      [tokenHash]
    );
    const reset = row.rows[0];
    if (!reset || reset.used_at || new Date(reset.expires_at).getTime() <= Date.now()) {
      throw logic.httpError(400, 'invalid-argument', 'ลิงก์ไม่ถูกต้องหรือหมดอายุแล้ว');
    }
    const id = logic.checkId('user~' + reset.username);
    const doc = await client.query('SELECT body FROM docs WHERE id = $1 FOR UPDATE', [id]);
    if (!doc.rowCount) throw logic.httpError(400, 'invalid-argument', 'ลิงก์ไม่ถูกต้องหรือหมดอายุแล้ว');
    const salt = crypto.randomBytes(16).toString('hex');
    const next = Object.assign({}, doc.rows[0].body);
    next.salt = salt;
    next.pass = logic.hashPw(reset.username, password, salt, 3);
    next.hashVer = 3;
    next.pwChangedAt = new Date().toISOString();
    const rev = await nextRev(client);
    await client.query('UPDATE docs SET body = $2::jsonb, rev = $3, touched_at = now() WHERE id = $1', [id, JSON.stringify(next), rev]);
    await client.query('UPDATE password_resets SET used_at = now() WHERE username = $1 AND used_at IS NULL', [reset.username]);
    return reset.username;
  });
  send(res, 200, { ok: true, username });
}

async function login(req, res) {
  const body = await readBody(req);
  const username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!username || !password || password.length > 200) {
    return send(res, 401, { error: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง', code: 'unauthenticated' });
  }
  let doc = null;
  try {
    const id = logic.checkId('user~' + username);
    const found = await getDoc(id);
    if (found.exists) doc = found.body;
  } catch (err) {
    if (err.code !== 'invalid-argument') throw err;
  }
  const ok = doc ? logic.verifyPw(doc, username, password) : false;
  if (!doc) logic.hashPw(username, password, 'timing-pad', 3);
  if (!ok) return send(res, 401, { error: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง', code: 'unauthenticated' });
  send(res, 200, { ok: true, id: 'user~' + username, user: doc });
}

async function health(res) {
  if (bootError) return send(res, 503, { ok: false, error: bootError, code: 'unavailable' });
  try {
    const rev = await pool.query('SELECT rev FROM sync_state WHERE id = 1');
    const counts = await pool.query("SELECT kind, count(*)::int AS n FROM docs GROUP BY kind");
    const byKind = {};
    counts.rows.forEach(row => { byKind[row.kind] = row.n; });
    send(res, 200, {
      ok: true,
      db: 'postgres',
      host: process.env.PGHOST || '10.128.19.192',
      port: Number(process.env.PGPORT || 5432),
      database: process.env.PGDATABASE || 'huawei_return',
      rev: rev.rows[0] ? rev.rows[0].rev : 0,
      counts: byKind
    });
  } catch (err) {
    console.error(err);
    send(res, 503, { ok: false, error: 'เชื่อมต่อ PostgreSQL ไม่ได้', code: 'unavailable' });
  }
}

function corsHeaders() {
  const origin = process.env.CORS_ORIGIN || '';
  if (!origin) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600'
  };
}

function decorate(res) {
  const headers = corsHeaders();
  const writeHead = res.writeHead;
  res.writeHead = function (status, extra) {
    return writeHead.call(this, status, Object.assign({}, headers, extra));
  };
  return res;
}

function main() {
  const server = http.createServer((req, res) => {
    decorate(res);
    const started = Date.now();
    Promise.resolve(handle(req, res)).catch(err => {
      if (!res.headersSent) fail(res, err);
      else console.error(err);
    }).then(() => {
      console.log(req.method, req.url, res.statusCode, (Date.now() - started) + 'ms');
    });
  });
  migrate().then(() => {
    ready = true;
  }).catch(err => {
    bootError = 'เตรียมตาราง PostgreSQL ไม่สำเร็จ';
    console.error(bootError, err.message || err.code || err);
  }).then(() => {
    server.listen(PORT, BIND_HOST, () => {
      console.log('Huawei Return API http://' + BIND_HOST + ':' + PORT + PREFIX);
      console.log('PostgreSQL ' + (process.env.PGUSER || '(no user)') + '@' + (process.env.PGHOST || '10.128.19.192') + ':' + (process.env.PGPORT || 5432) + '/' + (process.env.PGDATABASE || 'huawei_return'));
      if (bootError) console.error(bootError);
    });
  });
}

if (require.main === module) main();

module.exports = { applyOps, docsToOps, routeOf };
