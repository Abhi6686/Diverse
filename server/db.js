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

function open(file, log) {
  dbPath = file || path.join(__dirname, '..', 'diverse.db');

  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  db = new DatabaseSync(dbPath);

  // WAL lets readers carry on while a write is in flight, which is what keeps
  // the table responsive once several people are on it. NORMAL sync is the
  // right trade with WAL: a power cut can lose the last transaction, not the
  // database. foreign_keys is off by default in SQLite and has to be asked for.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  // Wait rather than throw if another process holds the write lock.
  db.exec('PRAGMA busy_timeout = 5000');

  schema.migrate(db, log);
  return db;
}

function close() {
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
  return handle().prepare('SELECT id, json, rev FROM ' + def.table).all();
}

function getOne(kind, id) {
  const def = schema.KINDS[kind];
  if (!def) throw new Error('Unknown kind: ' + kind);
  return handle().prepare('SELECT id, json, rev FROM ' + def.table + ' WHERE id = ?')
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
  const row = handle().prepare('SELECT MAX(seq) AS seq FROM changes').get();
  return row && row.seq ? row.seq : 0;
}

function changesSince(seq, limit) {
  return handle().prepare(
    'SELECT seq, kind, entity_id, op, json, at, by FROM changes ' +
    'WHERE seq > ? ORDER BY seq LIMIT ?').all(Number(seq) || 0, limit || 5000);
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
  const existing = handle().prepare(
    'SELECT rev, json FROM ' + def.table + ' WHERE id = ?').get(key);

  if (existing && expectedRev != null && Number(expectedRev) !== existing.rev) {
    throw new Conflict(kind, id, { json: JSON.parse(existing.json), rev: existing.rev });
  }

  const rev = existing ? existing.rev + 1 : 1;

  try {
    if (kind === 'bid') {
      const c = bidColumns(rec);
      handle().prepare(
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
      handle().prepare(
        'INSERT INTO engineers (id, initials, name, json, rev, updated_at, updated_by) ' +
        'VALUES (?,?,?,?,?,?,?) ' +
        'ON CONFLICT(id) DO UPDATE SET initials=excluded.initials, name=excluded.name, ' +
        '  json=excluded.json, rev=excluded.rev, updated_at=excluded.updated_at, ' +
        '  updated_by=excluded.updated_by'
      ).run(key, (rec.initials || '').trim() || null, rec.name || '', json, rev, now,
        userId == null ? null : Number(userId));
    } else if (kind === 'takeoff' || kind === 'proposal') {
      handle().prepare(
        'INSERT INTO ' + def.table + ' (id, bid_id, json, rev, updated_at, updated_by) ' +
        'VALUES (?,?,?,?,?,?) ' +
        'ON CONFLICT(id) DO UPDATE SET bid_id=excluded.bid_id, json=excluded.json, ' +
        '  rev=excluded.rev, updated_at=excluded.updated_at, updated_by=excluded.updated_by'
      ).run(key, rec.bidId == null ? null : Number(rec.bidId), json, rev, now,
        userId == null ? null : Number(userId));
    } else {
      handle().prepare(
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
  handle().prepare('DELETE FROM ' + def.table + ' WHERE id = ?').run(key);
  const seq = logChange(kind, key, 'delete', null, now, userId);
  return { kind, id: key, rev: 0, seq };
}

function logChange(kind, id, op, json, at, userId) {
  const info = handle().prepare(
    'INSERT INTO changes (kind, entity_id, op, json, at, by) VALUES (?,?,?,?,?,?)')
    .run(kind, String(id), op, json, at, userId == null ? null : Number(userId));
  return Number(info.lastInsertRowid);
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
  const row = handle().prepare('SELECT json FROM user_prefs WHERE user_id = ?').get(Number(userId));
  if (!row) return null;
  try { return JSON.parse(row.json); } catch (e) { return null; }
}

function setPrefs(userId, value) {
  handle().prepare(
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
  const row = handle().prepare('SELECT COUNT(*) AS n FROM bids').get();
  const s = handle().prepare('SELECT COUNT(*) AS n FROM settings').get();
  return row.n === 0 && s.n === 0;
}

module.exports = {
  open, close, handle, tx,
  snapshot, allOf, getOne, latestSeq, changesSince,
  put, putMany, remove, isEmpty,
  getPrefs, setPrefs,
  Conflict, Duplicate,
  get path() { return dbPath; }
};
