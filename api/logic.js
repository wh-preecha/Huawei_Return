'use strict';

const crypto = require('crypto');

const ID_RE = /^[A-Za-z0-9_~.@+\-]{1,160}$/;
const EMAIL_RE = /^[a-z0-9._+-]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;
const PW_ITER = 150000;

function decodePath(pathname) {
  const raw = String(pathname || '');
  try { return decodeURIComponent(raw); }
  catch (e) {
    try { return decodeURI(raw); }
    catch (e2) { return raw; }
  }
}

function checkId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    const err = new Error('รหัสเอกสารไม่ถูกต้อง');
    err.status = 400;
    err.code = 'invalid-argument';
    throw err;
  }
  return id;
}

function isUserDoc(id) {
  return id.startsWith('user~') && id !== 'user~~index';
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}

function applyPatch(prev, data, mode) {
  if (!isPlainObject(data)) {
    const err = new Error('ข้อมูลเอกสารต้องเป็น object');
    err.status = 400;
    err.code = 'invalid-argument';
    throw err;
  }
  const base = mode === 'set' ? {} : Object.assign({}, prev || {});
  const prior = prev || {};
  for (const key of Object.keys(data)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const value = data[key];
    if (isPlainObject(value) && value.__fv === 'serverTimestamp') {
      base[key] = new Date().toISOString();
    } else if (isPlainObject(value) && value.__fv === 'arrayUnion') {
      const cur = Array.isArray(prior[key]) ? prior[key].slice() : [];
      const have = new Set(cur.map(stable));
      const items = Array.isArray(value.values) ? value.values : [];
      for (const item of items) {
        const mark = stable(item);
        if (!have.has(mark)) {
          cur.push(item);
          have.add(mark);
        }
      }
      base[key] = cur;
    } else {
      base[key] = value;
    }
  }
  return base;
}

function isEmail(value) {
  return EMAIL_RE.test(String(value || '').trim().toLowerCase());
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function hashPw(username, password, salt, ver) {
  const user = String(username);
  const pass = String(password);
  const material = String(salt);
  if (Number(ver) === 3) {
    return crypto.pbkdf2Sync(pass, material + ':' + user, PW_ITER, 32, 'sha256').toString('hex');
  }
  return crypto.createHash('sha256').update(material + ':' + user + ':' + pass, 'utf8').digest('hex');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function verifyPw(doc, username, password) {
  if (!doc || typeof doc.salt !== 'string' || typeof doc.pass !== 'string') return false;
  const ver = Number(doc.hashVer) === 3 ? 3 : 2;
  return safeEqual(doc.pass, hashPw(username, password, doc.salt, ver));
}

function httpError(status, code, message) {
  const err = new Error(message || code);
  err.status = status;
  err.code = code;
  return err;
}

module.exports = {
  ID_RE,
  EMAIL_RE,
  PW_ITER,
  decodePath,
  isEmail,
  hashToken,
  checkId,
  isUserDoc,
  isPlainObject,
  stable,
  applyPatch,
  hashPw,
  verifyPw,
  httpError
};
