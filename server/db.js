/* db.js - the SQLite database and every statement that touches it.
 *
 * node:sqlite is built into Node 22, so this whole layer costs no npm install -
 * the property the project has kept from the start. Node marks it experimental
 * and prints a warning; serve.js starts with --no-warnings to silence it. It
 * becomes stable in Node 24 and the API used here does not change.
 *
 * Everything is synchronous. That is not a compromise: SQLite reads are
 * microseconds, the dataset is a few hundred kilobytes, and an office of twenty
 * estimators generates a write every few seconds. Async would buy contention
 * bugs and nothing else.
 */
'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const schema = require('./schema');

let db = null;
let dbPath = null;

/* How big a record's json may be before the change log stops carrying a copy of
   it. Above this the log records that the record changed and leaves the body to
   /api/records - see logChange.

   A size test rather than a list of kinds: it is the 900KB proposal and the
   900KB rates list that matter, and both arrive under kinds that are usually
   small. 32KB clears every bid, engineer and catalog entry by a wide margin. */
const LOG_BODY_MAX = 32 * 1024;

/* How many bytes of change bodies one catch-up response may carry. A client
   that has been away long enough to exceed it is told to reload instead. */
const CATCHUP_MAX_BYTES = 2 * 1024 * 1024;

/* Prepared statements, by their SQL. node:sqlite compiles on prepare(), and
   putMany can run two thousand writes in one batch - recompiling the same four
   statements two thousand times was the largest cost in a large save. */
let stmts = new Map();
function stmt(sql) {
  let s = stmts.get(sql);
  if (!s) { s = handle().prepare(sql); stmts.set(sql, s); }
  return s;
}

function open(file, log) {
  dbPath = file || path.join(__dirname, '..', 'diverse.db');

  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  db = new DatabaseSync(dbPath);
  stmts = new Map();

  // WAL lets readers carry on while a write is in flight, which is what keeps
  // the table responsive once several people are on it. NORMAL sync is the
  // right trade with WAL: a power cut can lose the last transaction, not the
  // database. foreign_keys is off by default in SQLite and has to be asked for.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  // Wait rather than throw if another process holds the write lock.
  db.exec('PRAGMA busy_timeout = 5000');
  // Scratch tables for sorts and the VACUUM below stay in memory, and the page
  // cache gets 16MB (negative means KiB rather than pages). Both are per
  // connection, not stored in the file.
  db.exec('PRAGMA temp_store = MEMORY');
  db.exec('PRAGMA cache_size = -16000');

  const before = schema.currentVersionSafe(db);
  schema.migrate(db, log);

  /* Step 4 empties the oversized bodies out of the change log, which frees the
     pages but does not shrink the file - only VACUUM does that, and VACUUM
     cannot run inside a transaction, so migrate() cannot be the one to do it.
     Once, on the run that migrates, and never again. */
  if (before < 4 && schema.currentVersion(db) >= 4 && dbPath !== ':memory:') {
    if (log) log('  reclaiming space from the change log (VACUUM)...');
    db.exec('VACUUM');
    if (log) log('  done.');
  }
  return db;
}

function close() {
  stmts = new Map();
  if (db) { db.close(); db = null; }
}

function handle() {
  if (!db) throw new Error('Database is not open');
  return db;
}

/* Runs fn inside a transaction, rolling back if it throws. Nested calls join
   the transaction already running rather than starting a second one, which
   SQLite would refuse. */
let depth = 0;
function tx(fn) {
  if (depth > 0) return fn();
  handle().exec('BEGIN IMMEDIATE');
  depth++;
  try {
    const out = fn();
    depth--;
    handle().exec('COMMIT');
    return out;
  } catch (e) {
    depth--;
    try { handle().exec('ROLLBACK'); } catch (ignored) { /* already rolled back */ }
    throw e;
  }
}

/* ---- reading ----------------------------------------------------------- */

function allOf(kind) {
  const def = schema.KINDS[kind];
  if (!def) throw new Error('Unknown kind: ' + kind);
  return stmt('SELECT id, json, rev FROM ' + def.table).all();
}

function getOne(kind, id) {
  const def = schema.KINDS[kind];
  if (!def) throw new Error('Unknown kind: ' + kind);
  return stmt('SELECT id, json, rev FROM ' + def.table + ' WHERE id = ?')
    .get(def.idType === 'number' ? Number(id) : String(id));
}

/* The whole dataset in the shape js/store.js holds it, so the client can drop
   it straight into DB without a translation layer on top of the one here. */
function snapshot() {
  const out = {
    bids: [], takeoffs: {}, proposals: {}, catalog: [], engineers: [],
    revs: {}
  };

  for (const c of schema.COLLECTIONS) {
    for (const row of allOf(c.kind)) {
      const rec = JSON.parse(row.json);
      if (c.shape === 'array') out[c.prop].push(rec);
      else out[c.prop][row.id] = rec;
      out.revs[c.kind + ':' + row.id] = row.rev;
    }
  }
  // Bids come back in id order so an unsorted table is at least stable.
  out.bids.sort((a, b) => a.id - b.id);

  for (const row of allOf('setting')) {
    out[row.id] = JSON.parse(row.json);
    out.revs['setting:' + row.id] = row.rev;
  }

  out.seq = latestSeq();
  return out;
}

function latestSeq() {
  const row = stmt('SELECT MAX(seq) AS seq FROM changes').get();
  return row && row.seq ? row.seq : 0;
}

/* What happened after `seq`, bounded twice over.
 *
 * The row limit was never the binding one: a handful of proposal saves is a
 * few hundred rows and tens of megabytes, which is not a response, it is an
 * outage. So the bytes are counted as the rows are taken and the walk stops at
 * the budget. `truncated` tells the caller the list is a prefix, not the whole
 * gap - the client reloads rather than applying half of it and believing it is
 * caught up. */
function changesSince(seq, limit, maxBytes) {
  const rows = stmt(
    'SELECT seq, kind, entity_id, op, json, at, by FROM changes ' +
    'WHERE seq > ? ORDER BY seq LIMIT ?').all(Number(seq) || 0, limit || 5000);

  const budget = maxBytes || CATCHUP_MAX_BYTES;
  const out = [];
  let bytes = 0;
  for (const row of rows) {
    bytes += row.json ? row.json.length : 0;
    // Always take the first row, or a single change larger than the budget
    // would stall the client forever on a gap it can never step over.
    if (bytes > budget && out.length) return { rows: out, truncated: true };
    out.push(row);
  }
  return { rows: out, truncated: false };
}

/* ---- writing ----------------------------------------------------------- */

/* Columns kept beside the json for the bid, so the database can index and
   constrain what the app searches and sorts on. Derived from the record on
   every write, never edited independently - one source of truth, the json. */
function bidColumns(rec) {
  return {
    proposal_no: (rec.proposalNo || '').trim() || null,
    project: rec.project || '',
    status: rec.status || null,
    region: rec.region || null,
    portal: rec.portal || null,
    active: rec.active ? 1 : 0,
    award_no: (rec.awardNo || '').trim() || null,
    due_date: rec.dueDate || null,
    price: rec.price == null ? null : Number(rec.price)
  };
}

/* A conflict, not an exception: somebody else wrote this record between the
   client reading it and sending its edit. The caller returns the server's copy
   so the client can show what it lost rather than overwrite silently. */
class Conflict extends Error {
  constructor(kind, id, current) {
    super('Conflict on ' + kind + ':' + id);
    this.name = 'Conflict';
    this.kind = kind;
    this.id = id;
    this.current = current;
  }
}

/* A duplicate of something the schema says must be unique - a Proposal No. or
   a Job No. already on another bid. Reported the same way a form would. */
class Duplicate extends Error {
  constructor(field, value) {
    super(field + ' "' + value + '" is already used by another bid.');
    this.name = 'Duplicate';
    this.field = field;
    this.value = value;
  }
}

function friendlyConstraint(e, rec) {
  const m = String(e && e.message || '');
  if (!/UNIQUE|constraint/i.test(m)) return e;
  if (/proposal_no/.test(m)) return new Duplicate('Proposal No.', rec.proposalNo);
  if (/award_no/.test(m)) return new Duplicate('Job No.', rec.awardNo);
  if (/engineers_initials/.test(m)) return new Duplicate('Initials', rec.initials);
  return e;
}

/* Writes one record and logs the change. `expectedRev` is the rev the client
   read; null means "create". Returns the new rev and the seq of the change.

   Must be called inside tx() - putMany does that once for the whole batch, so
   a batch either lands completely or not at all. */
function put(kind, id, rec, expectedRev, userId) {
  const def = schema.KINDS[kind];
  if (!def) throw new Error('Unknown kind: ' + kind);
  const key = def.idType === 'number' ? Number(id) : String(id);
  const now = new Date().toISOString();
  const json = JSON.stringify(rec);
  const existing = stmt(
    'SELECT rev, json FROM ' + def.table + ' WHERE id = ?').get(key);

  if (existing && expectedRev != null && Number(expectedRev) !== existing.rev) {
    throw new Conflict(kind, id, { json: JSON.parse(existing.json), rev: existing.rev });
  }

  const rev = existing ? existing.rev + 1 : 1;

  try {
    if (kind === 'bid') {
      const c = bidColumns(rec);
      stmt(
        'INSERT INTO bids (id, proposal_no, project, status, region, portal, active, ' +
        '  award_no, due_date, price, json, rev, updated_at, updated_by) ' +
        'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ' +
        'ON CONFLICT(id) DO UPDATE SET proposal_no=excluded.proposal_no, ' +
        '  project=excluded.project, status=excluded.status, region=excluded.region, ' +
        '  portal=excluded.portal, active=excluded.active, award_no=excluded.award_no, ' +
        '  due_date=excluded.due_date, price=excluded.price, json=excluded.json, ' +
        '  rev=excluded.rev, updated_at=excluded.updated_at, updated_by=excluded.updated_by'
      ).run(key, c.proposal_no, c.project, c.status, c.region, c.portal, c.active,
        c.award_no, c.due_date, c.price, json, rev, now, userId == null ? null : Number(userId));
    } else if (kind === 'engineer') {
      stmt(
        'INSERT INTO engineers (id, initials, name, json, rev, updated_at, updated_by) ' +
        'VALUES (?,?,?,?,?,?,?) ' +
        'ON CONFLICT(id) DO UPDATE SET initials=excluded.initials, name=excluded.name, ' +
        '  json=excluded.json, rev=excluded.rev, updated_at=excluded.updated_at, ' +
        '  updated_by=excluded.updated_by'
      ).run(key, (rec.initials || '').trim() || null, rec.name || '', json, rev, now,
        userId == null ? null : Number(userId));
    } else if (kind === 'takeoff' || kind === 'proposal') {
      stmt(
        'INSERT INTO ' + def.table + ' (id, bid_id, json, rev, updated_at, updated_by) ' +
        'VALUES (?,?,?,?,?,?) ' +
        'ON CONFLICT(id) DO UPDATE SET bid_id=excluded.bid_id, json=excluded.json, ' +
        '  rev=excluded.rev, updated_at=excluded.updated_at, updated_by=excluded.updated_by'
      ).run(key, rec.bidId == null ? null : Number(rec.bidId), json, rev, now,
        userId == null ? null : Number(userId));
    } else {
      stmt(
        'INSERT INTO ' + def.table + ' (id, json, rev, updated_at, updated_by) ' +
        'VALUES (?,?,?,?,?) ' +
        'ON CONFLICT(id) DO UPDATE SET json=excluded.json, rev=excluded.rev, ' +
        '  updated_at=excluded.updated_at, updated_by=excluded.updated_by'
      ).run(key, json, rev, now, userId == null ? null : Number(userId));
    }
  } catch (e) {
    throw friendlyConstraint(e, rec);
  }

  const seq = logChange(kind, key, 'put', json, now, userId);
  return { kind, id: key, rev, seq };
}

function remove(kind, id, userId) {
  const def = schema.KINDS[kind];
  if (!def) throw new Error('Unknown kind: ' + kind);
  const key = def.idType === 'number' ? Number(id) : String(id);
  const now = new Date().toISOString();
  stmt('DELETE FROM ' + def.table + ' WHERE id = ?').run(key);
  const seq = logChange(kind, key, 'delete', null, now, userId);
  return { kind, id: key, rev: 0, seq };
}

/* One row per accepted write, carrying the record's body only when the body is
   small enough to be worth carrying.
 *
 * The log is a sync transport, not the audit trail: what the office reads back
 * lives in bid.history, inside the bid record itself. So a change to something
 * large is logged as "this record moved, at this seq" and the client fetches
 * the record from /api/records when it sees one. That is also the more correct
 * thing to hand a reconnecting client - the record as it stands now, rather
 * than as it stood at a seq it is about to step past anyway.
 *
 * Without this the log grew by the size of the whole document on every
 * autosave: 1,969 changes had become 98MB of a 107MB database, against under
 * 3MB of live records. */
function logChange(kind, id, op, json, at, userId) {
  const body = json && Buffer.byteLength(json) > LOG_BODY_MAX ? null : json;
  const info = stmt(
    'INSERT INTO changes (kind, entity_id, op, json, at, by) VALUES (?,?,?,?,?,?)')
    .run(kind, String(id), op, body, at, userId == null ? null : Number(userId));
  return Number(info.lastInsertRowid);
}

/* Whether a record's body is small enough to travel with the change that
   announces it - in the log above, and on the SSE stream in server/api.js.
   One rule in one place, so a client cannot be handed a body over the stream
   that the log would have withheld. */
function bodyTravels(rec) {
  if (rec == null) return false;
  return Buffer.byteLength(JSON.stringify(rec)) <= LOG_BODY_MAX;
}

/* Applies a batch as one transaction. Every write lands or none does, so a
   conflict on the third of five edits cannot leave the first two applied and
   the client believing otherwise. */
function putMany(batch, userId) {
  return tx(() => batch.map(item => (
    item.op === 'delete'
      ? remove(item.kind, item.id, userId)
      : put(item.kind, item.id, item.json, item.rev, userId)
  )));
}

/* ---- per-person preferences -------------------------------------------- */

/* db.ui - column layouts, the tab you were last on, which cards you had
   collapsed. Stored against the account rather than in the browser, so somebody
   who sits at a different machine finds their own table waiting for them.

   Deliberately not part of the sync protocol: it is a preference, not a record,
   and broadcasting it would repaint everyone else's screen when you hid a
   column. */
function getPrefs(userId) {
  const row = stmt('SELECT json FROM user_prefs WHERE user_id = ?').get(Number(userId));
  if (!row) return null;
  try { return JSON.parse(row.json); } catch (e) { return null; }
}

function setPrefs(userId, value) {
  stmt(
    'INSERT INTO user_prefs (user_id, json, updated_at) VALUES (?,?,?) ' +
    'ON CONFLICT(user_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at')
    .run(Number(userId), JSON.stringify(value == null ? {} : value), new Date().toISOString());
  return true;
}

/* Has this database ever held any of the app's records? Deliberately not "is
   the change log empty": creating the first administrator writes their engineer
   row, and a team that has emptied the bid register on purpose has a change log
   full of history. Bids and settings together are the test - an office that has
   used this at all has both, and neither is written by setting up an account. */
function isEmpty() {
  const row = stmt('SELECT COUNT(*) AS n FROM bids').get();
  const s = stmt('SELECT COUNT(*) AS n FROM settings').get();
  return row.n === 0 && s.n === 0;
}

module.exports = {
  open, close, handle, tx,
  snapshot, allOf, getOne, latestSeq, changesSince,
  put, putMany, remove, isEmpty,
  getPrefs, setPrefs,
  bodyTravels, LOG_BODY_MAX,
  Conflict, Duplicate,
  get path() { return dbPath; }
};
