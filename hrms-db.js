// Same-origin client for /Huawei-Return/api (PostgreSQL behind the API).
// Presents the small slice of the Firestore API this page already calls:
// collection/doc get, set, update, batch, runTransaction, onSnapshot, FieldValue.
(function (global) {
  const FieldValue = {
    serverTimestamp() { return { __fv: 'serverTimestamp' }; },
    arrayUnion() { return { __fv: 'arrayUnion', values: Array.prototype.slice.call(arguments) }; }
  };

  function apiBase() {
    if (typeof global.HRMS_API === 'string' && global.HRMS_API) return global.HRMS_API.replace(/\/$/, '');
    const path = (global.location && global.location.pathname) || '/';
    const match = path.match(/^(.*)\/Huawei-Return(?:\/|$)/i);
    if (match) return match[1] + '/Huawei-Return/api';
    if (path.endsWith('/')) return path + 'api';
    return path.replace(/[^/]*$/, '') + 'api';
  }

  function apiErr(code, message) {
    const err = new Error(message || code);
    err.code = code;
    return err;
  }

  function connect() {
    const base = apiBase();
    const store = {
      docs: new Map(),
      cursor: { rev: 0, id: '' },
      listeners: [],
      chain: Promise.resolve(),
      boot: null,
      timer: null,
      offline: false
    };

    function enqueue(fn) {
      const run = store.chain.then(fn, fn);
      store.chain = run.then(function () {}, function () {});
      return run;
    }

    async function req(method, path, body) {
      let res;
      try {
        res = await fetch(base + path, {
          method: method,
          headers: body ? { 'Content-Type': 'application/json' } : undefined,
          body: body ? JSON.stringify(body) : undefined,
          cache: 'no-store'
        });
      } catch (e) {
        throw apiErr('unavailable', 'เชื่อมต่อ API ไม่ได้');
      }
      const text = await res.text();
      let json = null;
      if (text) { try { json = JSON.parse(text); } catch (e) { json = { error: text }; } }
      if (!res.ok) throw apiErr((json && json.code) || 'unknown', (json && json.error) || ('API ' + res.status));
      return json || {};
    }

    function merge(docs) {
      (docs || []).forEach(function (doc) {
        if (!doc || !doc.id) return;
        store.docs.set(doc.id, { body: doc.body, rev: Number(doc.rev) || 0 });
      });
    }

    async function pullAll() {
      let pages = 0;
      let changed = false;
      for (;;) {
        const page = await req('GET', '/sync?rev=' + encodeURIComponent(store.cursor.rev) + '&id=' + encodeURIComponent(store.cursor.id) + '&limit=500');
        if (page.docs && page.docs.length) { merge(page.docs); changed = true; }
        if (page.cursor && Number.isFinite(Number(page.cursor.rev))) store.cursor = { rev: Number(page.cursor.rev), id: page.cursor.id || '' };
        if (!page.more) break;
        if (++pages > 100000) throw apiErr('unavailable', 'ซิงก์นานผิดปกติ');
      }
      return changed;
    }

    function docSnap(id, row) {
      const body = row ? row.body : undefined;
      return {
        id: id,
        exists: !!row,
        metadata: { fromCache: store.offline, hasPendingWrites: false },
        data: function () { return body; }
      };
    }

    function emitOne(listener) {
      if (listener.kind === 'col') {
        const changes = [];
        const next = new Map();
        store.docs.forEach(function (row, id) {
          next.set(id, row.rev);
          const prev = listener.prev.get(id);
          if (prev == null) changes.push({ type: 'added', id: id, row: row });
          else if (prev !== row.rev) changes.push({ type: 'modified', id: id, row: row });
        });
        listener.prev.forEach(function (_rev, id) {
          if (!next.has(id)) changes.push({ type: 'removed', id: id, row: null });
        });
        const metaChanged = listener.seen && listener.fromCache !== store.offline;
        if (!changes.length && listener.seen && !metaChanged) return;
        listener.prev = next;
        listener.seen = true;
        listener.fromCache = store.offline;
        const docs = [];
        store.docs.forEach(function (row, id) { docs.push(docSnap(id, row)); });
        const listed = changes.map(function (change) {
          return { type: change.type, doc: docSnap(change.id, change.row) };
        });
        listener.cb({
          metadata: { fromCache: store.offline },
          docs: docs,
          docChanges: function () { return listed; }
        });
        return;
      }
      const row = store.docs.get(listener.id) || null;
      const rev = row ? row.rev : null;
      if (listener.seen && listener.rev === rev && listener.fromCache === store.offline) return;
      listener.seen = true;
      listener.rev = rev;
      listener.fromCache = store.offline;
      listener.cb(docSnap(listener.id, row));
    }

    function emit() { store.listeners.forEach(emitOne); }

    function fail(err) {
      const was = store.offline;
      store.offline = true;
      emit();
      if (was) return;
      store.listeners.forEach(function (listener) {
        if (listener.kind === 'col' && listener.seen && listener.err) listener.err(err);
      });
    }

    function arm() {
      if (store.timer || !store.listeners.length) return;
      store.timer = setTimeout(function () {
        store.timer = null;
        enqueue(async function () {
          try {
            const changed = await pullAll();
            if (changed || store.offline) { store.offline = false; emit(); }
          } catch (err) { fail(err); }
        }).finally(arm);
      }, 2000);
    }

    function ensure() {
      if (!store.boot) {
        store.boot = enqueue(async function () {
          await pullAll();
          store.offline = false;
          emit();
          arm();
        });
      }
      return store.boot;
    }

    function listen(kind, id, a, b, c) {
      let cb = b, err = c;
      if (typeof a === 'function') { cb = a; err = b; }
      const listener = { kind: kind, id: id, cb: cb, err: err, prev: new Map(), seen: false, fromCache: false, rev: undefined };
      store.listeners.push(listener);
      ensure().then(function () { emitOne(listener); }).catch(function (e) { if (err) err(e); });
      arm();
      return function () {
        store.listeners = store.listeners.filter(function (item) { return item !== listener; });
      };
    }

    function write(ops) {
      if (!ops.length) return Promise.resolve();
      return enqueue(async function () {
        const result = await req('POST', '/batch', { ops: ops });
        merge(result.docs);
        store.offline = false;
        emit();
        enqueue(async function () {
          try {
            const changed = await pullAll();
            if (changed) { store.offline = false; emit(); }
          } catch (err) { fail(err); }
        });
      });
    }

    function ref(id) {
      return {
        id: id,
        get: function () {
          return req('GET', '/docs/' + encodeURIComponent(id)).then(function (row) {
            if (row && row.exists) store.docs.set(id, { body: row.body, rev: Number(row.rev) || 0 });
            return docSnap(id, row && row.exists ? { body: row.body, rev: row.rev } : null);
          });
        },
        set: function (data, opts) { return write([{ op: opts && opts.merge ? 'merge' : 'set', id: id, data: data }]); },
        update: function (data) { return write([{ op: 'update', id: id, data: data }]); },
        onSnapshot: function (a, b, c) { return listen('doc', id, a, b, c); }
      };
    }

    return {
      enablePersistence: function () { return Promise.resolve(); },
      collection: function (name) {
        if (name !== 'return_cases') throw apiErr('invalid-argument', 'ไม่รู้จักชุดข้อมูล ' + name);
        return {
          doc: ref,
          onSnapshot: function (a, b, c) { return listen('col', '', a, b, c); }
        };
      },
      batch: function () {
        const ops = [];
        return {
          set: function (docRef, data, opts) { ops.push({ op: opts && opts.merge ? 'merge' : 'set', id: docRef.id, data: data }); },
          update: function (docRef, data) { ops.push({ op: 'update', id: docRef.id, data: data }); },
          commit: function () { return write(ops); }
        };
      },
      runTransaction: async function (fn) {
        const ops = [];
        const tx = {
          get: function (docRef) { return docRef.get(); },
          set: function (docRef, data, opts) { ops.push({ op: opts && opts.merge ? 'merge' : 'set', id: docRef.id, data: data }); },
          update: function (docRef, data) { ops.push({ op: 'update', id: docRef.id, data: data }); }
        };
        const result = await fn(tx);
        if (ops.length) await write(ops);
        return result;
      },
      listUsers: function () { return req('GET', '/users').then(function (row) { return row.users || []; }); }
    };
  }

  global.HrmsDb = { connect: connect, FieldValue: FieldValue, apiBase: apiBase };
})(window);
