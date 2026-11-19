'use strict';

const assert = require('assert');
const logic = require('./logic');

const prev = {
  invoiceNo: 'CIV1',
  status: 'รอรับสินค้า',
  history: [{ action: 'สร้าง', at: '2026-01-01T00:00:00.000Z' }],
  thread: []
};

const replaced = logic.applyPatch(prev, {
  status: 'ได้รับสินค้าแล้ว',
  syncAt: { __fv: 'serverTimestamp' },
  history: { __fv: 'arrayUnion', values: [{ action: 'สร้าง', at: '2026-01-01T00:00:00.000Z' }, { action: 'รับของ' }] }
}, 'set');
assert.strictEqual(replaced.invoiceNo, undefined);
assert.strictEqual(replaced.status, 'ได้รับสินค้าแล้ว');
assert.strictEqual(replaced.history.length, 2);
assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(replaced.syncAt));

const merged = logic.applyPatch(prev, {
  history: { __fv: 'arrayUnion', values: [{ action: 'รับของ' }] },
  thread: { __fv: 'arrayUnion', values: [{ id: 'm1', text: 'สอบถาม' }] }
}, 'merge');
assert.strictEqual(merged.invoiceNo, 'CIV1');
assert.strictEqual(merged.history.length, 2);
assert.strictEqual(merged.history[0].action, 'สร้าง');
assert.strictEqual(merged.thread.length, 1);

const again = logic.applyPatch(merged, {
  thread: { __fv: 'arrayUnion', values: [{ id: 'm1', text: 'สอบถาม' }] }
}, 'merge');
assert.strictEqual(again.thread.length, 1);

assert.strictEqual(logic.decodePath('/docs/user~preecha_d%40synnex.co.th'), '/docs/user~preecha_d@synnex.co.th');
assert.strictEqual(logic.checkId('user~preecha_d@synnex.co.th'), 'user~preecha_d@synnex.co.th');
assert.strictEqual(logic.checkId('user~somchai@synnex.co.th'), 'user~somchai@synnex.co.th');
assert.strictEqual(logic.checkId('user~~index'), 'user~~index');
assert.strictEqual(logic.checkId('x_CIV1_ORD'), 'x_CIV1_ORD');
assert.throws(() => logic.checkId('../etc'), /รหัสเอกสาร/);
assert.strictEqual(logic.isUserDoc('user~a@b.co'), true);
assert.strictEqual(logic.isUserDoc('user~~index'), false);
assert.strictEqual(logic.isUserDoc('c123'), false);

const salt = 'abc123';
const user = 'a@b.co';
const pass = 'secret1';
const h3 = logic.hashPw(user, pass, salt, 3);
const h2 = logic.hashPw(user, pass, salt, 2);
assert.strictEqual(h3.length, 64);
assert.strictEqual(h2.length, 64);
assert.notStrictEqual(h3, h2);
assert.strictEqual(logic.verifyPw({ salt, pass: h3, hashVer: 3 }, user, pass), true);
assert.strictEqual(logic.verifyPw({ salt, pass: h2, hashVer: 2 }, user, pass), true);
assert.strictEqual(logic.verifyPw({ salt, pass: h3, hashVer: 3 }, user, 'nope'), false);
assert.strictEqual(logic.hashPw(user, pass, salt, 3), logic.hashPw(user, pass, salt, 3));
assert.strictEqual(logic.isEmail('preecha_d@synnex.co.th'), true);
assert.strictEqual(logic.isEmail('whsadmin'), false);
assert.strictEqual(logic.hashToken('abc'), logic.hashToken('abc'));
assert.notStrictEqual(logic.hashToken('abc'), logic.hashToken('abd'));

console.log('logic.test.js ok');
