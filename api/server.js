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
  max: Number(process.env.PGPOOL || 10),
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
  const client = await pool.connect();
  try {
    await client.query("SET statement_timeout = '120s'");
    await client.query(sql);
    await client.query('ANALYZE docs');
  } finally {
    client.release();
  }
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
    const selfDept = ['sales', 'wh', 'ipqc'];
    if (logic.isUserDoc(id) && !exists && next.role !== 'admin') {
      const asked = selfDept.includes(next.role) ? next.role : (selfDept.includes(next.requestedRole) ? next.requestedRole : '');
      if (asked) {
        next.role = asked;
        next.requestedRole = asked;
        next.status = 'active';
      }
    }
    const wasAdmin = !!(prev && prev.role === 'admin');
    const signupAdmin = logic.isUserDoc(id) && next.role === 'admin' && !wasAdmin && (!exists || next.approvedBy === 'bootstrap');
    if (signupAdmin) {
      throw logic.httpError(403, 'permission-denied', 'สมัครเป็นผู้ดูแลระบบไม่ได้');
    }
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

function normTerm(q) {
  return String(q || '').trim().toLowerCase().replace(/[\s\-]/g, '');
}

function likePrefix(term) {
  return term.replace(/[\\%_]/g, ch => '\\' + ch) + '%';
}

async function searchCases(q, limit, deleted) {
  const term = normTerm(q);
  if (term.length < 2 || term.length > 80) return { docs: [] };
  const prefix = likePrefix(term);
  const parts = SEARCH_COLS.map(col => `lower(${col}) LIKE $1 ESCAPE '\\'`);
  const result = await pool.query(
    `SELECT id, body, rev FROM docs
     WHERE kind = 'case' AND deleted = $3 AND (${parts.join(' OR ')})
     ORDER BY (lower(invoice_no) = $4 OR lower(order_no) = $4 OR lower(tracking) = $4 OR lower(serial) = $4) DESC,
              updated_at DESC NULLS LAST
     LIMIT $2`,
    [prefix, limit, !!deleted, term]
  );
  return { docs: result.rows.map(row => ({ id: row.id, rev: row.rev, body: row.body })) };
}

const SLIM = `
  id, status, deleted,
  invoice_no AS "invoiceNo", order_no AS "orderNo", pa_no AS "paNo", ro_no AS "roNo",
  cn_no AS "cnNo", tracking, return_tracking AS "returnTracking", serial, sku,
  cc_no AS "ccNo", claim_no AS "claimNo", platform,
  received_date AS "receivedDate", stock_date AS "stockDate",
  created_at AS "createdAt", updated_at AS "updatedAt",
  COALESCE(body->>'condition', '') AS condition,
  COALESCE(body->>'reason', '') AS reason,
  COALESCE(body->>'carrier', '') AS carrier,
  COALESCE(body->>'testResult', '') AS "testResult",
  COALESCE(body->>'qty', '') AS qty,
  COALESCE(body->>'deletedBy', '') AS "deletedBy",
  COALESCE(body->>'deletedAt', '') AS "deletedAt",
  ((body->'wrongItem') = 'true'::jsonb) AS "wrongItem",
  CASE WHEN jsonb_typeof(body->'thread') = 'array' THEN jsonb_array_length(body->'thread') ELSE 0 END AS "threadCount"`;

const OPEN_SQL = "status IS DISTINCT FROM 'ปิดงาน'";
const STAGE2 = "status IN ('ได้รับสินค้าแล้ว','รอทดสอบ','กำลังทดสอบ','ทดสอบเสร็จ','เคลม Platform','ส่งคืนลูกค้า','รอทำรับคืน (CN)','ปิดงาน')";

function dateOk(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function ageExpr(todayParam) {
  return `CASE
    WHEN received_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN ($${todayParam}::date - received_date::date)
    WHEN left(COALESCE(created_at, ''), 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN GREATEST($${todayParam}::date - left(created_at, 10)::date, 0)
    ELSE 0 END`;
}

function createdTodaySql(params, start, end, today) {
  params.push(start, end, today);
  const a = params.length - 2;
  const b = params.length - 1;
  const c = params.length;
  return `((char_length(created_at) = 24 AND right(created_at, 1) = 'Z' AND created_at >= $${a} AND created_at < $${b}) OR (char_length(COALESCE(created_at, '')) <> 24 AND left(created_at, 10) = $${c}))`;
}

function histExists(startIdx, endIdx, actionSql) {
  return `EXISTS (
    SELECT 1 FROM jsonb_array_elements(COALESCE(body->'history', '[]'::jsonb)) h
    WHERE (h->>'at') >= $${startIdx} AND (h->>'at') < $${endIdx}
      AND ${actionSql}
      AND (h->>'action') NOT LIKE 'ระบบแปลงสถานะ%'
      AND (h->>'action') NOT LIKE 'อัปเดตจากไฟล์นำเข้า%')`;
}

function listFilter(name, params, sp) {
  const today = sp.get('today') || '';
  const start = sp.get('start') || '';
  const end = sp.get('end') || '';
  if (name === 'open') return OPEN_SQL;
  if (name === 'in') return "status IN ('สร้างคำขอคืน','รอรับสินค้า','ได้รับสินค้าแล้ว')";
  if (name === 'test') return "status IN ('รอทดสอบ','กำลังทดสอบ')";
  if (name === 'action') return "status IN ('ทดสอบเสร็จ','เคลม Platform','ส่งคืนลูกค้า')";
  if (name === 'doc') return "status = 'รอทำรับคืน (CN)'";
  if (name === 'closed') return "status = 'ปิดงาน'";
  if (name === 'wrong') return OPEN_SQL + " AND (body->'wrongItem') = 'true'::jsonb";
  if (name === 'today' && dateOk(today)) {
    params.push(today);
    return 'received_date = $' + params.length;
  }
  if (name === 'newToday' && dateOk(today) && start && end) return createdTodaySql(params, start, end, today);
  if (name === 'closedToday' && start && end) {
    params.push(start, end);
    const a = params.length - 1;
    const b = params.length;
    return "status = 'ปิดงาน' AND " + histExists(a, b, "(h->>'action') LIKE '%→ ปิดงาน%'");
  }
  if (name === 'aged' && dateOk(today)) {
    params.push(today);
    return OPEN_SQL + ' AND ' + ageExpr(params.length) + ' > 30';
  }
  if (name === 'ageBad' && dateOk(today)) {
    params.push(today);
    return OPEN_SQL + " AND received_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND received_date > $" + params.length;
  }
  if (name === 'baddate' && dateOk(today)) {
    params.push(today);
    const t = params.length;
    return `((${STAGE2} AND COALESCE(received_date, '') = '')
      OR (received_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND received_date > $${t})
      OR (stock_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND stock_date > $${t})
      OR (received_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND stock_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND stock_date < received_date))`;
  }
  return '';
}

function caseListWhere(sp) {
  const name = String(sp.get('f') || 'all');
  const deleted = name === 'trash';
  const params = [];
  const where = ["kind = 'case'", 'deleted = ' + (deleted ? 'true' : 'false')];
  const extra = listFilter(name, params, sp);
  if (extra) where.push(extra);
  const platform = String(sp.get('platform') || '');
  if (platform && platform.length <= 80) {
    params.push(platform);
    where.push('platform = $' + params.length);
  }
  const condition = String(sp.get('condition') || '');
  if (condition && condition.length <= 80) {
    params.push(condition);
    where.push("COALESCE(NULLIF(body->>'condition', ''), 'อื่นๆ') = $" + params.length);
  }
  const from = sp.get('from') || '';
  const to = sp.get('to') || '';
  if (dateOk(from)) {
    params.push(from);
    where.push('received_date >= $' + params.length);
  }
  if (dateOk(to)) {
    params.push(to);
    where.push('received_date <= $' + params.length);
  }
  const term = normTerm(sp.get('q'));
  if (term.length >= 1 && term.length <= 80) {
    params.push(likePrefix(term));
    const n = '$' + params.length;
    const parts = SEARCH_COLS.map(col => `lower(${col}) LIKE ${n} ESCAPE '\\'`);
    where.push('(' + parts.join(' OR ') + ')');
  }
  return { where: where.join(' AND '), params };
}

async function casePage(sp) {
  const limit = Math.min(100, Math.max(1, Number(sp.get('limit')) || 100));
  const offset = Math.min(200000, Math.max(0, Number(sp.get('offset')) || 0));
  const built = caseListWhere(sp);
  const count = await pool.query('SELECT count(*)::int AS n FROM docs WHERE ' + built.where, built.params);
  const params = built.params.concat([limit, offset]);
  const rows = await pool.query(
    `SELECT ${SLIM} FROM docs WHERE ${built.where}
     ORDER BY updated_at DESC NULLS LAST, id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { rows: rows.rows, total: count.rows[0].n, limit, offset };
}

async function currentRev() {
  const row = await pool.query('SELECT rev FROM sync_state WHERE id = 1');
  return { rev: row.rowCount ? row.rows[0].rev : 0 };
}

async function dashboard(sp) {
  const today = dateOk(sp.get('today')) ? sp.get('today') : '';
  const start = String(sp.get('start') || '');
  const end = String(sp.get('end') || '');
  const stale = String(sp.get('stale') || '');
  const rev = await currentRev();
  const params = [today || '1970-01-01'];
  const age = ageExpr(1);
  const created = today && start && end ? createdTodaySql(params, start, end, today) : 'FALSE';
  let recvSql = 'FALSE';
  let closedSql = 'FALSE';
  if (start && end) {
    params.push(start, end);
    const a = params.length - 1;
    const b = params.length;
    recvSql = histExists(a, b, "(h->>'action') ~ '(→ |\\()ได้รับสินค้าแล้ว'");
    closedSql = "status = 'ปิดงาน' AND " + histExists(a, b, "(h->>'action') LIKE '%→ ปิดงาน%'");
  }
  params.push(stale || '9999-12-31');
  const staleIdx = params.length;
  const [counts, byStatus, conditions, platforms, daily, recent, wrongList, staleList, testQueue, trash] = await Promise.all([
    pool.query(
      `SELECT
         count(*)::int AS total,
         count(*) FILTER (WHERE ${OPEN_SQL})::int AS open,
         count(*) FILTER (WHERE (body->'wrongItem') = 'true'::jsonb)::int AS wrong,
         count(*) FILTER (WHERE ${OPEN_SQL} AND (body->'wrongItem') = 'true'::jsonb)::int AS "wrongOpen",
         count(*) FILTER (WHERE status IN ('รอทดสอบ','กำลังทดสอบ'))::int AS test,
         count(*) FILTER (WHERE status IN ('ทดสอบเสร็จ','เคลม Platform','ส่งคืนลูกค้า'))::int AS action,
         count(*) FILTER (WHERE ${OPEN_SQL} AND status IN ('ได้รับสินค้าแล้ว','รอทดสอบ','กำลังทดสอบ','ทดสอบเสร็จ','เคลม Platform','ส่งคืนลูกค้า','รอทำรับคืน (CN)'))::int AS received,
         count(*) FILTER (WHERE ${created})::int AS "newToday",
         count(*) FILTER (WHERE ${recvSql})::int AS "recvToday",
         count(*) FILTER (WHERE ${closedSql})::int AS "closedToday",
         count(*) FILTER (WHERE ${OPEN_SQL} AND ${age} > 30)::int AS aged30,
         count(*) FILTER (WHERE ${OPEN_SQL} AND ${age} > 90)::int AS aged90,
         count(*) FILTER (WHERE ${OPEN_SQL} AND ${age} BETWEEN 0 AND 7)::int AS b7,
         count(*) FILTER (WHERE ${OPEN_SQL} AND ${age} BETWEEN 8 AND 30)::int AS b30,
         count(*) FILTER (WHERE ${OPEN_SQL} AND ${age} BETWEEN 31 AND 90)::int AS b90,
         count(*) FILTER (WHERE ${OPEN_SQL} AND ${age} > 90)::int AS "bOld",
         count(*) FILTER (WHERE ${OPEN_SQL} AND received_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND received_date > $1::text)::int AS "badAge",
         count(*) FILTER (WHERE (${STAGE2} AND COALESCE(received_date, '') = '')
           OR (received_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND received_date > $1::text)
           OR (stock_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND stock_date > $1::text)
           OR (received_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND stock_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND stock_date < received_date))::int AS "badDate",
         count(*) FILTER (WHERE ${OPEN_SQL} AND COALESCE(updated_at, '') <> '' AND updated_at < $${staleIdx})::int AS stale
       FROM docs WHERE kind = 'case' AND deleted = false`,
      params
    ),
    pool.query("SELECT COALESCE(status, '') AS k, count(*)::int AS n FROM docs WHERE kind = 'case' AND deleted = false GROUP BY 1"),
    pool.query(`SELECT COALESCE(NULLIF(body->>'condition', ''), 'อื่นๆ') AS k, count(*)::int AS n
      FROM docs WHERE kind = 'case' AND deleted = false GROUP BY 1 ORDER BY 2 DESC LIMIT 8`),
    pool.query(`SELECT COALESCE(platform, '') AS k, count(*)::int AS n,
        count(*) FILTER (WHERE (body->'wrongItem') = 'true'::jsonb)::int AS w
      FROM docs WHERE kind = 'case' AND deleted = false GROUP BY 1`),
    pool.query(
      `SELECT received_date AS d, count(*)::int AS n FROM docs
       WHERE kind = 'case' AND deleted = false AND received_date >= $1 AND received_date <= $2
       GROUP BY 1`,
      [shiftDate(today || '1970-01-01', -6), today || '1970-01-01']
    ),
    pool.query(`SELECT ${SLIM} FROM docs WHERE kind = 'case' AND deleted = false ORDER BY updated_at DESC NULLS LAST, id DESC LIMIT 30`),
    pool.query(`SELECT ${SLIM} FROM docs WHERE kind = 'case' AND deleted = false AND ${OPEN_SQL}
      AND (body->'wrongItem') = 'true'::jsonb AND COALESCE(body->>'wrongAckAt', '') = ''
      ORDER BY created_at DESC NULLS LAST LIMIT 10`),
    pool.query(`SELECT ${SLIM} FROM docs WHERE kind = 'case' AND deleted = false AND ${OPEN_SQL}
      AND COALESCE(updated_at, '') <> '' AND updated_at < $1
      ORDER BY updated_at ASC NULLS LAST LIMIT 10`, [stale || '9999-12-31']),
    pool.query(`SELECT ${SLIM} FROM docs WHERE kind = 'case' AND deleted = false AND status IN ('รอทดสอบ','กำลังทดสอบ')
      ORDER BY received_date ASC NULLS LAST, created_at ASC NULLS LAST LIMIT 12`),
    pool.query("SELECT count(*)::int AS n FROM docs WHERE kind = 'case' AND deleted = true")
  ]);
  const statusMap = {};
  byStatus.rows.forEach(row => { statusMap[row.k] = row.n; });
  return Object.assign({}, counts.rows[0], {
    rev: rev.rev,
    trash: trash.rows[0].n,
    byStatus: statusMap,
    conditions: conditions.rows,
    platforms: platforms.rows,
    daily: daily.rows,
    recent: recent.rows,
    wrongList: wrongList.rows,
    staleList: staleList.rows,
    testQueue: testQueue.rows
  });
}

function shiftDate(iso, days) {
  const d = new Date(String(iso).slice(0, 10) + 'T12:00:00Z');
  if (Number.isNaN(d.getTime())) return '1970-01-01';
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function trendAgg() {
  const [cond, reason] = await Promise.all([
    pool.query(`SELECT substr(received_date, 1, 7) AS m, COALESCE(NULLIF(body->>'condition', ''), 'อื่นๆ') AS k, count(*)::int AS n
      FROM docs WHERE kind = 'case' AND deleted = false AND received_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
      GROUP BY 1, 2`),
    pool.query(`SELECT substr(received_date, 1, 7) AS m, COALESCE(NULLIF(body->>'reason', ''), 'อื่นๆ') AS k, count(*)::int AS n
      FROM docs WHERE kind = 'case' AND deleted = false AND received_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
      GROUP BY 1, 2`)
  ]);
  const mc = {};
  const cm = {};
  const rm = {};
  const condTot = {};
  const reasonTot = {};
  cond.rows.forEach(row => {
    mc[row.m] = (mc[row.m] || 0) + row.n;
    condTot[row.k] = (condTot[row.k] || 0) + row.n;
    if (!cm[row.k]) cm[row.k] = {};
    cm[row.k][row.m] = row.n;
  });
  reason.rows.forEach(row => {
    reasonTot[row.k] = (reasonTot[row.k] || 0) + row.n;
    if (!rm[row.k]) rm[row.k] = {};
    rm[row.k][row.m] = row.n;
  });
  const months = Object.keys(mc).sort();
  const topConds = Object.entries(condTot).sort((a, b) => b[1] - a[1]).slice(0, 8).map(entry => entry[0]);
  return { months, topConds, mc, cm, rm, reasonTot };
}

async function inboxPage() {
  const result = await pool.query(
    `SELECT id, invoice_no AS "invoiceNo", order_no AS "orderNo", status, platform, updated_at AS "updatedAt",
            body->'thread' AS thread
     FROM docs
     WHERE kind = 'case' AND deleted = false
       AND jsonb_typeof(body->'thread') = 'array'
       AND jsonb_array_length(body->'thread') > 0
     ORDER BY updated_at DESC NULLS LAST
     LIMIT 80`
  );
  return { rows: result.rows };
}

async function caseKeys() {
  const result = await pool.query(
    `SELECT id, deleted, status,
        invoice_no AS "invoiceNo", order_no AS "orderNo", pa_no AS "paNo", ro_no AS "roNo",
        cn_no AS "cnNo", cc_no AS "ccNo", sku, serial, tracking,
        return_tracking AS "returnTracking", claim_no AS "claimNo",
        received_date AS "receivedDate", stock_date AS "stockDate",
        COALESCE(body->>'condition', '') AS condition,
        COALESCE(body->>'carrier', '') AS carrier,
        COALESCE(body->>'returnCarrier', '') AS "returnCarrier",
        COALESCE(body->>'qty', '') AS qty,
        COALESCE(body->>'claimResult', '') AS "claimResult",
        COALESCE(body->>'boxNo', '') AS "boxNo",
        left(COALESCE(body->>'handoverNote', ''), 180) AS "handoverNote",
        ((body->'wrongItem') = 'true'::jsonb) AS "wrongItem",
        CASE WHEN deleted THEN COALESCE((
          SELECT (e->>'action') LIKE 'ยกเลิกการนำเข้า%'
          FROM jsonb_array_elements(COALESCE(body->'history', '[]'::jsonb)) e
          WHERE (e->>'action') LIKE 'ยกเลิกการนำเข้า%' OR (e->>'action') LIKE 'ลบ%'
          ORDER BY e->>'at' DESC
          LIMIT 1
        ), false) ELSE false END AS undone
     FROM docs WHERE kind = 'case'`
  );
  const cols = ['id', 'deleted', 'undone', 'status', 'invoiceNo', 'orderNo', 'paNo', 'roNo', 'cnNo', 'ccNo', 'sku', 'serial', 'qty', 'carrier', 'tracking', 'returnTracking', 'returnCarrier', 'claimNo', 'claimResult', 'boxNo', 'handoverNote', 'receivedDate', 'stockDate', 'condition', 'wrongItem'];
  return {
    cols,
    rows: result.rows.map(row => cols.map(col => {
      const value = row[col];
      if (value == null || value === false || value === '') return '';
      if (value === true) return 1;
      return value;
    }))
  };
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
    return send(res, 200, await searchCases(url.searchParams.get('q'), clampLimit(url.searchParams.get('limit') || 50), url.searchParams.get('deleted') === '1'));
  }
  if (req.method === 'GET' && pathname === '/rev') return send(res, 200, await currentRev());
  if (req.method === 'GET' && pathname === '/cases') return send(res, 200, await casePage(url.searchParams));
  if (req.method === 'GET' && pathname === '/stats') return send(res, 200, await dashboard(url.searchParams));
  if (req.method === 'GET' && pathname === '/trend') return send(res, 200, await trendAgg());
  if (req.method === 'GET' && pathname === '/inbox') return send(res, 200, await inboxPage());
  if (req.method === 'GET' && pathname === '/keys') return send(res, 200, await caseKeys());
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
