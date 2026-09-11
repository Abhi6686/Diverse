/* api.js - the HTTP surface.
 *
 * The data routes carry the shared database:
 *
 *   GET  /api/bootstrap        everything, plus the seq it is current as of
 *   POST /api/changes          a batch of edits, applied as one transaction
 *   GET  /api/changes?since=N  what was missed while disconnected
 *   POST /api/records          the bodies too large to travel with their change
 *   GET  /api/stream           SSE: what other people are doing, live
 *   GET/PUT /api/prefs         one person's column layouts
 *
 * The account routes decide who may use them:
 *
 *   GET  /api/session          who am I, and what may I do
 *   POST /api/setup            create the very first Admin (only when there are none)
 *   POST /api/login /logout
 *   /api/users, /api/roles     administration
 *
 * Only /api/health, /api/session, /api/setup and /api/login are reachable
 * without a session. Everything else is refused with 401, and every write is
 * checked against the caller's role before it reaches the database - see
 * assertAllowed(). A button hidden on the client stops an honest mistake; this
 * is what actually protects the data.
 */
'use strict';

const db = require('./db');
const sync = require('./sync');
const schema = require('./schema');
const auth = require('./auth');
const perms = require('./permissions');

const MAX_BODY = 8 * 1024 * 1024;   // a takeoff with hundreds of rows is ~200KB

/* Reachable with no session. Deliberately short: health so the client can find
   out whether a server is there at all, and the three routes it takes to get a
   session in the first place. */
const OPEN_ROUTES = ['/api/health', '/api/session', '/api/setup', '/api/login', '/api/logout'];

function json(res, status, body, headers) {
  const text = JSON.stringify(body);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store'
  }, headers || {}));
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      // Refuse early rather than buffering an unbounded upload into memory.
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve(null);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(Object.assign(new Error('Body is not valid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

/* Every write is checked before it reaches the database: an unknown kind, a
   missing id or a record that is not an object would otherwise become a row
   nothing can read back. */
function validateBatch(batch) {
  if (!Array.isArray(batch)) throw Object.assign(new Error('Expected an array of changes'), { status: 400 });
  if (batch.length > 2000) throw Object.assign(new Error('Too many changes in one batch'), { status: 413 });
  for (const item of batch) {
    if (!item || typeof item !== 'object') {
      throw Object.assign(new Error('Each change must be an object'), { status: 400 });
    }
    if (!schema.KINDS[item.kind]) {
      throw Object.assign(new Error('Unknown kind: ' + item.kind), { status: 400 });
    }
    if (item.id === undefined || item.id === null || item.id === '') {
      throw Object.assign(new Error('Change is missing an id'), { status: 400 });
    }
    const op = item.op || 'put';
    if (op !== 'put' && op !== 'delete') {
      throw Object.assign(new Error('Unknown op: ' + op), { status: 400 });
    }
    if (op === 'put' && (!item.json || typeof item.json !== 'object')) {
      throw Object.assign(new Error('A put needs a json object'), { status: 400 });
    }
  }
}

/* The permission check, item by item, against what the database currently holds
   for each record. Runs before anything is written, so a batch containing one
   edit the caller may not make is refused whole rather than half-applied.

   `reason` is what the client says it is doing. It is not trusted as a
   permission by itself - a restore is still made of ordinary deletes and puts,
   each of which is checked on its own - but a caller that admits to restoring
   is held to project.load as well. */
function assertAllowed(batch, user, reason) {
  if (reason === 'load') auth.require(user, 'project.load');

  const needed = new Set();
  for (const item of batch) {
    const row = db.getOne(item.kind, item.id);
    let existing = null;
    if (row) { try { existing = JSON.parse(row.json); } catch (e) { existing = null; } }
    const perm = perms.requiredFor(item, existing);
    if (perm) needed.add(perm);
  }
  for (const perm of needed) auth.require(user, perm);
}

/* ---- the engineer behind an account ------------------------------------ */

/* One person is one account is one engineer. Creating somebody with initials
   attaches them to the register the bids table already names people through -
   matching an existing entry where there is one, so historical Team & Hours
   rows attach to the right person rather than a duplicate appearing beside
   them.

   Written through the ordinary change log and broadcast, so every browser
   already open sees the new name in its dropdowns without a reload. */
function linkEngineer(user, actorId) {
  const initials = String(user.initials || '').trim();
  if (!initials) return null;

  const rows = db.allOf('engineer').map(r => {
    let rec = null;
    try { rec = JSON.parse(r.json); } catch (e) { /* skip a corrupt row */ }
    return { id: r.id, rev: r.rev, rec };
  }).filter(x => x.rec);

  const match = rows.find(x => String(x.rec.initials || '').toLowerCase() === initials.toLowerCase());
  const already = rows.find(x => x.rec.userId === user.id);
  // They had different initials before: let go of the old row rather than
  // leaving one person attached to two entries.
  if (already && (!match || already.id !== match.id)) {
    const freed = Object.assign({}, already.rec, { userId: null });
    db.put('engineer', already.id, freed, already.rev, actorId);
    sync.broadcast([{ kind: 'engineer', id: already.id, op: 'put', json: freed }], null);
  }

  let id, rec, rev;
  if (match) {
    if (match.rec.userId === user.id && match.rec.name === user.name) return match.id;
    id = match.id;
    rev = match.rev;
    rec = Object.assign({}, match.rec, { userId: user.id, name: user.name || match.rec.name });
  } else {
    id = 'eng-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    rev = null;
    rec = { id, initials: initials.toUpperCase(), name: user.name || '', active: true, userId: user.id };
  }

  const out = db.put('engineer', id, rec, rev, actorId);
  sync.broadcast([{ kind: 'engineer', id: id, op: 'put', json: rec, seq: out.seq }], null);
  return id;
}

/* ---- routing ------------------------------------------------------------ */

/* Returns true if it handled the request. serve.js falls through to static
   files when this says no. */
async function handle(req, res, ctx) {
  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname;
  if (!route.startsWith('/api/')) return false;

  let user = null;
  try {
    user = auth.currentUser(req);
  } catch (e) {
    // A database that has not reached schema v2 yet has no sessions table.
    // Treated as "nobody is signed in", which is exactly right.
    user = null;
  }

  try {
    /* ---- open routes --------------------------------------------------- */

    if (route === '/api/health' && req.method === 'GET') {
      json(res, 200, {
        ok: true, seq: db.latestSeq(), clients: sync.count,
        schema: schema.LATEST, signedIn: !!user
      });
      return true;
    }

    if (route === '/api/session' && req.method === 'GET') {
      json(res, 200, {
        // No accounts at all means a brand-new install: the app shows the
        // setup screen rather than a login nobody could pass.
        setupNeeded: !auth.anyUsers(),
        user: user ? publicSelf(user) : null,
        catalogue: perms.PERMISSIONS
      });
      return true;
    }

    if (route === '/api/setup' && req.method === 'POST') {
      const body = (await readBody(req)) || {};
      const created = auth.setupFirstAdmin(body);
      const full = auth.userById(created.id);
      linkEngineer(auth.publicUser(full), created.id);
      const session = auth.startSession(created.id);
      json(res, 200, { user: publicSelf(sessionOf(created.id)), catalogue: perms.PERMISSIONS },
        { 'Set-Cookie': auth.cookieHeader(session.token, session.expires) });
      return true;
    }

    if (route === '/api/login' && req.method === 'POST') {
      const body = (await readBody(req)) || {};
      const out = auth.login(body.username, body.password);
      json(res, 200, { user: publicSelf(out.user), catalogue: perms.PERMISSIONS },
        { 'Set-Cookie': auth.cookieHeader(out.session.token, out.session.expires) });
      return true;
    }

    if (route === '/api/logout' && req.method === 'POST') {
      if (user) auth.revoke(user.token);
      json(res, 200, { ok: true }, { 'Set-Cookie': auth.clearedCookieHeader() });
      return true;
    }

    /* ---- everything below needs a session ------------------------------ */

    if (!user && OPEN_ROUTES.indexOf(route) < 0) {
      json(res, 401, {
        error: 'Sign in first.', code: 'nosession',
        setupNeeded: !auth.anyUsers()
      });
      return true;
    }

    if (route === '/api/bootstrap' && req.method === 'GET') {
      const snap = db.snapshot();
      json(res, 200, {
        db: snap,
        seq: snap.seq,
        /* Whether this database has ever held any records, which is not the
           same question as "is its change log empty" - creating the first
           administrator already writes their engineer row. The client seeds a
           virgin database and must never seed one that has merely been emptied
           on purpose, so the test is the records themselves. */
        virgin: db.isEmpty(),
        user: publicSelf(user),
        prefs: db.getPrefs(user.id),
        catalogue: perms.PERMISSIONS,
        serverTime: new Date().toISOString()
      });
      return true;
    }

    if (route === '/api/prefs' && req.method === 'GET') {
      json(res, 200, { prefs: db.getPrefs(user.id) });
      return true;
    }

    /* Nobody else's layout, ever: the row written is the caller's own, taken
       from the session rather than from anything the request said. */
    if (route === '/api/prefs' && (req.method === 'PUT' || req.method === 'POST')) {
      const body = (await readBody(req)) || {};
      db.setPrefs(user.id, body.prefs === undefined ? body : body.prefs);
      json(res, 200, { ok: true });
      return true;
    }

    /* "I am looking at this bid." Broadcast to everyone else on the stream so
       two people on one project can see each other before they find out from
       the change log.

       A session is required and nothing more. It grants no access and reveals
       nothing about the record - only that somebody has open a bid they were
       already entitled to open. */
    if (route === '/api/where' && req.method === 'POST') {
      const body = (await readBody(req)) || {};
      sync.setWhere(body.clientId, body.bidId == null ? null : {
        bidId: body.bidId,
        section: typeof body.section === 'string' ? body.section.slice(0, 40) : null
      });
      json(res, 200, { ok: true });
      return true;
    }

    if (route === '/api/changes' && req.method === 'GET') {
      const since = Number(url.searchParams.get('since') || 0);
      const out = db.changesSince(since, 5000);
      json(res, 200, {
        seq: db.latestSeq(),
        /* The list is a prefix of the gap, not the whole of it - the client
           must reload rather than apply it and believe it is caught up. */
        truncated: out.truncated,
        changes: out.rows.map(r => ({
          seq: r.seq, kind: r.kind, id: r.entity_id, op: r.op,
          json: r.json ? JSON.parse(r.json) : null, at: r.at, by: r.by
        }))
      });
      return true;
    }

    /* The bodies the change log and the stream deliberately did not carry.
     *
     * A change to something large - a proposal, the rates list - is announced
     * without its body, because copying a megabyte into the log on every
     * autosave is what turned a 3MB dataset into a 107MB file. The client asks
     * here for the records it was told about, in one request rather than one
     * per record.
     *
     * What comes back is the record as it stands now, not as it stood at that
     * seq. That is the right answer for a client catching up: it is about to
     * step past every later seq anyway. A record that has since been deleted is
     * simply absent - the delete is later in the same list. */
    if (route === '/api/records' && req.method === 'POST') {
      const body = (await readBody(req)) || {};
      const want = Array.isArray(body) ? body : body.records;
      if (!Array.isArray(want)) {
        throw Object.assign(new Error('Expected an array of {kind, id}'), { status: 400 });
      }
      if (want.length > 500) {
        throw Object.assign(new Error('Too many records in one request'), { status: 413 });
      }
      const records = [];
      for (const w of want) {
        if (!w || !schema.KINDS[w.kind] || w.id == null || w.id === '') continue;
        const row = db.getOne(w.kind, w.id);
        if (!row) continue;
        try {
          records.push({ kind: w.kind, id: row.id, json: JSON.parse(row.json), rev: row.rev });
        } catch (e) { /* a corrupt row is a miss, not a failed request */ }
      }
      json(res, 200, { records: records });
      return true;
    }

    if (route === '/api/changes' && req.method === 'POST') {
      const body = await readBody(req);
      const batch = body && body.changes ? body.changes : body;
      validateBatch(batch);
      assertAllowed(batch, user, body && body.reason);

      let applied;
      try {
        applied = db.putMany(batch, user.id);
      } catch (e) {
        if (e.name === 'Conflict') {
          // 409 with the server's copy, so the client can show what it lost
          // instead of overwriting somebody else's edit.
          json(res, 409, {
            error: 'conflict', kind: e.kind, id: e.id,
            current: e.current.json, rev: e.current.rev
          });
          return true;
        }
        if (e.name === 'Duplicate') {
          json(res, 409, { error: 'duplicate', field: e.field, value: e.value, message: e.message });
          return true;
        }
        throw e;
      }

      /* Tell everyone else, then answer the writer with the new revs.
         Large bodies are withheld on exactly the rule the log uses, so one
         proposal save does not push a megabyte down every open stream in the
         office; the client fetches those from /api/records. */
      const originId = body && body.clientId ? body.clientId : null;
      sync.broadcast(applied.map((a, i) => ({
        seq: a.seq, kind: a.kind, id: a.id,
        op: batch[i].op || 'put',
        json: (batch[i].op === 'delete' || !db.bodyTravels(batch[i].json))
          ? null : batch[i].json,
        by: user.id,
        byName: user.name
      })), originId);

      json(res, 200, { applied: applied, seq: db.latestSeq() });
      return true;
    }

    if (route === '/api/stream' && req.method === 'GET') {
      sync.add(res, req, user);
      return true;                       // stays open; do not end the response
    }

    /* ---- administration ------------------------------------------------ */

    if (route === '/api/users' && req.method === 'GET') {
      auth.require(user, 'admin.users');
      json(res, 200, { users: auth.listUsers(), roles: auth.listRoles() });
      return true;
    }

    if (route === '/api/users' && req.method === 'POST') {
      auth.require(user, 'admin.users');
      const body = (await readBody(req)) || {};
      const created = auth.createUser(body);
      linkEngineer(created, user.id);
      json(res, 200, { user: created });
      return true;
    }

    const userMatch = /^\/api\/users\/(\d+)$/.exec(route);
    if (userMatch) {
      const id = Number(userMatch[1]);
      if (req.method === 'PATCH' || req.method === 'PUT') {
        // Changing your own password is not administration. Anything else about
        // an account is.
        const body = (await readBody(req)) || {};
        const self = id === user.id && Object.keys(body).every(k => k === 'password' || k === 'name');
        if (!self) auth.require(user, 'admin.users');
        if (self && body.password !== undefined) body.keepSession = user.token;
        const updated = auth.updateUser(id, body, user);
        if (body.initials !== undefined || body.name !== undefined) linkEngineer(updated, user.id);
        json(res, 200, { user: updated });
        return true;
      }
      if (req.method === 'DELETE') {
        auth.require(user, 'admin.users');
        auth.deleteUser(id, user);
        json(res, 200, { ok: true });
        return true;
      }
    }

    if (route === '/api/roles' && req.method === 'GET') {
      // Any signed-in person may read the catalogue - the Roles *screen* needs
      // admin.roles, but knowing what the permissions are called is not secret
      // and the client needs the labels to render its own menus.
      json(res, 200, { roles: auth.listRoles(), catalogue: perms.PERMISSIONS });
      return true;
    }

    if (route === '/api/roles' && req.method === 'POST') {
      auth.require(user, 'admin.roles');
      const body = (await readBody(req)) || {};
      json(res, 200, { role: auth.createRole(body.name, body.permissions) });
      return true;
    }

    const roleMatch = /^\/api\/roles\/(\d+)$/.exec(route);
    if (roleMatch) {
      auth.require(user, 'admin.roles');
      const id = Number(roleMatch[1]);
      if (req.method === 'PATCH' || req.method === 'PUT') {
        const body = (await readBody(req)) || {};
        json(res, 200, { role: auth.updateRole(id, body, user) });
        return true;
      }
      if (req.method === 'DELETE') {
        auth.deleteRole(id);
        json(res, 200, { ok: true });
        return true;
      }
    }

    json(res, 404, { error: 'No such endpoint: ' + route });
    return true;
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error('API error on ' + route + ':', e);
    json(res, status, { error: e.message || 'Server error', code: e.code || null });
    return true;
  }
}

/* What the signed-in person is told about themselves. Never a hash, never
   anybody else's details. */
function publicSelf(u) {
  return {
    id: u.id, username: u.username, email: u.email || '', name: u.name, initials: u.initials || '',
    roleId: u.roleId, role: u.role, permissions: u.permissions
  };
}

function sessionOf(userId) {
  const row = auth.userById(userId);
  return {
    id: row.id, username: row.username, email: row.email || '', name: row.name,
    initials: row.initials || '',
    roleId: row.role_id, role: row.role_name,
    permissions: auth.permsOfRole(row.role_id)
  };
}

module.exports = { handle, readBody, json, assertAllowed, linkEngineer };
