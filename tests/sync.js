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
  'js/proposal.styles.js', 'js/proposal.defaults.js', 'js/util.js', 'js/ui.js', 'js/datepicker.js', 'js/sparks.js', 'js/intro.js', 'js/guide.js', 'js/auth.js', 'js/remote.js',
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
function openBrowser(origin, label, jar) {
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
      const store = {};
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

    console.log('\n--- a conflict is reported, not silently lost ---');
    // Somebody edits the record straight on the server while A holds an older
    // copy - exactly two people editing one bid at the same moment.
    const contested = A.Store.db.bids[1];
    const serverCopy = db.snapshot().bids.find(b => b.id === contested.id);
    db.putMany([{ kind: 'bid', id: contested.id, op: 'put',
      json: Object.assign({}, serverCopy, { project: 'Won the race' }) }], null);

    contested.project = 'Lost the race';
    A.Store.save();
    await wait(1400);
    check('the server keeps the version that got there first',
      db.snapshot().bids.find(b => b.id === contested.id).project === 'Won the race',
      db.snapshot().bids.find(b => b.id === contested.id).project);
    check('and A is corrected to it rather than believing its own',
      A.Store.db.bids.find(b => b.id === contested.id).project === 'Won the race',
      A.Store.db.bids.find(b => b.id === contested.id).project);

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
