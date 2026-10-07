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
  var lastWhere = null;              // the record this window last told the server it was on
  var es = null;
  var connected = false;
  var lastSeq = 0;
  var handlers = { changes: null, status: null, presence: null, reload: null };
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
  /* The shop-wide singletons. MUST match SETTING_KEYS in server/schema.js - a
     key on one side and not the other is a list that silently stops travelling.
     `materials` was exactly that: managed from Settings like regions and task
     types, and never once sent to anybody else's browser. */
  var SETTING_KEYS = ['regions', 'productTypes', 'taskTypes', 'materials',
    'portals', 'statuses', 'references', 'rates', 'company'];

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
    else {
      shadow[key] = JSON.stringify(change.json);
      // The rev this body is at. Without it the next edit here to the same
      // record went up carrying the rev from before, was refused as stale, and
      // the server's copy replaced what had been typed.
      if (change.rev != null) revs[key] = change.rev;
    }
  }

  /* ---- unsent edits ------------------------------------------------------ */

  function collectionOf(kind) {
    return COLLECTIONS.filter(function (x) { return x.kind === kind; })[0] || null;
  }

  function currentOf(db, kind, id) {
    if (kind === 'setting') return db[id];
    var c = collectionOf(kind);
    if (!c || !db[c.prop]) return undefined;
    if (c.shape === 'array') {
      return db[c.prop].filter(function (r) { return String(r.id) === String(id); })[0];
    }
    return db[c.prop][id];
  }

  function setRecord(db, kind, id, value) {
    if (kind === 'setting') { db[id] = value; return; }
    var c = collectionOf(kind);
    if (!c) return;
    if (c.shape === 'array') {
      var list = db[c.prop];
      var i = list.findIndex(function (r) { return String(r.id) === String(id); });
      if (i >= 0) list[i] = value; else list.push(value);
    } else {
      db[c.prop][id] = value;
    }
  }

  /* Has this screen changed the record since the server last confirmed it? */
  function isDirty(db, kind, id) {
    var key = keyOf(kind, id);
    var cur = currentOf(db, kind, id);
    if (cur === undefined) return shadow[key] !== undefined;
    return shadow[key] !== JSON.stringify(cur);
  }

  /* SOMEBODY ELSE'S CHANGE, LANDING ON A RECORD WITH EDITS NOT YET SENT.
   *
   * applyChange on its own replaced the record outright, and moved the shadow
   * to match - so whatever had been typed here and not yet sent disappeared,
   * and the diff could no longer even see that it had been there. That is how
   * a machine that had been offline lost everything it typed the moment it
   * caught up.
   *
   * A record with no local edits is still simply replaced. One with local
   * edits gets the three-way merge in js/merge.js: their change folded into
   * ours, the shadow moved to the server's copy and the rev to theirs, so the
   * next save sends the merged record as a clean edit on top of theirs.
   *
   * Returns the merge result ({value, conflicts}) when a merge happened, else
   * null. A remote delete always wins - there is nothing left to merge into. */
  function absorb(db, change) {
    var key = keyOf(change.kind, change.id);
    var local = currentOf(db, change.kind, change.id);
    if (change.op === 'delete' || !root.Merge || !isDirty(db, change.kind, change.id)) {
      applyChange(db, change);
      return null;
    }
    if (local === undefined) {
      // Deleted here, edited there: the delete stands, now against their rev.
      shadow[key] = JSON.stringify(change.json);
      if (change.rev != null) revs[key] = change.rev;
      return null;
    }
    var base = shadow[key] !== undefined ? JSON.parse(shadow[key]) : undefined;
    var r = root.Merge.merge3(base, local, change.json);
    setRecord(db, change.kind, change.id, r.value);
    shadow[key] = JSON.stringify(change.json);
    if (change.rev != null) revs[key] = change.rev;
    return r;
  }

  /* The unsent edits as something that can be written to disk and read back by
     the next page load: each one with the base it was made against, so it can
     be merged onto whatever the server holds by then rather than overwrite it. */
  function pending(db) {
    return diff(db).map(function (c) {
      var key = keyOf(c.kind, c.id);
      return {
        kind: c.kind, id: c.id, op: c.op, json: c.op === 'delete' ? null : c.json,
        base: shadow[key] !== undefined ? JSON.parse(shadow[key]) : null
      };
    });
  }

  /* An entry from pending(), saved by an earlier page, folded into a freshly
     loaded database. Returns the merge result, or null if there was nothing to
     restore (the server already has it, or the record has gone). */
  function restore(db, entry) {
    var server = currentOf(db, entry.kind, entry.id);
    if (entry.op === 'delete') {
      if (server === undefined) return null;
      // Only if nobody has touched it since - a delete must not take a
      // colleague's later work with it.
      if (root.Merge.eq(server, entry.base)) {
        if (entry.kind === 'setting') delete db[entry.id];
        else {
          var c = collectionOf(entry.kind);
          if (c.shape === 'array') {
            db[c.prop] = db[c.prop].filter(function (r) { return String(r.id) !== String(entry.id); });
          } else delete db[c.prop][entry.id];
        }
        return { value: null, conflicts: [] };
      }
      return null;
    }
    if (server === undefined && entry.base != null) return null;   // deleted on the server since
    if (server !== undefined && root.Merge.eq(server, entry.json)) return null;
    var r = root.Merge.merge3(entry.base == null ? undefined : entry.base, entry.json, server);
    setRecord(db, entry.kind, entry.id, r.value);
    return r;
  }

  /* ---- delivering changes ------------------------------------------------ */

  /* THE BODIES THAT DID NOT TRAVEL.
   *
   * A change to something large - a proposal, the rates list - arrives with
   * `json: null`, because the server stopped copying a megabyte into its change
   * log and down every open stream on each autosave. The record itself is
   * fetched here, in one request for the whole batch, and spliced back in
   * before anything downstream sees the list.
   *
   * Done at this level rather than in js/store.js so the rest of the app never
   * learns that a change can arrive hollow: handlers.changes is handed the same
   * fully-formed list it always was.
   *
   * A record that comes back missing was deleted after the change was logged.
   * Dropping it is correct - the delete is later in this same list, and applying
   * a put for a record that no longer exists would resurrect it.
   */
  function deliver(list) {
    if (!list || !list.length) return Promise.resolve(true);

    var hollow = list.filter(function (c) {
      return (c.op || 'put') !== 'delete' && c.json == null;
    });
    if (!hollow.length) {
      if (handlers.changes) handlers.changes(list);
      return Promise.resolve(true);
    }

    return api('/records', {
      method: 'POST',
      body: JSON.stringify({
        records: hollow.map(function (c) { return { kind: c.kind, id: c.id }; })
      })
    }).then(function (body) {
      var got = {};
      (body.records || []).forEach(function (r) { got[keyOf(r.kind, r.id)] = r; });

      // Filtered, not rebuilt: seq order is what makes a catch-up correct.
      var full = list.filter(function (c) {
        if ((c.op || 'put') === 'delete' || c.json != null) return true;
        var r = got[keyOf(c.kind, c.id)];
        if (!r) return false;
        c.json = r.json;
        // The fetch answered with the record's current rev, so take it: the
        // next local edit to this record can then be sent without being
        // refused as stale.
        revs[keyOf(c.kind, c.id)] = r.rev;
        return true;
      });
      if (full.length && handlers.changes) handlers.changes(full);
      return true;
    }).catch(function (e) {
      /* The bodies could not be fetched, so this batch cannot be applied
         without leaving the screen wrong. Say we are offline and report the
         failure, so the caller does not move lastSeq past a gap that was never
         applied - the stream's own retry comes back through catchUp. */
      setConnected(false, 'Could not fetch the records that changed.');
      console.error('Hydrating changes failed:', e);
      return false;
    });
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
      // A reconnected stream is a new connection as far as the server is
      // concerned, and it has no idea where this one is. Say so again.
      var was = lastWhere;
      lastWhere = null;
      if (was) {
        var bits = was.split(':');
        root.Remote.where(Number(bits[0]), bits[1] || null);
      }
      // Catch up on anything that happened while we were away before saying we
      // are connected, so the screen is never briefly wrong.
      catchUp().then(function () { setConnected(true); });
    });

    es.addEventListener('changes', function (ev) {
      var list = JSON.parse(ev.data);
      list.forEach(function (c) { if (c.seq > lastSeq) lastSeq = c.seq; });
      deliver(list);
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
     connection cheap - no reload, just the gap.

     Unless the gap is too big to send, which the server says by truncating.
     Applying a prefix and then setting lastSeq to the server's would skip
     everything in between and leave this browser confidently wrong, so a
     truncated answer is handed to the reload handler instead - the one case
     where reloading the world is the cheaper of the two. */
  function catchUp() {
    return api('/changes?since=' + lastSeq).then(function (body) {
      if (body.truncated) {
        if (handlers.reload) handlers.reload();
        return;
      }
      var to = body.seq || lastSeq;
      return deliver(body.changes).then(function (ok) {
        // Only once the gap is actually applied. Advancing past changes that
        // were fetched but never landed is how a browser ends up quietly
        // missing an edit for the rest of the afternoon.
        if (ok) lastSeq = to;
      });
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
    absorb: absorb,
    isDirty: isDirty,
    pending: pending,
    restore: restore,

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
          if (batch[i] && batch[i].op === 'delete') { delete shadow[key]; delete revs[key]; }
          // Unless a later change to the same record already arrived off the
          // stream while this request was in flight - then that one is newer,
          // and stepping the shadow back to what we sent would make the next
          // save look stale.
          else if (batch[i] && !(revs[key] > a.rev)) {
            revs[key] = a.rev;
            shadow[key] = JSON.stringify(batch[i].json);
          }
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

    /* "I am looking at this bid", so the other people on the stream can see it.
       Sent only when it actually changes - navigating within one project fires
       this on every tab, and repeating a position would repaint every other
       screen in the office for nothing. Failure is silent: an indicator that
       does not appear is not worth a message about. */
    where: function (bidId, section) {
      var next = bidId == null ? '' : bidId + ':' + (section || '');
      if (next === lastWhere) return Promise.resolve();
      lastWhere = next;
      if (!clientId) return Promise.resolve();      // no stream yet; sent on connect
      return api('/where', {
        method: 'POST',
        body: JSON.stringify({ clientId: clientId, bidId: bidId == null ? null : bidId,
                               section: section || null })
      }).catch(function () { /* presence is a courtesy, never an error */ });
    },

    connect: connect,
    disconnect: disconnect,
    catchUp: catchUp,
    onChanges: function (fn) { handlers.changes = fn; },
    onStatus: function (fn) { handlers.status = fn; },
    onPresence: function (fn) { handlers.presence = fn; },
    /* Called when this browser has been away long enough that the gap is too
       large to send. Reloading the world is the cheaper of the two answers
       here, and the only correct one. */
    onReload: function (fn) { handlers.reload = fn; }
  };
})(window);
