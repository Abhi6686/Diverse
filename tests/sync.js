/* Two browsers, one server.
 *
 * tests/api.js proves the server behaves. This proves the *client* does: that
 * js/store.js really talks to it, that an edit made in one browser turns up in
 * the other, and that a browser opened with no server still works on its own.
 *
 *   node --no-warnings tests/sync.js
 *   Needs: npm install jsdom --no-save
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
let failures = 0;
const errors = [];
function check(label, cond, detail) {
  if (!cond) { failures++; errors.push(label); }
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail && !cond ? '  -> ' + detail : ''}`);
}

const wait = ms => new Promise(r => setTimeout(r, ms));

const FILES = ['js/seed.js', 'js/references.seed.js', 'js/catalog.seed.js',
  'js/proposal.styles.js', 'js/proposal.defaults.js', 'js/util.js', 'js/ui.js', 'js/datepicker.js', 'js/sparks.js', 'js/intro.js', 'js/guide.js', 'js/auth.js', 'js/merge.js', 'js/remote.js',
  'js/store.js', 'js/nav.js', 'js/rates.js', 'js/catalog.js', 'js/bidgrid.js',
  'js/references.js', 'js/ratespanel.js', 'js/takeoff.model.js', 'js/takeoff.js',
  'js/proposal.paginate.js', 'js/proposal.js', 'js/ratelib.js', 'js/bids.js', 'js/assignments.js', 'js/products.js', 'js/history.js', 'js/schedule.js', 'js/presence.js', 'js/project.js',
  'js/settings.js', 'js/app.js'];

const HTML = fs.readFileSync(path.join(ROOT, 'Bid_Proposal_Manager_2026.html'), 'utf8')
  .replace(/<script src="https:[^"]*"><\/script>/g, '')
  .replace(/<link href="https:[^"]*"[^>]*>/g, '');

/* One browser. `origin` null means "opened off disk with no server", which is
   how the app still has to work for a single user on a laptop.

   Three shims stand in for things jsdom lacks and a browser has: fetch
   resolving a relative URL against the page, a cookie jar, and EventSource. All
   thin - the point is to exercise js/remote.js and js/auth.js as written, not
   to reimplement them.

   The jar is per browser, which is what makes two windows two different people
   rather than one session shared by both. */
function openBrowser(origin, label, jar, storage) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => {
    failures++; errors.push(label + ' page error');
    console.log('FAIL  ' + label + ' page error: ' + e.message);
  });

  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously',
    url: (origin || 'file://' + ROOT.replace(/\\/g, '/')) + '/',
    virtualConsole: vc,
    beforeParse(win) {
      const store = storage || {};   // shared between two pages = a reload
      Object.defineProperty(win, 'localStorage', {
        value: {
          getItem: k => (k in store ? store[k] : null),
          setItem: (k, v) => { store[k] = String(v); },
          removeItem: k => { delete store[k]; }
        }
      });
      if (origin) {
        win.fetch = (u, o) => jarFetch(jar, origin, u, o);
        win.EventSource = makeEventSource(origin, jar);
      }
      win.document.execCommand = () => true;
      win.print = () => {};
      win.alert = () => {};
      win.confirm = () => true;
      win.prompt = () => 'x';
      win.URL.createObjectURL = () => 'blob:test';
      win.URL.revokeObjectURL = () => {};
    }
  });

  const win = dom.window;
  return new Promise(r => (win.document.readyState === 'complete' ? r() : win.addEventListener('load', r)))
    .then(() => {
      FILES.forEach(f => {
        const el = win.document.createElement('script');
        el.textContent = fs.readFileSync(path.join(ROOT, f), 'utf8');
        win.document.body.appendChild(el);
      });
      return wait(1200);
    })
    .then(() => win);
}

/* A cookie jar per browser. Node's fetch does not keep cookies and the session
   is one, so without this both windows would be nobody. */
function newJar() { return { cookie: null }; }

function jarFetch(jar, origin, u, options) {
  const opts = Object.assign({}, options || {});
  opts.headers = Object.assign({}, opts.headers || {});
  if (jar && jar.cookie) opts.headers.Cookie = jar.cookie;
  return fetch(String(u).startsWith('http') ? u : origin + u, opts).then(res => {
    if (!jar) return res;
    const list = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie')].filter(Boolean);
    for (const line of list) {
      const pair = String(line).split(';')[0];
      if (pair.startsWith('dvsid=')) jar.cookie = pair;
    }
    return res;
  });
}

/* Enough of EventSource for js/remote.js: addEventListener, onerror, close. */
function makeEventSource(origin, jar) {
  return class EventSource {
    constructor(url) {
      this.listeners = {};
      this.onerror = null;
      this.controller = new AbortController();
      jarFetch(jar, origin, url, { signal: this.controller.signal }).then(async res => {
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i); buf = buf.slice(i + 2);
            const ev = (frame.match(/^event: (.*)$/m) || [])[1];
            const data = (frame.match(/^data: (.*)$/m) || [])[1];
            if (!ev || !data) continue;
            (this.listeners[ev] || []).forEach(fn => fn({ data }));
          }
        }
      }).catch(() => { if (this.onerror) this.onerror(); });
    }
    addEventListener(name, fn) { (this.listeners[name] = this.listeners[name] || []).push(fn); }
    close() { try { this.controller.abort(); } catch (e) { /* already */ } }
  };
}

async function main() {
  const db = require(path.join(ROOT, 'server/db'));
  const api = require(path.join(ROOT, 'server/api'));
  const sync = require(path.join(ROOT, 'server/sync'));
  db.open(':memory:');

  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/')) {
      api.handle(req, res, { user: null }).catch(() => res.writeHead(500).end());
      return;
    }
    // The client only fetches /api here; anything else is a 404 it never asks for.
    res.writeHead(404).end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const ORIGIN = 'http://127.0.0.1:' + server.address().port;

  try {
    console.log('--- the first run asks to be set up ---');
    const jarA = newJar();
    const A = await openBrowser(ORIGIN, 'client A', jarA);
    check('an empty database shows the setup screen, not a login',
      A.Auth.mode === 'setup', A.Auth.mode);
    check('and the app has not opened the database behind it',
      A.Store.db === null || A.Store.backend !== 'server', String(A.Store.backend));

    // Driven through the real form rather than the API, so the screen people
    // actually see on day one is the thing under test.
    A.U.$('authName').value = 'Ada Lovelace';
    A.U.$('authUsername').value = 'ada';
    A.U.$('authEmail').value = 'ada@diverse.test';
    A.U.$('authInitials').value = 'AL';
    A.U.$('authPassword').value = 'letmein123';
    A.U.$('authPassword2').value = 'letmein123';
    A.Auth.submitSetup({ preventDefault() {} });
    await wait(1600);

    check('signing up admits them', A.Auth.mode === 'in', A.Auth.mode);
    check('as an administrator', A.Auth.user && A.Auth.user.role === 'Admin',
      A.Auth.user && A.Auth.user.role);
    check('who may delete a bid', A.Auth.can('bid.delete'));

    console.log('\n--- a browser finds the server ---');
    check('it uses the shared backend', A.Store.backend === 'server', A.Store.backend);
    check('and reports itself shared', A.Store.shared === true);
    check('an empty server is seeded from the app\'s own seed data',
      A.Store.db.bids.length > 50, String(A.Store.db.bids.length));

    await wait(1200);
    const seeded = db.snapshot();
    check('and that seed reached the database',
      seeded.bids.length === A.Store.db.bids.length,
      seeded.bids.length + ' vs ' + A.Store.db.bids.length);
    check('settings went up too', (seeded.regions || []).length > 10,
      String((seeded.regions || []).length));

    console.log('\n--- a second person joins ---');
    // Created the way an admin actually creates somebody: through the API the
    // People panel calls.
    const made = await jarFetch(jarA, ORIGIN, '/api/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Grace H', username: 'grace',
        initials: 'GH', password: 'passw0rd1' })
    }).then(r => r.json());
    check('the admin can create an employee', !!made.user, JSON.stringify(made));

    const jarB = newJar();
    const B = await openBrowser(ORIGIN, 'client B', jarB);
    check('a second browser is asked to sign in, not to set up',
      B.Auth.mode === 'login', B.Auth.mode);
    B.U.$('authUsername').value = 'grace';
    B.U.$('authPassword').value = 'passw0rd1';
    B.Auth.submitLogin({ preventDefault() {} });
    await wait(1600);
    check('they are admitted', B.Auth.mode === 'in', B.Auth.mode);
    check('as an Employee', B.Auth.user && B.Auth.user.role === 'Employee',
      B.Auth.user && B.Auth.user.role);

    console.log('\n--- and the two see the same records ---');
    check('it sees the same bids', B.Store.db.bids.length === A.Store.db.bids.length,
      B.Store.db.bids.length + ' vs ' + A.Store.db.bids.length);
    await wait(600);
    check('and does not re-seed on top of them',
      db.snapshot().bids.length === A.Store.db.bids.length,
      String(db.snapshot().bids.length));

    console.log('\n--- an edit travels ---');
    const target = A.Store.db.bids[0];
    const before = B.Store.db.bids.find(b => b.id === target.id).project;
    target.project = 'Renamed on machine A';
    A.Store.save();
    await wait(1400);

    check('the server took the edit',
      db.snapshot().bids.find(b => b.id === target.id).project === 'Renamed on machine A');
    const onB = B.Store.db.bids.find(b => b.id === target.id);
    check('and it arrived in the other browser without a refresh',
      onB.project === 'Renamed on machine A',
      'B still has "' + onB.project + '" (was "' + before + '")');

    console.log('\n--- a new bid travels ---');
    const countBefore = B.Store.db.bids.length;
    A.Bids.openAdd();
    A.U.$('mProject').value = 'Created on machine A';
    A.U.$('mRegion').value = A.Store.db.regions[0];
    A.Bids.save({ preventDefault() {} });
    await wait(1400);
    check('B gains the new bid', B.Store.db.bids.length === countBefore + 1,
      B.Store.db.bids.length + ' vs ' + (countBefore + 1));
    check('with the right name',
      B.Store.db.bids.some(b => b.project === 'Created on machine A'));

    console.log('\n--- settings travel too ---');
    A.Store.db.taskTypes.push('Weld inspection');
    A.Store.save();
    await wait(1400);
    check('a new task type reaches the other browser',
      B.Store.db.taskTypes.includes('Weld inspection'),
      JSON.stringify(B.Store.db.taskTypes));

    /* EVERY SHOP LIST, NOT JUST THE ONES SOMEBODY REMEMBERED.
     *
     * SETTING_KEYS is written out twice - js/remote.js decides what a browser
     * sends, server/schema.js what the server will store - and a key on one
     * side only is a list that quietly stops syncing. `materials` was exactly
     * that: managed from Settings like regions and task types, edited by one
     * person, and never once sent to anybody else. */
    const serverKeys = require(path.join(ROOT, 'server/schema.js')).SETTING_KEYS;
    check('the client and the server agree on which lists sync',
      JSON.stringify(A.Remote.SETTING_KEYS.slice().sort()) ===
      JSON.stringify(serverKeys.slice().sort()),
      A.Remote.SETTING_KEYS.join(',') + '  vs  ' + serverKeys.join(','));
    check('and every list Settings can edit is among them',
      ['regions', 'productTypes', 'taskTypes', 'materials', 'portals', 'statuses',
       'references', 'rates', 'company']
        .every(k => serverKeys.indexOf(k) >= 0), serverKeys.join(','));

    A.Store.db.portals.push('Dodge');
    A.Store.db.materials.push('Bronze');
    A.Store.db.statuses.push({ name: 'On Hold', tone: 'warn' });
    A.Store.save();
    await wait(1400);
    check('a new portal reaches the other browser',
      B.Store.db.portals.includes('Dodge'), JSON.stringify(B.Store.db.portals));
    check('so does a material, which used to go nowhere at all',
      B.Store.db.materials.includes('Bronze'), JSON.stringify(B.Store.db.materials));
    check('and a status the shop added',
      (B.Store.db.statuses || []).some(s => s.name === 'On Hold'),
      JSON.stringify(B.Store.db.statuses));
    check('which the other browser then offers on its own bid form',
      B.Bids.settableStatuses().some(s => s.key === 'On Hold'),
      B.Bids.settableStatuses().map(s => s.key).join(','));

    /* A record too big to travel with its own change. The server withholds the
       body from both the log and the stream, and js/remote.js fetches it from
       /api/records before anything downstream sees the change - so from here
       this must look exactly like any other edit arriving. */
    console.log('\n--- a large record still travels, the long way round ---');
    const heavy = A.Store.db.bids[2];
    const heavyId = heavy.id;
    heavy.project = 'Heavy on machine A';
    heavy.notes = 'n'.repeat(64 * 1024);
    A.Store.save();
    await wait(1800);

    const logged = db.changesSince(0).rows.filter(r => String(r.entity_id) === String(heavyId));
    check('the server logged the change without its body',
      logged.length > 0 && logged[logged.length - 1].json === null,
      JSON.stringify(logged.length && (logged[logged.length - 1].json || '').slice(0, 40)));

    const heavyOnB = B.Store.db.bids.find(b => b.id === heavyId);
    check('but B still received the edit',
      heavyOnB && heavyOnB.project === 'Heavy on machine A',
      heavyOnB && heavyOnB.project);
    check('with the large field intact, fetched from /api/records',
      heavyOnB && heavyOnB.notes && heavyOnB.notes.length === 64 * 1024,
      String(heavyOnB && heavyOnB.notes && heavyOnB.notes.length));

    console.log('\n--- one person\'s column layout is their own ---');
    // db.ui is deliberately not shared: it is a preference, not a record.
    A.Bids.setView('active');
    A.BidGrid.toggleColumn('portal');
    A.Store.save();
    await wait(1200);
    const hiddenOnA = !A.BidGrid.activeColumns().some(c => c.key === 'portal');
    B.Bids.setView('active');
    const stillOnB = B.BidGrid.activeColumns().some(c => c.key === 'portal');
    check('hiding a column on A hides it on A', hiddenOnA);
    check('and does not touch B', stillOnB);

    // It is saved against the account, not the browser, so it is there on
    // whatever machine they sit at next.
    const prefsA = await jarFetch(jarA, ORIGIN, '/api/prefs').then(r => r.json());
    const prefsB = await jarFetch(jarB, ORIGIN, '/api/prefs').then(r => r.json());
    check('A\'s layout is stored against A\'s account',
      prefsA.prefs && prefsA.prefs.grids && prefsA.prefs.grids.active,
      JSON.stringify(prefsA.prefs && prefsA.prefs.grids));
    check('and B\'s account has its own, unaffected',
      !prefsB.prefs || !(prefsB.prefs.grids && prefsB.prefs.grids.active &&
        (prefsB.prefs.grids.active.visible || []).indexOf('portal') < 0),
      JSON.stringify(prefsB.prefs && prefsB.prefs.grids));

    console.log('\n--- what the employee\'s screen offers ---');
    check('an Employee may not delete a bid', B.Auth.can('bid.delete') === false);
    // Delete lives in the row's overflow menu now rather than as a bare icon on
    // the row, so the menu is where the permission has to be checked.
    check('so the row menu has no delete button',
      B.Bids.rowMenu(B.Store.db.bids[0]).indexOf('promptDelete') < 0);
    check('the Admin\'s row menu does have one',
      A.Bids.rowMenu(A.Store.db.bids[0]).indexOf('promptDelete') >= 0);
    check('and no row shows delete on the row itself',
      A.Bids.actionCell(A.Store.db.bids[0]).indexOf('promptDelete') < 0);
    check('Settings is not offered to them', B.Nav.firstSectionOf('settings') === null,
      String(B.Nav.firstSectionOf('settings')));
    check('but it is to the Admin', A.Nav.firstSectionOf('settings') === 'ratelib',
      String(A.Nav.firstSectionOf('settings')));
    B.Nav.render();
    var barB = B.document.getElementById('moduleBar').innerHTML;
    check('and the module bar leaves out the four Admin-only modules',
      barB.indexOf('Production Manager') < 0 && barB.indexOf('Scheduler') < 0, barB.slice(0, 200));
    check('while still offering Bid Management', barB.indexOf('Bid Management') >= 0);

    // The one that matters: the screen hides it, and the server refuses it.
    const forged = await jarFetch(jarB, ORIGIN, '/api/changes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ changes: [{ kind: 'bid', id: B.Store.db.bids[0].id, op: 'delete' }] })
    });
    check('and a delete forged past the screen is refused anyway', forged.status === 403,
      String(forged.status));

    const onServer = id => db.snapshot().bids.find(b => b.id === id);
    const bidOn = (W, id) => W.Store.db.bids.find(b => b.id === id);
    console.log('\n--- a reload keeps the shop\'s own lists ---');
    // 'On Hold', 'Bronze' and 'Dodge' went up in "settings travel too". A page
    // loaded fresh used to drop all three and show the defaults instead.
    {
      const R = await openBrowser(ORIGIN, 'client A reloaded', jarA);
      check('a custom status survives a reload',
        (R.Store.db.statuses || []).some(s => s.name === 'On Hold'), JSON.stringify(R.Store.db.statuses));
      check('so does a material', R.Store.db.materials.includes('Bronze'), JSON.stringify(R.Store.db.materials));
      check('and a portal', R.Store.db.portals.includes('Dodge'), JSON.stringify(R.Store.db.portals));
      check('the status is offered wherever statuses are listed',
        R.Bids.allStatuses().some(s => s.key === 'On Hold'));
      R.Bids.openAdd();
      check('including the Add Bid form',
        [...R.U.$('mStatus').options].some(o => o.value === 'On Hold'));
      R.Bids.closeModal && R.Bids.closeModal();
      check('every shared list in the snapshot is loaded',
        R.Remote.SETTING_KEYS.every(k => {
          const s = db.snapshot()[k];
          return s === undefined || JSON.stringify(R.Store.db[k]) === JSON.stringify(s);
        }));

      // Adding another after a reload used to send "defaults + new one" and
      // overwrite the list on the server.
      R.Store.db.statuses.push({ name: 'Waiting on GC', tone: 'info' });
      R.Store.save();
      await wait(1400);
      const names = (db.snapshot().statuses || []).map(s => s.name);
      check('a status added after a reload joins the others on the server',
        names.includes('On Hold') && names.includes('Waiting on GC'), JSON.stringify(names));
      R.Remote.disconnect();
      R.close();
    }

    const notices = [];
    A.Store.onConflict(body => notices.push(body));

    console.log('\n--- one after the other, on the same record ---');
    // A edits, B receives it, then B edits the same bid. B used to still hold
    // the rev from before A's edit, so its save was refused as stale and A's
    // copy replaced what B typed.
    const seqBid = A.Store.db.bids[5];
    seqBid.project = 'Named by A';
    A.Store.save();
    await wait(1400);
    bidOn(B, seqBid.id).location = 'Placed by B';
    B.Store.save();
    await wait(1400);
    check('B\'s edit after A\'s lands on the server',
      onServer(seqBid.id).location === 'Placed by B', onServer(seqBid.id).location);
    check('without undoing A\'s', onServer(seqBid.id).project === 'Named by A',
      onServer(seqBid.id).project);
    check('and B is not told it lost anything', B.Store.status.state === 'saved', B.Store.status.state);

    console.log('\n--- at the same moment, on the same record ---');
    const both = A.Store.db.bids[6];
    both.project = 'Project typed on A';
    bidOn(B, both.id).location = 'Location typed on B';
    A.Store.save();
    B.Store.save();
    await wait(2000);
    check('both edits are on the server',
      onServer(both.id).project === 'Project typed on A' &&
      onServer(both.id).location === 'Location typed on B',
      JSON.stringify({ p: onServer(both.id).project, l: onServer(both.id).location }));
    check('and on both screens',
      bidOn(A, both.id).location === 'Location typed on B' &&
      bidOn(B, both.id).project === 'Project typed on A');

    console.log('\n--- the same field, changed twice ---');
    // Somebody edits the record straight on the server while A holds an older
    // copy. Only one value can stand: the one typed here, and A is told which.
    const contested = A.Store.db.bids[1];
    const serverCopy = onServer(contested.id);
    db.putMany([{ kind: 'bid', id: contested.id, op: 'put',
      json: Object.assign({}, serverCopy, { project: 'Typed elsewhere', notes: 'Theirs' }) }], null);

    contested.project = 'Typed on A';
    A.Store.save();
    await wait(1400);
    check('the value typed on this screen stands',
      onServer(contested.id).project === 'Typed on A', onServer(contested.id).project);
    check('their other change is kept, not reverted', onServer(contested.id).notes === 'Theirs',
      onServer(contested.id).notes);
    check('and A is told which field clashed',
      notices.some(n => n.error === 'merged' && n.conflicts.some(c => /project$/.test(c.path))),
      JSON.stringify(notices));

    console.log('\n--- offline, while somebody else carries on ---');
    const realFetch = A.fetch;
    const cut = (u, o) => (o && o.method === 'POST' && String(u).indexOf('/api/changes') >= 0
      ? Promise.reject(new TypeError('Failed to fetch')) : realFetch(u, o));
    A.fetch = cut;
    const away = A.Store.db.bids[7];
    away.project = 'Typed on A while offline';
    A.Store.save();
    await wait(800);
    check('A says it is offline, not saved', A.Store.status.state === 'offline', A.Store.status.state);
    check('and counts what is waiting', A.Store.status.pending >= 1, String(A.Store.status.pending));
    check('the unsent edit is kept on disk',
      /Typed on A while offline/.test(A.localStorage.getItem('dvbid.outbox.' + A.Store.user.id) || ''));

    bidOn(B, away.id).location = 'B carried on';
    B.Store.save();
    await wait(1200);
    check('B\'s change reaches A while it cannot save',
      bidOn(A, away.id).location === 'B carried on', bidOn(A, away.id).location);
    check('without wiping what A typed',
      bidOn(A, away.id).project === 'Typed on A while offline', bidOn(A, away.id).project);

    A.fetch = realFetch;
    await A.Store.retryNow();
    await wait(600);
    check('back online, A\'s edit reaches the server',
      onServer(away.id).project === 'Typed on A while offline', onServer(away.id).project);
    check('beside B\'s', onServer(away.id).location === 'B carried on', onServer(away.id).location);
    check('and only now does A say saved', A.Store.status.state === 'saved' && A.Store.status.pending === 0,
      A.Store.status.state + '/' + A.Store.status.pending);
    check('with nothing left on disk', !A.localStorage.getItem('dvbid.outbox.' + A.Store.user.id));

    console.log('\n--- closed while offline ---');
    const disk = {};
    const C = await openBrowser(ORIGIN, 'client C', jarA, disk);
    const cFetch = C.fetch;
    C.fetch = (u, o) => (o && o.method === 'POST' && String(u).indexOf('/api/changes') >= 0
      ? Promise.reject(new TypeError('Failed to fetch')) : cFetch(u, o));
    const lost = C.Store.db.bids.find(b => b.id === A.Store.db.bids[8].id);
    lost.project = 'Typed before the tab closed';
    C.Store.save();
    await wait(800);
    C.Remote.disconnect();
    C.close();
    check('it never reached the server', onServer(lost.id).project !== 'Typed before the tab closed');
    const C2 = await openBrowser(ORIGIN, 'client C reopened', jarA, disk);
    await wait(1500);
    check('the reopened page picks the edit back up', C2.Store.restored >= 1, String(C2.Store.restored));
    check('and sends it', onServer(lost.id).project === 'Typed before the tab closed',
      onServer(lost.id).project);
    C2.Remote.disconnect();
    C2.close();

    console.log('\n--- an Employee\'s Save takeoff ---');
    // Save takeoff also teaches the Rate Library, which an Employee used to be
    // refused - and the takeoff with it, on that save and every one after.
    {
      const bidT = B.Store.db.bids[10];
      B.Takeoff.openForBid(bidT.id);
      const tk = B.Store.db.takeoffs[bidOn(B, bidT.id).takeoffId];
      const prod = B.TakeoffModel.newProduct(B.Rates.TYPES[0], tk);
      prod.groups[0].items.push(B.TakeoffModel.newItem({ description: 'Employee taught part', partNo: 'EMP-1', unitCost: 7 }));
      tk.products.push(prod);
      B.Store.save();
      B.Takeoff.commit();
      await wait(1600);
      const srvTk = () => db.snapshot().takeoffs[tk.id];
      check('the Employee\'s takeoff reaches the server',
        srvTk() && srvTk().products.some(p => p.id === prod.id), B.Store.status.state);
      check('and the part it taught reaches the Rate Library',
        db.snapshot().catalog.some(c => c.partNo === 'EMP-1'));
      check('with nothing refused and nothing left waiting',
        B.Store.status.state === 'saved' && B.Store.status.pending === 0,
        B.Store.status.state + '/' + B.Store.status.pending + ' ' + B.Store.status.error);

      // A role without the right: the part is refused, the takeoff is not.
      const empRole = db.handle().prepare("SELECT id FROM roles WHERE name = 'Employee'").get().id;
      db.handle().prepare("DELETE FROM role_permissions WHERE role_id = ? AND perm = 'catalog.learn'").run(empRole);
      prod.groups[0].items.push(B.TakeoffModel.newItem({ description: 'Not allowed part', partNo: 'EMP-2', unitCost: 3 }));
      prod.totalLF = 77;
      B.Store.save();
      B.Takeoff.commit();
      await wait(2000);
      check('without it, the takeoff edit still lands', srvTk().products.find(p => p.id === prod.id).totalLF === 77,
        JSON.stringify(srvTk().products.find(p => p.id === prod.id).totalLF));
      check('the refused part is not on the server', !db.snapshot().catalog.some(c => c.partNo === 'EMP-2'));
      check('and is taken back off B\'s screen, not left to be refused forever',
        !B.Store.db.catalog.some(c => c.partNo === 'EMP-2'));
      check('so B ends up saved, not stuck', B.Store.status.state === 'saved' && B.Store.status.pending === 0,
        B.Store.status.state + '/' + B.Store.status.pending);
      db.handle().prepare("INSERT OR IGNORE INTO role_permissions (role_id, perm) VALUES (?, 'catalog.learn')").run(empRole);
    }

    console.log('\n--- a clashing Proposal No. holds back only its own bid ---');
    {
      const taken = A.Store.db.bids[13];
      taken.proposalNo = 'DIS-26-8888';
      A.Store.save();
      await wait(1400);
      const clash = bidOn(B, A.Store.db.bids[11].id);
      const other = bidOn(B, A.Store.db.bids[12].id);
      clash.proposalNo = taken.proposalNo;
      other.project = 'Saved despite the clash';
      B.Store.save();
      await wait(1600);
      check('the other edit lands', onServer(other.id).project === 'Saved despite the clash', onServer(other.id).project);
      check('the clashing bid does not', onServer(clash.id).proposalNo !== taken.proposalNo);
      check('and B is told it is not saved', B.Store.status.state === 'error', B.Store.status.state);
      clash.proposalNo = 'DIS-26-9999';
      B.Store.save();
      await wait(1400);
      check('once the number is changed, that bid goes too', onServer(clash.id).proposalNo === 'DIS-26-9999',
        onServer(clash.id).proposalNo);
      check('and B is saved again', B.Store.status.state === 'saved', B.Store.status.state);
    }

    console.log('\n--- two people typing in one takeoff ---');
    {
      // Count every refusal either browser is given: the point is that there
      // are none, because the server merges a save made against an older copy.
      let refusals = 0;
      const count = W => {
        const real = W.fetch;
        W.fetch = (u, o) => real(u, o).then(r => { if (r.status === 409) refusals++; return r; });
        return () => { W.fetch = real; };
      };
      const undoA = count(A), undoB = count(B);

      const tbid = A.Store.db.bids[14];
      A.Takeoff.openForBid(tbid.id);
      const tkId = bidOn(A, tbid.id).takeoffId;
      const tA = A.Store.db.takeoffs[tkId];
      ['p-one', 'p-two'].forEach(id => {
        const p = A.TakeoffModel.newProduct(A.Rates.TYPES[0], tA);
        p.id = id;
        p.type = 'Guardrail ' + id;
        p.groups[0].items.push(A.TakeoffModel.newItem({ id: id + '-i1', description: 'a' }));
        p.groups[0].items.push(A.TakeoffModel.newItem({ id: id + '-i2', description: 'b' }));
        tA.products.push(p);
      });
      A.Store.save();
      await wait(1400);
      const tB = B.Store.db.takeoffs[tkId];
      check('B has the takeoff A started', !!tB && tB.products.length === 2);

      // Ten edits each, interleaved, on one product and on different ones:
      // A on p-one's first row and p-two; B on p-one's SECOND row.
      const item = (t, pid, iid) => t.products.find(p => p.id === pid).groups[0].items.find(i => i.id === iid);
      for (let n = 1; n <= 10; n++) {
        item(A.Store.db.takeoffs[tkId], 'p-one', 'p-one-i1').qty = n;
        A.Store.db.takeoffs[tkId].products.find(p => p.id === 'p-two').totalLF = n * 10;
        A.Store.save();
        item(B.Store.db.takeoffs[tkId], 'p-one', 'p-one-i2').qty = n * 100;
        B.Store.save();
        await wait(150);
      }
      await wait(2500);
      const srv = db.snapshot().takeoffs[tkId];
      check('every one of A\'s edits is on the server',
        item(srv, 'p-one', 'p-one-i1').qty === 10 && srv.products.find(p => p.id === 'p-two').totalLF === 100,
        JSON.stringify({ q: item(srv, 'p-one', 'p-one-i1').qty, lf: srv.products.find(p => p.id === 'p-two').totalLF }));
      check('and every one of B\'s, in the same product', item(srv, 'p-one', 'p-one-i2').qty === 1000,
        String(item(srv, 'p-one', 'p-one-i2').qty));
      check('and both screens agree with it',
        JSON.stringify(A.Store.db.takeoffs[tkId].products) === JSON.stringify(srv.products) &&
        JSON.stringify(B.Store.db.takeoffs[tkId].products) === JSON.stringify(srv.products));
      check('without a single save being refused', refusals === 0, refusals + ' refusals');
      check('and both say saved', A.Store.status.state === 'saved' && B.Store.status.state === 'saved',
        A.Store.status.state + '/' + B.Store.status.state);

      console.log('\n--- both adding a drawing row at once ---');
      // Same product, same group, same moment. Neither screen is repainted
      // between adding the row and typing in it.
      A.Takeoff.openTakeoff(tkId); A.Takeoff.selectProduct('p-one');
      B.Takeoff.openTakeoff(tkId); B.Takeoff.selectProduct('p-one');
      const rowsOf = W => W.Store.db.takeoffs[tkId].products.find(p => p.id === 'p-one').groups[0].grid.rows;
      A.Takeoff.addRow();
      const rowA = rowsOf(A)[rowsOf(A).length - 1].id;
      B.Takeoff.addRow();
      const rowB = rowsOf(B)[rowsOf(B).length - 1].id;
      await wait(1400);
      check('new rows carry an id', !!rowA && !!rowB && rowA !== rowB);
      A.Takeoff.setRowRef(rowA, 'A-101');
      B.Takeoff.setRowRef(rowB, 'B-202');
      await wait(1600);
      const rowsSrv = db.snapshot().takeoffs[tkId].products.find(p => p.id === 'p-one').groups[0].grid.rows;
      check('both rows survive', rowsSrv.some(r => r.id === rowA) && rowsSrv.some(r => r.id === rowB),
        JSON.stringify(rowsSrv));
      check('and each person\'s typing landed in their own row',
        rowsSrv.find(r => r.id === rowA).ref === 'A-101' && rowsSrv.find(r => r.id === rowB).ref === 'B-202',
        JSON.stringify(rowsSrv.map(r => r.id + '=' + r.ref)));
      check('still without a refusal', refusals === 0, refusals + ' refusals');
      undoA(); undoB();

      console.log('\n--- somebody else\'s save does not move your page ---');
      B.Proposal.generateFromTakeoff(tkId);
      const propId = B.Proposal.currentId();
      B.App.switchTab('proposal');
      await wait(1400);
      const marker = () => { const el = B.document.getElementById('proposalEditScroll'); return el && el.dataset.mark; };
      B.document.getElementById('proposalEditScroll').dataset.mark = 'untouched';
      const notice = () => B.document.getElementById('liveNotice');

      // A works on a DIFFERENT project.
      const elsewhere = A.Store.db.bids[16];
      elsewhere.location = 'Elsewhere';
      A.Store.save();
      await wait(1400);
      check('a change to another project leaves B\'s proposal alone', marker() === 'untouched');
      check('with no notice', notice().classList.contains('hidden'));

      // A works on THIS proposal.
      A.Store.db.proposals[propId].proposalData.projectName = 'Renamed by Ada';
      A.Store.save();
      await wait(1400);
      check('a change to the proposal B has open is not repainted under B', marker() === 'untouched');
      check('B is told, by name', !notice().classList.contains('hidden') &&
        /Ada/.test(notice().textContent), notice().textContent.replace(/\s+/g, ' '));
      check('and the data underneath already has it',
        B.Store.db.proposals[propId].proposalData.projectName === 'Renamed by Ada');
      B.App.showLiveChanges();
      check('Show changes brings the screen up to date', marker() !== 'untouched');
      check('and takes the notice down', notice().classList.contains('hidden'));
      B.App.switchTab('active');
    }

    console.log('\n--- no server, no problem ---');
    const solo = await openBrowser(null, 'offline client');
    check('a browser with no server still opens',
      solo.Store.backend !== 'server' && solo.Store.db.bids.length > 0,
      solo.Store.backend + '/' + solo.Store.db.bids.length);
    check('and knows it is not shared', solo.Store.shared === false);
  } finally {
    sync.closeAll();
    server.close();
    db.close();
  }

  console.log('\n' + (failures === 0
    ? 'All sync checks passed.'
    : failures + ' CHECK(S) FAILED: ' + errors.join(', ')));
}

main()
  .then(() => process.exit(failures === 0 ? 0 : 1))
  .catch(e => {
    console.log('FAIL  harness: ' + e.message);
    console.log(e.stack);
    process.exit(1);
  });
