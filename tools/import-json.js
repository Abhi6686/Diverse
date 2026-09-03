/* import-json.js - move an existing browser database onto the server.
 *
 *   node tools/import-json.js DiVerse-Bids-2026-09-02.json
 *   node tools/import-json.js dump.json --db /srv/diverse.db --replace
 *
 * The file is whatever `Save` in the running app downloads. Nobody retypes
 * anything: open the app on the machine that has the real data, press Save,
 * and feed the result to this.
 *
 * The file is run through the client's own migration chain first, so a dump
 * taken from any older build is accepted and arrives at the current shape -
 * the same code path a restored backup has always taken.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const db = require('../server/db');

const argv = process.argv.slice(2);
function flag(name, fallback) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const has = name => argv.indexOf('--' + name) >= 0;

const file = argv.find(a => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--db');
const DB_FILE = flag('db', path.join(__dirname, '..', 'diverse.db'));
const REPLACE = has('replace');

if (!file) {
  console.error('\n  Usage: node tools/import-json.js <export.json> [--db path] [--replace]\n');
  process.exit(1);
}

/* The migration chain lives in the browser module. Rather than keep a second
   copy here - which would drift the first time a schema step is added - the
   module is evaluated in a sandbox with just enough of a window for it to load,
   and Store.migrate is borrowed from it. */
function clientMigrate(parsed) {
  const root = path.join(__dirname, '..');
  const sandbox = {
    window: null, console,
    setTimeout, clearTimeout, Promise, Date, JSON, Math, URL,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    indexedDB: undefined, navigator: undefined, document: undefined
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);

  // The seeds first: Store.freshDB and the migrations read them off window.
  for (const f of ['js/seed.js', 'js/references.seed.js', 'js/catalog.seed.js',
    'js/proposal.defaults.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
  }
  vm.runInContext(fs.readFileSync(path.join(root, 'js/store.js'), 'utf8'), sandbox,
    { filename: 'js/store.js' });

  if (!sandbox.Store || typeof sandbox.Store.migrate !== 'function') {
    throw new Error('Could not load Store.migrate from js/store.js');
  }
  return { migrated: sandbox.Store.migrate(parsed), version: sandbox.Store.SCHEMA_VERSION };
}

function main() {
  const raw = fs.readFileSync(file, 'utf8');
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { throw new Error(file + ' is not valid JSON: ' + e.message); }

  if (!parsed || !Array.isArray(parsed.bids)) {
    throw new Error(file + ' does not look like a project export (no "bids" array). ' +
      'Use the Save button in the app, not Save .json on the Proposal tab.');
  }

  console.log('\n  Reading  ' + file);
  console.log('  Schema   v' + (parsed.schemaVersion || 0) + ' in the file');

  const { migrated, version } = clientMigrate(parsed);
  console.log('  Migrated to v' + version);

  db.open(DB_FILE, m => console.log(m));

  if (!db.isEmpty() && !REPLACE) {
    throw new Error('\n  ' + db.path + ' already has data in it.\n' +
      '  Re-run with --replace to overwrite it, or point --db somewhere new.\n' +
      '  Importing on top of live data would merge two histories and is never what you want.');
  }

  const batch = [];
  (migrated.bids || []).forEach(b => batch.push({ kind: 'bid', id: b.id, op: 'put', json: b }));
  Object.keys(migrated.takeoffs || {}).forEach(id =>
    batch.push({ kind: 'takeoff', id, op: 'put', json: migrated.takeoffs[id] }));
  Object.keys(migrated.proposals || {}).forEach(id =>
    batch.push({ kind: 'proposal', id, op: 'put', json: migrated.proposals[id] }));
  (migrated.catalog || []).forEach(c => batch.push({ kind: 'catalog', id: c.id, op: 'put', json: c }));
  /* Engineers are the one collection that can already have rows in a database
     the caller thinks is empty: creating the first administrator writes theirs.
     Initials are unique, so importing a backup that names the same person under
     a different id would fail the whole batch. The row that is already here
     wins, because it is the one an account is attached to. */
  const heldInitials = new Set(REPLACE ? [] : db.allOf('engineer').map(r => {
    try { return String(JSON.parse(r.json).initials || '').toLowerCase(); }
    catch (e) { return ''; }
  }).filter(Boolean));

  let skippedEngineers = 0;
  (migrated.engineers || []).forEach(e => {
    if (heldInitials.has(String(e.initials || '').toLowerCase())) { skippedEngineers++; return; }
    batch.push({ kind: 'engineer', id: e.id, op: 'put', json: e });
  });
  for (const key of require('../server/schema').SETTING_KEYS) {
    if (migrated[key] !== undefined) {
      batch.push({ kind: 'setting', id: key, op: 'put', json: migrated[key] });
    }
  }

  db.tx(() => {
    if (REPLACE) {
      for (const kind of Object.keys(require('../server/schema').KINDS)) {
        const table = require('../server/schema').KINDS[kind].table;
        db.handle().exec('DELETE FROM ' + table);
      }
      db.handle().exec('DELETE FROM changes');
    }
    db.putMany(batch, null);
  });

  /* Accounts live outside the change log and survive an import untouched, but
     the engineer rows they point at have just been replaced. Re-attach each
     account to the entry with its initials - or make one - so nobody comes back
     from a restore to find their name unlinked. */
  const auth = require('../server/auth');
  const api = require('../server/api');
  let relinked = 0;
  for (const u of auth.listUsers()) {
    if (!u.initials) continue;
    api.linkEngineer(u, null);
    relinked++;
  }

  const snap = db.snapshot();
  console.log('\n  Imported');
  console.log('    ' + snap.bids.length + ' bids');
  console.log('    ' + Object.keys(snap.takeoffs).length + ' takeoffs');
  console.log('    ' + Object.keys(snap.proposals).length + ' proposals');
  console.log('    ' + snap.catalog.length + ' catalog parts');
  console.log('    ' + snap.engineers.length + ' engineers' +
    (skippedEngineers ? '   (' + skippedEngineers + ' already here, kept as they were)' : ''));
  console.log('    ' + (snap.regions || []).length + ' regions');
  if (relinked) console.log('    ' + relinked + ' account(s) re-attached to their engineer entry');
  console.log('\n  Into ' + db.path + '   (seq ' + snap.seq + ')');
  console.log('\n  Start the server:  node serve.js\n');
  db.close();
}

try { main(); }
catch (e) { console.error('\n  ' + (e.message || e) + '\n'); process.exit(1); }
