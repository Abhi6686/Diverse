/* remote.js - the client half of the shared database.
 *
 * js/store.js owns the in-memory state and the contract every other module
 * relies on (read Store.db synchronously, call Store.save()). This file owns
 * the wire: fetching the world at boot, working out what actually changed,
 * pushing it, and listening for what everyone else did.
 *
 * The split matters because the twenty feature modules never learn that the
 * data lives anywhere but memory. Store.save() means the same thing it always
 * did; only what happens underneath is different.
 */
(function (root) {
  'use strict';

  var BASE = '/api';
  var clientId = null;               // our SSE connection, so our own writes do not echo back
  var es = null;
  var connected = false;
  var lastSeq = 0;
  var handlers = { changes: null, status: null, presence: null };
  var retry = null;
  var retryDelay = 1000;

  /* The collections that live on the server, and how they are shaped on the
     client. `ui` is deliberately absent: it is one person's column layout and
     scroll position, not shared data. */
  var COLLECTIONS = [
    { kind: 'bid', prop: 'bids', shape: 'array' },
    { kind: 'takeoff', prop: 'takeoffs', shape: 'map' },
    { kind: 'proposal', prop: 'proposals', shape: 'map' },
    { kind: 'catalog', prop: 'catalog', shape: 'array' },
    { kind: 'engineer', prop: 'engineers', shape: 'array' }
  ];
  var SETTING_KEYS = ['regions', 'productTypes', 'taskTypes', 'references', 'rates', 'company'];

  /* What the server last confirmed it holds: 'kind:id' -> JSON string, and the
     rev we read. Diffing against this is how save() knows what to send without
     every call site having to say which record it touched. */
  var shadow = {};
  var revs = {};

  function canFetch() {
    return typeof root.fetch === 'function' &&
      root.location && /^https?:$/.test(root.location.protocol);
  }

  function api(path, options) {
    return root.fetch(BASE + path, Object.assign({
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }
    }, options || {})).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) {
          var err = new Error(body.error || ('HTTP ' + res.status));
          err.status = res.status;
          err.body = body;
          throw err;
        }
        return body;
      });
    });
  }

  /* ---- snapshot bookkeeping --------------------------------------------- */

  function keyOf(kind, id) { return kind + ':' + id; }

  /* Records what the server holds, so the next save can tell what moved. */
  function remember(db) {
    shadow = {};
    COLLECTIONS.forEach(function (c) {
      each(db[c.prop], c.shape, function (rec, id) {
        shadow[keyOf(c.kind, id)] = JSON.stringify(rec);
      });
    });
    SETTING_KEYS.forEach(function (k) {
      if (db[k] !== undefined) shadow[keyOf('setting', k)] = JSON.stringify(db[k]);
    });
  }

  function each(coll, shape, fn) {
    if (!coll) return;
    if (shape === 'array') {
      coll.forEach(function (rec) { if (rec && rec.id != null) fn(rec, rec.id); });
    } else {
      Object.keys(coll).forEach(function (id) { fn(coll[id], id); });
    }
  }

  /* Everything that differs from the server's copy, as a change batch. Cheap:
     the whole dataset is a few hundred kilobytes and stringifying all of it
     takes well under a millisecond. */
  function diff(db) {
    var batch = [];
    var seen = {};

    COLLECTIONS.forEach(function (c) {
      each(db[c.prop], c.shape, function (rec, id) {
        var key = keyOf(c.kind, id);
        seen[key] = true;
        var json = JSON.stringify(rec);
        if (shadow[key] === json) return;
        batch.push({ kind: c.kind, id: id, op: 'put', json: rec, rev: revs[key] || null });
      });
    });

    SETTING_KEYS.forEach(function (k) {
      if (db[k] === undefined) return;
      var key = keyOf('setting', k);
      seen[key] = true;
      var json = JSON.stringify(db[k]);
      if (shadow[key] === json) return;
      batch.push({ kind: 'setting', id: k, op: 'put', json: db[k], rev: revs[key] || null });
    });

    // Anything the server has that the client no longer does was deleted here.
    Object.keys(shadow).forEach(function (key) {
      if (seen[key]) return;
      var split = key.indexOf(':');
      batch.push({
        kind: key.slice(0, split), id: key.slice(split + 1), op: 'delete'
      });
    });

    return batch;
  }

  /* Applies one change to the in-memory database - used for both a remote edit
     arriving and the server's copy winning a conflict. */
  function applyChange(db, change) {
    var c = COLLECTIONS.filter(function (x) { return x.kind === change.kind; })[0];
    var key = keyOf(change.kind, change.id);

    if (change.kind === 'setting') {
      if (change.op === 'delete') delete db[change.id];
      else db[change.id] = change.json;
      shadow[key] = change.op === 'delete' ? undefined : JSON.stringify(change.json);
      if (change.op === 'delete') delete shadow[key];
      return;
    }
    if (!c) return;

    if (c.shape === 'array') {
      var list = db[c.prop];
      var i = list.findIndex(function (r) { return String(r.id) === String(change.id); });
      if (change.op === 'delete') { if (i >= 0) list.splice(i, 1); }
      else if (i >= 0) list[i] = change.json;
      else list.push(change.json);
    } else {
      if (change.op === 'delete') delete db[c.prop][change.id];
      else db[c.prop][change.id] = change.json;
    }

    if (change.op === 'delete') { delete shadow[key]; delete revs[key]; }
    else shadow[key] = JSON.stringify(change.json);
  }

  /* ---- the live stream --------------------------------------------------- */

  function setConnected(state, detail) {
    if (connected === state) return;
    connected = state;
    if (handlers.status) handlers.status(state, detail);
  }

  function connect() {
    if (typeof root.EventSource !== 'function') return;   // jsdom, or a very old browser
    disconnect();

    try { es = new root.EventSource(BASE + '/stream'); }
    catch (e) { scheduleRetry(); return; }

    es.addEventListener('hello', function (ev) {
      var d = JSON.parse(ev.data);
      clientId = d.clientId;
      retryDelay = 1000;
      // Catch up on anything that happened while we were away before saying we
      // are connected, so the screen is never briefly wrong.
      catchUp().then(function () { setConnected(true); });
    });

    es.addEventListener('changes', function (ev) {
      var list = JSON.parse(ev.data);
      list.forEach(function (c) { if (c.seq > lastSeq) lastSeq = c.seq; });
      if (handlers.changes) handlers.changes(list);
    });

    es.addEventListener('presence', function (ev) {
      if (handlers.presence) handlers.presence(JSON.parse(ev.data).online);
    });

    es.onerror = function () {
      // EventSource retries by itself, but it does not tell us it has, and we
      // need the banner up meanwhile.
      setConnected(false, 'The server is not responding.');
    };
  }

  function disconnect() {
    if (!es) return;
    try { es.close(); } catch (e) { /* already closed */ }
    es = null;
  }

  function scheduleRetry() {
    if (retry) return;
    retry = setTimeout(function () {
      retry = null;
      connect();
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 15000);   // back off, but keep trying
  }

  /* Everything that happened since our last seq. This is what makes a dropped
     connection cheap - no reload, just the gap. */
  function catchUp() {
    return api('/changes?since=' + lastSeq).then(function (body) {
      if (body.changes && body.changes.length && handlers.changes) {
        handlers.changes(body.changes);
      }
      lastSeq = body.seq || lastSeq;
    }).catch(function () { /* the stream will retry */ });
  }

  root.Remote = {
    COLLECTIONS: COLLECTIONS,
    SETTING_KEYS: SETTING_KEYS,

    get clientId() { return clientId; },
    get connected() { return connected; },
    get seq() { return lastSeq; },

    /* Is there a server behind this page at all? Answers no for file:// and for
       a build served by something that is not serve.js, so the app falls back
       to the local backends rather than failing. */
    probe: function () {
      if (!canFetch()) return Promise.resolve(false);
      return api('/health').then(function () { return true; })
        .catch(function () { return false; });
    },

    bootstrap: function () {
      return api('/bootstrap').then(function (body) {
        lastSeq = body.seq || 0;
        revs = (body.db && body.db.revs) || {};
        return body;
      });
    },

    remember: remember,
    diff: diff,
    applyChange: applyChange,

    /* Sends a batch and returns what the server made of it. A conflict or a
       duplicate comes back as a rejected promise carrying the server's version,
       so the caller can put the truth on screen rather than guessing. */
    push: function (batch, reason) {
      if (!batch.length) return Promise.resolve({ applied: [] });
      return api('/changes', {
        method: 'POST',
        // `reason` tells the server this batch is a whole-database restore
        // rather than ordinary editing, so it can hold the caller to
        // project.load on top of the per-record checks it makes anyway.
        body: JSON.stringify({ clientId: clientId, changes: batch, reason: reason || null })
      }).then(function (body) {
        (body.applied || []).forEach(function (a, i) {
          var key = keyOf(a.kind, a.id);
          revs[key] = a.rev;
          if (batch[i] && batch[i].op === 'delete') { delete shadow[key]; delete revs[key]; }
          else if (batch[i]) shadow[key] = JSON.stringify(batch[i].json);
          if (a.seq > lastSeq) lastSeq = a.seq;
        });
        return body;
      });
    },

    setRev: function (kind, id, rev) { revs[keyOf(kind, id)] = rev; },

    /* One person's column layout, against their account rather than in this
       browser. Deliberately outside the change log: it is a preference, not a
       record, so it is neither versioned nor broadcast - hiding a column must
       not repaint anybody else's screen. */
    savePrefs: function (ui) {
      return api('/prefs', { method: 'PUT', body: JSON.stringify({ prefs: ui }) });
    },
    loadPrefs: function () {
      return api('/prefs').then(function (b) { return b.prefs || null; });
    },

    connect: connect,
    disconnect: disconnect,
    catchUp: catchUp,
    onChanges: function (fn) { handlers.changes = fn; },
    onStatus: function (fn) { handlers.status = fn; },
    onPresence: function (fn) { handlers.presence = fn; }
  };
})(window);
