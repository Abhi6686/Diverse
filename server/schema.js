/* schema.js - the database's shape, as a list of numbered steps.
 *
 * Same idea as Store.migrate on the client: every step is applied once, in
 * order, and the version reached is recorded. A database from any earlier build
 * is brought forward by running the steps it has not seen yet, so upgrading is
 * never "export, wipe, re-import".
 *
 * Steps are append-only. Editing one that has already shipped means the two
 * halves of the estate disagree about what the schema is; add another instead.
 */
'use strict';

/* Entity tables all share the same five columns:
 *
 *   json        the record, exactly as the client holds it
 *   rev         bumped on every write; the client sends the rev it read, and a
 *               mismatch means somebody else got there first
 *   updated_at  ISO timestamp
 *   updated_by  which user, once there are users
 *
 * The nested documents - takeoffs and proposals - are only ever read and
 * written whole, so shredding them into tables would buy nothing. A bid is the
 * contended record, so the fields that are searched, sorted and constrained get
 * real columns beside the json.
 */
const STEPS = [
  {
    version: 1,
    name: 'entities, settings and the change log',
    up: function (db) {
      db.exec(`
        CREATE TABLE bids (
          id           INTEGER PRIMARY KEY,
          proposal_no  TEXT COLLATE NOCASE,
          project      TEXT NOT NULL DEFAULT '',
          status       TEXT,
          region       TEXT,
          portal       TEXT,
          active       INTEGER NOT NULL DEFAULT 0,
          award_no     TEXT,
          due_date     TEXT,
          price        REAL,
          json         TEXT NOT NULL,
          rev          INTEGER NOT NULL DEFAULT 1,
          updated_at   TEXT NOT NULL,
          updated_by   INTEGER
        );

        /* Uniqueness lives in the database, not only in the form that types it.
           A check in saveBid can be raced by two browsers a millisecond apart;
           a constraint cannot. Partial, so the many bids with no number yet do
           not all collide with each other on ''. */
        CREATE UNIQUE INDEX bids_proposal_no ON bids(proposal_no)
          WHERE proposal_no IS NOT NULL AND proposal_no <> '';
        CREATE UNIQUE INDEX bids_award_no ON bids(award_no)
          WHERE award_no IS NOT NULL AND award_no <> '';
        CREATE INDEX bids_active ON bids(active, status);
        CREATE INDEX bids_project ON bids(project);

        CREATE TABLE takeoffs (
          id TEXT PRIMARY KEY, bid_id INTEGER, json TEXT NOT NULL,
          rev INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, updated_by INTEGER
        );
        CREATE INDEX takeoffs_bid ON takeoffs(bid_id);

        CREATE TABLE proposals (
          id TEXT PRIMARY KEY, bid_id INTEGER, json TEXT NOT NULL,
          rev INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, updated_by INTEGER
        );
        CREATE INDEX proposals_bid ON proposals(bid_id);

        CREATE TABLE catalog (
          id TEXT PRIMARY KEY, json TEXT NOT NULL,
          rev INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, updated_by INTEGER
        );

        CREATE TABLE engineers (
          id TEXT PRIMARY KEY, initials TEXT COLLATE NOCASE, name TEXT,
          json TEXT NOT NULL,
          rev INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, updated_by INTEGER
        );
        CREATE UNIQUE INDEX engineers_initials ON engineers(initials);

        /* The singletons: regions, productTypes, taskTypes, references, rates,
           company. One row each, whole-value writes - there is no useful
           sub-record to address in a list of county names.

           The key column is named id like every other entity table, so one set
           of statements serves all of them rather than settings needing its own
           spelling of the same query. */
        CREATE TABLE settings (
          id TEXT PRIMARY KEY, json TEXT NOT NULL,
          rev INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, updated_by INTEGER
        );

        /* The spine of live sync. Append-only: one row per accepted write, in
           the order they were accepted. A client that drops its connection asks
           for everything after the last seq it saw, rather than reloading the
           world and hoping. */
        CREATE TABLE changes (
          seq       INTEGER PRIMARY KEY AUTOINCREMENT,
          kind      TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          op        TEXT NOT NULL,
          json      TEXT,
          at        TEXT NOT NULL,
          by        INTEGER
        );
        CREATE INDEX changes_seq ON changes(seq);

        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      `);
    }
  },

  {
    version: 2,
    name: 'accounts, roles and per-person layouts',
    up: function (db) {
      db.exec(`
        CREATE TABLE roles (
          id         INTEGER PRIMARY KEY,
          name       TEXT COLLATE NOCASE UNIQUE NOT NULL,
          /* A builtin role cannot be deleted or renamed. Admin has to keep
             existing or nobody can administer anything; Employee is what a new
             person is created as. Their permissions are still editable. */
          builtin    INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );

        /* A row per granted permission rather than a JSON blob, so "which roles
           can delete a bid" is a query and not a scan-and-parse. */
        CREATE TABLE role_permissions (
          role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
          perm    TEXT NOT NULL,
          PRIMARY KEY (role_id, perm)
        );

        CREATE TABLE users (
          id         INTEGER PRIMARY KEY,
          email      TEXT COLLATE NOCASE UNIQUE NOT NULL,
          name       TEXT NOT NULL,
          /* The initials this person appears under on the bids table. One
             person is one account is one engineer, so this is the link to the
             engineers register rather than a second identity. */
          initials   TEXT COLLATE NOCASE,
          role_id    INTEGER NOT NULL REFERENCES roles(id),
          /* scrypt, with a per-user salt. Node's own crypto, no dependency. */
          pw_hash    TEXT NOT NULL,
          pw_salt    TEXT NOT NULL,
          active     INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          last_seen_at TEXT
        );

        /* A random token in a row, not a signed JWT: logging out has to
           actually revoke, and an admin deactivating somebody has to take
           effect now rather than whenever their token happens to expire. */
        CREATE TABLE sessions (
          token      TEXT PRIMARY KEY,
          user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          seen_at    TEXT
        );
        CREATE INDEX sessions_user ON sessions(user_id);

        /* Column layouts, the tab you were last on, which panels you had
           collapsed. Everything in db.ui - one person's preferences, which is
           why it is here and not in the shared tables. It follows the login, so
           it is the same on any machine they sit at. */
        CREATE TABLE user_prefs (
          user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          json       TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);

      // The two roles from the screenshots, with the access levels marked on
      // them. Created here rather than on first login so the setup screen has
      // something to put the first Admin into.
      const perms = require('./permissions');
      const now = new Date().toISOString();
      const insertRole = db.prepare(
        'INSERT INTO roles (name, builtin, created_at) VALUES (?, 1, ?)');
      const insertPerm = db.prepare(
        'INSERT INTO role_permissions (role_id, perm) VALUES (?, ?)');

      for (const name of ['Admin', 'Employee']) {
        const info = insertRole.run(name, now);
        const id = Number(info.lastInsertRowid);
        for (const p of perms.ROLE_DEFAULTS[name]) insertPerm.run(id, p);
      }
    }
  },

  {
    version: 3,
    name: 'sign in by username; email becomes optional',
    up: function (db) {
      /* SQLite cannot relax a NOT NULL/UNIQUE constraint or insert a new
         NOT NULL UNIQUE column in place, so the table is rebuilt - the
         standard SQLite recipe for this. The replacement is built under a
         throwaway name and swapped in by dropping the original and renaming
         the replacement over it, rather than renaming the original out of the
         way first: doing it that way round leaves sessions' REFERENCES
         clause silently rewritten to point at the now-dropped name, which
         breaks every session the moment this transaction commits. */
      db.exec(`
        CREATE TABLE users_new (
          id           INTEGER PRIMARY KEY,
          /* What is typed to sign in. Not email: the office does not hand an
             email address to everyone who needs to log a bid. */
          username     TEXT COLLATE NOCASE UNIQUE NOT NULL,
          email        TEXT COLLATE NOCASE UNIQUE,
          name         TEXT NOT NULL,
          initials     TEXT COLLATE NOCASE,
          role_id      INTEGER NOT NULL REFERENCES roles(id),
          pw_hash      TEXT NOT NULL,
          pw_salt      TEXT NOT NULL,
          active       INTEGER NOT NULL DEFAULT 1,
          created_at   TEXT NOT NULL,
          last_seen_at TEXT
        );
      `);

      // Every existing account gets a username derived from its email, so
      // nobody already on the system is locked out the day this ships. Two
      // emails sharing a local part are numbered apart.
      const old = db.prepare('SELECT * FROM users').all();
      const insert = db.prepare(
        'INSERT INTO users_new (id, username, email, name, initials, role_id, pw_hash, ' +
        'pw_salt, active, created_at, last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
      const taken = new Set();
      for (const u of old) {
        const base = String(u.email || u.name || 'user').split('@')[0]
          .toLowerCase().replace(/[^a-z0-9._-]/g, '') || 'user';
        let candidate = base, n = 1;
        while (taken.has(candidate)) candidate = base + (++n);
        taken.add(candidate);
        insert.run(u.id, candidate, u.email, u.name, u.initials, u.role_id,
          u.pw_hash, u.pw_salt, u.active, u.created_at, u.last_seen_at);
      }
      db.exec('DROP TABLE users');
      db.exec('ALTER TABLE users_new RENAME TO users');
    }
  }
];

/* The kinds of thing the sync protocol can carry, and where each one lives.
   `keyed` collections are objects/arrays of records addressed by id; `single`
   ones are one value under a name. The client and the server both read this,
   so a new collection is one entry rather than four edits that drift. */
const KINDS = {
  bid: { table: 'bids', keyed: true, idType: 'number' },
  takeoff: { table: 'takeoffs', keyed: true, idType: 'string' },
  proposal: { table: 'proposals', keyed: true, idType: 'string' },
  catalog: { table: 'catalog', keyed: true, idType: 'string' },
  engineer: { table: 'engineers', keyed: true, idType: 'string' },
  setting: { table: 'settings', keyed: true, idType: 'string' }
};

/* Which client-side collection each kind maps to, and how it is shaped there.
   `array` collections are arrays of records; `map` ones are objects by id. */
const COLLECTIONS = [
  { kind: 'bid', prop: 'bids', shape: 'array', idKey: 'id' },
  { kind: 'takeoff', prop: 'takeoffs', shape: 'map', idKey: 'id' },
  { kind: 'proposal', prop: 'proposals', shape: 'map', idKey: 'id' },
  { kind: 'catalog', prop: 'catalog', shape: 'array', idKey: 'id' },
  { kind: 'engineer', prop: 'engineers', shape: 'array', idKey: 'id' }
];

/* The singleton settings rows, by the property they hold on the client. */
const SETTING_KEYS = [
  'regions', 'productTypes', 'taskTypes', 'references', 'rates', 'company'
];

function currentVersion(db) {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get();
  return row ? Number(row.value) : 0;
}

/* Runs every step the database has not seen, each in its own transaction, so a
   step that throws leaves the database on the last version that worked rather
   than half-migrated. */
function migrate(db, log) {
  const hasMeta = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get();
  let from = hasMeta ? currentVersion(db) : 0;

  const pending = STEPS.filter(s => s.version > from);
  if (!pending.length) return from;

  /* Off for the whole migration, not just the steps that rebuild a table:
     PRAGMA foreign_keys is a no-op inside a transaction, so it has to be set
     before BEGIN, and a table rebuild (the only way SQLite can relax a
     column's constraints) needs it off or two things go wrong at once - a
     rename silently rewrites *other* tables' REFERENCES clauses to the old
     name, and dropping the referenced table cascade-deletes their rows. */
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    for (const step of pending) {
      db.exec('BEGIN');
      try {
        step.up(db);
        db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value')
          .run('schemaVersion', String(step.version));
        db.exec('COMMIT');
        if (log) log('  schema -> v' + step.version + '  ' + step.name);
        from = step.version;
      } catch (e) {
        db.exec('ROLLBACK');
        throw new Error('Schema step ' + step.version + ' (' + step.name + ') failed: ' + e.message);
      }
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  return from;
}

module.exports = {
  STEPS, KINDS, COLLECTIONS, SETTING_KEYS,
  LATEST: STEPS[STEPS.length - 1].version,
  migrate, currentVersion
};
