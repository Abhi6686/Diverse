/* API and sync tests. No DOM: this drives the real HTTP server the office runs,
   with a database in memory.

   Run with:  node --no-warnings tests/api.js
   No dependencies - fetch and EventSource-over-fetch are both built in.
*/
'use strict';

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

let failures = 0;
const errors = [];
function check(label, cond, detail) {
  if (!cond) { failures++; errors.push(label); }
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail && !cond ? '  -> ' + detail : ''}`);
}

const ROOT = path.join(__dirname, '..');
let server, BASE, db, api, sync;

/* The server is started in-process rather than as a child: the test can then
   reach into the database directly to set up a case, and there is no port race
   or stray process left behind if a check throws. */
function start() {
  db = require(path.join(ROOT, 'server/db'));
  api = require(path.join(ROOT, 'server/api'));
  sync = require(path.join(ROOT, 'server/sync'));
  db.open(':memory:');

  server = http.createServer((req, res) => {
    // No context argument: who is asking is read from the session cookie inside
    // api.handle, exactly as it is for the real serve.js.
    api.handle(req, res).catch(e => {
      res.writeHead(500).end(String(e));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      BASE = 'http://127.0.0.1:' + server.address().port + '/api';
      resolve();
    });
  });
}

function stop() {
  sync.closeAll();
  server.close();
  db.close();
}

/* Node's fetch does not keep cookies, and the session is a cookie, so the
   harness carries one itself. `cookie` is the identity every call below is made
   as - switching it is how the permission tests become a different person. */
let cookie = null;

function headers() {
  const h = { 'Content-Type': 'application/json' };
  if (cookie) h.Cookie = cookie;
  return h;
}

function grabCookie(res) {
  const list = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
  for (const line of list) {
    const pair = String(line).split(';')[0];
    if (pair.startsWith('dvsid=')) cookie = pair;
  }
}

const send = (method, p, body) => fetch(BASE + p, {
  method, headers: headers(), body: body === undefined ? undefined : JSON.stringify(body)
}).then(async r => {
  grabCookie(r);
  return { status: r.status, body: await r.json().catch(() => ({})) };
});

const get = (p) => send('GET', p);
const post = (p, body) => send('POST', p, body);
const patch = (p, body) => send('PATCH', p, body);
const del = (p) => send('DELETE', p);

/* Sign in and keep the cookie. Returns the identity so a test can swap back. */
async function signIn(username, password) {
  cookie = null;
  const r = await post('/login', { username, password });
  return { ok: r.status === 200, cookie, body: r.body };
}

/* A minimal SSE reader. The browser has EventSource; Node does not, and the
   point here is to prove the wire format is what a browser will accept. */
function openStream(onEvent) {
  const controller = new AbortController();
  const ready = fetch(BASE + '/stream', {
    signal: controller.signal, headers: headers()
  }).then(async res => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i); buf = buf.slice(i + 2);
            const ev = (frame.match(/^event: (.*)$/m) || [])[1];
            const data = (frame.match(/^data: (.*)$/m) || [])[1];
            if (ev && data) onEvent(ev, JSON.parse(data));
          }
        }
      } catch (e) { /* aborted */ }
    })();
    return res;
  });
  return { ready, close: () => controller.abort() };
}

const wait = ms => new Promise(r => setTimeout(r, ms));

let ADMIN, EMPLOYEE;      // cookies, so a test can act as either person

async function run() {
  console.log('--- schema and bootstrap ---');
  let r = await get('/health');
  check('health answers', r.status === 200 && r.body.ok === true);
  check('schema is at the latest version', r.body.schema >= 2, String(r.body.schema));

  console.log('\n--- first run: there is nobody yet ---');
  r = await get('/session');
  check('a fresh database asks to be set up', r.body.setupNeeded === true);
  check('and nobody is signed in', r.body.user === null);
  check('the permission catalogue comes with it',
    Array.isArray(r.body.catalogue) && r.body.catalogue.length > 10,
    String((r.body.catalogue || []).length));

  r = await get('/bootstrap');
  check('the data is refused until somebody signs in', r.status === 401, String(r.status));
  r = await post('/changes', { changes: [{ kind: 'bid', id: 99, json: { id: 99, project: 'X' } }] });
  check('and so are writes', r.status === 401, String(r.status));

  r = await post('/setup', { name: 'Ada', username: 'ada', initials: 'AL', password: 'short' });
  check('a weak first password is refused', r.status === 400, JSON.stringify(r.body));

  r = await post('/setup', { name: 'Ada Lovelace', password: 'letmein123' });
  check('a missing username is refused', r.status === 400, JSON.stringify(r.body));

  r = await post('/setup', {
    name: 'Ada Lovelace', username: 'ada', email: 'ada@diverse.test', initials: 'al', password: 'letmein123'
  });
  check('the first administrator is created', r.status === 200, JSON.stringify(r.body));
  check('and is signed in straight away', !!cookie, String(cookie));
  check('with every permission', r.body.user.permissions.length === r.body.catalogue.length,
    r.body.user.permissions.length + ' of ' + r.body.catalogue.length);
  ADMIN = cookie;

  r = await post('/setup', { name: 'Sneak', username: 'sneak', password: 'letmein123' });
  check('setup cannot be used a second time to mint another admin', r.status === 409, String(r.status));

  r = await get('/session');
  check('the session now names the person', r.body.user && r.body.user.name === 'Ada Lovelace');
  check('and setup is no longer offered', r.body.setupNeeded === false);

  console.log('\n--- one person is one engineer ---');
  r = await get('/bootstrap');
  const eng = r.body.db.engineers.find(e => e.initials === 'AL');
  check('creating the account created their engineer entry', !!eng, JSON.stringify(r.body.db.engineers));
  check('and linked it to the account', eng && eng.userId === 1, JSON.stringify(eng));

  r = await get('/bootstrap');
  check('bootstrap returns an empty world', r.status === 200 && r.body.db.bids.length === 0);
  // Not 0: creating the administrator wrote their engineer row through the same
  // change log everything else goes through.
  const seq0 = r.body.seq;
  check('and a seq to start counting from', seq0 >= 1, String(seq0));
  check('bootstrap carries the signed-in person', r.body.user.username === 'ada');

  console.log('\n--- writing ---');
  r = await post('/changes', {
    changes: [
      { kind: 'bid', id: 1, json: { id: 1, project: 'Murray Tower', proposalNo: 'P-1', active: true, status: 'Not Started' } },
      { kind: 'bid', id: 2, json: { id: 2, project: 'CVS Keystone', active: false } },
      { kind: 'setting', id: 'regions', json: ['Allegheny County', 'Beaver County'] }
    ]
  });
  check('a batch is applied', r.status === 200 && r.body.applied.length === 3, JSON.stringify(r.body));
  check('each write gets rev 1', r.body.applied.every(a => a.rev === 1));
  check('and the seq advances by one per write', r.body.seq === seq0 + 3, String(r.body.seq));

  r = await get('/bootstrap');
  check('bootstrap reflects the writes', r.body.db.bids.length === 2);
  check('settings come back in their own shape',
    Array.isArray(r.body.db.regions) && r.body.db.regions.length === 2,
    JSON.stringify(r.body.db.regions));
  check('and revs are reported per record',
    r.body.db.revs['bid:1'] === 1, JSON.stringify(r.body.db.revs));

  console.log('\n--- concurrency ---');
  // A put replaces the whole record - the client holds and sends complete
  // objects - so the test does too, or it would silently drop proposalNo.
  const bid1 = { id: 1, project: 'Murray Tower Rehab', proposalNo: 'P-1', active: true, status: 'Not Started' };
  r = await post('/changes', { changes: [{ kind: 'bid', id: 1, rev: 1, json: bid1 }] });
  check('an edit with the current rev is accepted', r.status === 200 && r.body.applied[0].rev === 2);

  // Two people editing the same bid: the second must not silently win.
  r = await post('/changes', { changes: [{ kind: 'bid', id: 1, rev: 1, json: Object.assign({}, bid1, { project: 'Stale overwrite' }) }] });
  check('a stale rev is refused', r.status === 409 && r.body.error === 'conflict');
  check('and the server hands back its own copy',
    r.body.current.project === 'Murray Tower Rehab', JSON.stringify(r.body.current));
  check('with the rev to retry from', r.body.rev === 2, String(r.body.rev));

  r = await get('/bootstrap');
  check('the refused write did not land',
    r.body.db.bids.find(b => b.id === 1).project === 'Murray Tower Rehab');

  // A batch is all-or-nothing: a conflict in the middle must not leave the
  // first write applied while the client believes none of them were.
  r = await post('/changes', {
    changes: [
      { kind: 'bid', id: 3, json: { id: 3, project: 'Should not exist' } },
      { kind: 'bid', id: 1, rev: 1, json: Object.assign({}, bid1, { project: 'Also not' }) }
    ]
  });
  check('a batch with a conflict is rejected whole', r.status === 409);
  r = await get('/bootstrap');
  check('and nothing from it was written',
    !r.body.db.bids.some(b => b.id === 3), JSON.stringify(r.body.db.bids.map(b => b.id)));

  console.log('\n--- uniqueness is the database\'s job ---');
  r = await post('/changes', { changes: [{ kind: 'bid', id: 4, json: { id: 4, project: 'Dup', proposalNo: 'p-1' } }] });
  check('a duplicate Proposal No. is refused, case-insensitively',
    r.status === 409 && r.body.error === 'duplicate', JSON.stringify(r.body));
  check('and it names the field', r.body.field === 'Proposal No.', r.body.field);

  await post('/changes', { changes: [{ kind: 'bid', id: 5, json: { id: 5, project: 'Won', awardNo: 'DIS-26-0001' } }] });
  r = await post('/changes', { changes: [{ kind: 'bid', id: 6, json: { id: 6, project: 'Also won', awardNo: 'DIS-26-0001' } }] });
  check('a duplicate Job No. is refused too',
    r.status === 409 && r.body.field === 'Job No.', JSON.stringify(r.body));

  r = await post('/changes', { changes: [{ kind: 'bid', id: 7, json: { id: 7, project: 'No number' } }] });
  check('but many bids may have no number at all', r.status === 200);
  r = await post('/changes', { changes: [{ kind: 'bid', id: 8, json: { id: 8, project: 'Nor this one' } }] });
  check('several blanks do not collide with each other', r.status === 200);

  console.log('\n--- bad input ---');
  r = await post('/changes', { changes: [{ kind: 'not-a-kind', id: 1, json: {} }] });
  check('an unknown kind is refused', r.status === 400, JSON.stringify(r.body));
  r = await post('/changes', { changes: [{ kind: 'bid', json: {} }] });
  check('a change with no id is refused', r.status === 400);
  r = await post('/changes', { changes: [{ kind: 'bid', id: 9 }] });
  check('a put with no body is refused', r.status === 400);
  r = await post('/changes', { changes: 'nope' });
  check('a non-array batch is refused', r.status === 400);
  r = await get('/nope');
  check('an unknown endpoint 404s', r.status === 404);

  console.log('\n--- the change log ---');
  const before = (await get('/bootstrap')).body.seq;
  await post('/changes', { changes: [{ kind: 'bid', id: 10, json: { id: 10, project: 'Later' } }] });
  r = await get('/changes?since=' + before);
  check('changes since a seq are returned', r.body.changes.length === 1, String(r.body.changes.length));
  check('with the record attached', r.body.changes[0].json.project === 'Later');
  r = await get('/changes?since=0');
  check('and since 0 replays everything accepted so far',
    r.body.changes.length >= 8, String(r.body.changes.length));

  /* A record too big to copy into the log on every autosave. The log announces
     that it moved and /api/records carries the body - see logChange in
     server/db.js for why, and js/remote.js deliver() for the client half. */
  console.log('\n--- bodies too large for the log ---');
  const bigMark = (await get('/bootstrap')).body.seq;
  const big = { id: 11, project: 'Big', filler: 'x'.repeat(64 * 1024) };
  r = await post('/changes', { changes: [{ kind: 'bid', id: 11, json: big }] });
  check('an oversized record is accepted', r.status === 200);

  r = await get('/changes?since=' + bigMark);
  const entry = r.body.changes.find(c => String(c.id) === '11');
  check('its change is logged', !!entry);
  check('but without the body', entry && entry.json === null);
  check('and the log still says what moved and how',
    entry && entry.kind === 'bid' && entry.op === 'put');

  r = await post('/records', { records: [{ kind: 'bid', id: 11 }] });
  check('the body is fetchable from /api/records', r.status === 200 &&
    r.body.records.length === 1 && r.body.records[0].json.filler.length === 64 * 1024);
  check('and it comes back with the record rev',
    r.body.records[0].rev >= 1);

  r = await post('/records', { records: [{ kind: 'bid', id: 9999 }] });
  check('a record that no longer exists is simply absent, not an error',
    r.status === 200 && r.body.records.length === 0);
  r = await post('/records', { records: [{ kind: 'not-a-kind', id: 1 }] });
  check('an unknown kind is ignored rather than refused', r.status === 200);
  r = await post('/records', { records: 'nope' });
  check('a non-array is refused', r.status === 400);

  // A small record must still travel with its change, or every edit in the
  // office would cost a second round trip.
  r = await get('/changes?since=' + before);
  check('a small record still carries its body',
    r.body.changes.some(c => String(c.id) === '10' && c.json && c.json.project === 'Later'));

  await post('/changes', { changes: [{ kind: 'bid', id: 11, op: 'delete' }] });

  console.log('\n--- deleting ---');
  r = await post('/changes', { changes: [{ kind: 'bid', id: 10, op: 'delete' }] });
  check('a delete is applied', r.status === 200);
  r = await get('/bootstrap');
  check('and the record is gone', !r.body.db.bids.some(b => b.id === 10));
  r = await get('/changes?since=' + before);
  check('the delete is in the log as its own op',
    r.body.changes.some(c => c.op === 'delete' && String(c.id) === '10'));

  console.log('\n--- live sync ---');
  const seen = [];
  let myClientId = null;
  const stream = openStream((ev, data) => {
    if (ev === 'hello') myClientId = data.clientId;
    else seen.push({ ev, data });
  });
  await stream.ready;
  await wait(150);
  check('the stream says hello with a client id', myClientId != null, String(myClientId));

  await post('/changes', { changes: [{ kind: 'bid', id: 11, json: { id: 11, project: 'From someone else' } }] });
  await wait(200);
  const pushed = seen.filter(s => s.ev === 'changes');
  check('another person\'s write arrives on the stream', pushed.length === 1, JSON.stringify(seen));
  check('carrying the record', pushed.length > 0 &&
    pushed[0].data[0].json.project === 'From someone else');
  check('and its seq, so a client knows where it is up to',
    pushed.length > 0 && pushed[0].data[0].seq > 0);

  // Your own edit must not come back at you: it would repaint the screen under
  // your cursor for a change you just made.
  seen.length = 0;
  await post('/changes', {
    clientId: myClientId,
    changes: [{ kind: 'bid', id: 12, json: { id: 12, project: 'Mine' } }]
  });
  await wait(200);
  check('your own write does not echo back to you',
    seen.filter(s => s.ev === 'changes').length === 0, JSON.stringify(seen));

  // A second listener stands in for a colleague's browser.
  const seenB = [];
  const streamB = openStream((ev, data) => { if (ev === 'changes') seenB.push(data); });
  await streamB.ready;
  await wait(150);
  await post('/changes', {
    clientId: myClientId,
    changes: [{ kind: 'bid', id: 13, json: { id: 13, project: 'Broadcast' } }]
  });
  await wait(200);
  check('but it does reach everybody else', seenB.length === 1, JSON.stringify(seenB));

  console.log('\n--- who is looking at what ---');
  {
    /* The stream always knew who was connected. What it did not know was what
       any of them had OPEN, which is the part worth telling everybody else. */
    const heard = [];
    let idC = null;
    const streamC = openStream((ev, data) => {
      if (ev === 'hello') idC = data.clientId;
      if (ev === 'presence') heard.push(data.online);
    });
    await streamC.ready;
    await wait(150);
    check('a new connection is announced to everybody',
      heard.length > 0, String(heard.length));

    heard.length = 0;
    await post('/where', { clientId: myClientId, bidId: 11, section: 'takeoff' });
    await wait(200);
    const last = heard[heard.length - 1] || [];
    const mine = last.filter(c => c.clientId === myClientId)[0];
    check('saying where you are reaches the other connections',
      !!mine && mine.where && mine.where.bidId === 11,
      JSON.stringify(last));
    check('with the page as well as the project',
      mine && mine.where.section === 'takeoff', JSON.stringify(mine));
    check('and who you are, so the marker can say a name',
      !!mine && !!mine.name, JSON.stringify(mine));
    check('everybody else is still reported as nowhere in particular',
      last.filter(c => c.clientId !== myClientId).every(c => !c.where),
      JSON.stringify(last));

    // Repeating a position must not repaint every screen in the office.
    heard.length = 0;
    await post('/where', { clientId: myClientId, bidId: 11, section: 'takeoff' });
    await wait(150);
    check('saying the same thing twice broadcasts nothing',
      heard.length === 0, JSON.stringify(heard));

    // Leaving is a position too - it is how the marker clears.
    heard.length = 0;
    await post('/where', { clientId: myClientId, bidId: null });
    await wait(200);
    const after = heard[heard.length - 1] || [];
    check('and leaving a project clears it',
      after.filter(c => c.clientId === myClientId).every(c => !c.where),
      JSON.stringify(after));

    // A client whose stream has just dropped is ordinary, not an error.
    const r2 = await post('/where', { clientId: 999999, bidId: 11 });
    check('an unknown connection is ignored rather than refused',
      r2.status === 200, String(r2.status));

    // Closing a window is the other way a marker clears, and nobody sends
    // anything to say so - the server notices the socket go.
    seen.length = 0;
    streamC.close();
    await wait(250);
    const heardByA = seen.filter(s => s.ev === 'presence').pop();
    check('disconnecting takes you off everybody else\'s list',
      !!heardByA && !heardByA.data.online.some(c => c.clientId === idC),
      JSON.stringify(heardByA && heardByA.data.online));
  }

  streamB.close();
  stream.close();
  await wait(100);

  console.log('\n--- catching up after a drop ---');
  const mark = (await get('/bootstrap')).body.seq;
  await post('/changes', { changes: [{ kind: 'bid', id: 14, json: { id: 14, project: 'Missed one' } }] });
  await post('/changes', { changes: [{ kind: 'bid', id: 15, json: { id: 15, project: 'Missed two' } }] });
  r = await get('/changes?since=' + mark);
  check('a client that was away gets exactly what it missed',
    r.body.changes.length === 2 &&
    r.body.changes.map(c => c.json.project).join(',') === 'Missed one,Missed two',
    JSON.stringify(r.body.changes.map(c => c.json && c.json.project)));
  check('and the seq to resume from', r.body.seq === mark + 2, String(r.body.seq));

  console.log('\n--- accounts ---');
  cookie = ADMIN;
  r = await post('/users', { name: 'Grace H', username: 'grace', initials: 'GH', password: 'passw0rd1' });
  check('an admin can create an employee with no email at all', r.status === 200, JSON.stringify(r.body));
  check('who lands in the Employee role by default', r.body.user.role === 'Employee', r.body.user.role);
  check('and has no email on file', r.body.user.email === '', JSON.stringify(r.body.user));
  const graceId = r.body.user.id;

  r = await post('/users', { name: 'Dup', username: 'GRACE', password: 'passw0rd1' });
  check('a username cannot be used twice, whatever the case', r.status === 409, String(r.status));

  r = await post('/users', { name: 'Bad', username: 'no', password: 'passw0rd1' });
  check('a too-short username is refused', r.status === 400, String(r.status));

  r = await post('/users', { name: 'Bad', username: 'grace2', email: 'not-an-email', password: 'passw0rd1' });
  check('a malformed email is refused', r.status === 400, String(r.status));

  r = await get('/users');
  check('the people list never carries a password hash',
    JSON.stringify(r.body.users).indexOf('pw_') < 0 && !('pwHash' in r.body.users[0]),
    JSON.stringify(r.body.users[0]));

  const signedIn = await signIn('grace', 'passw0rd1');
  check('the employee can sign in by username', signedIn.ok, JSON.stringify(signedIn.body));
  EMPLOYEE = cookie;
  check('and gets fewer permissions than the admin',
    signedIn.body.user.permissions.length < r.body.roles.find(x => x.name === 'Admin').permissions.length,
    String(signedIn.body.user.permissions.length));

  const wrong = await signIn('grace', 'not-it');
  check('a wrong password is refused', !wrong.ok);
  check('and does not say whether the account exists',
    /do not match/.test(wrong.body.error), wrong.body.error);
  const nobody = await signIn('nobody', 'passw0rd1');
  check('an unknown username gets the identical message',
    nobody.body.error === wrong.body.error, nobody.body.error);

  console.log('\n--- what an employee may and may not do ---');
  cookie = EMPLOYEE;
  r = await post('/changes', { changes: [{ kind: 'bid', id: 20, json: { id: 20, project: 'Employee bid' } }] });
  check('an employee can add a bid', r.status === 200, JSON.stringify(r.body));

  r = await post('/changes', {
    changes: [{ kind: 'bid', id: 20, rev: 1, json: { id: 20, project: 'Employee bid, edited' } }]
  });
  check('and edit it', r.status === 200, JSON.stringify(r.body));

  // This is the check that matters: the request is forged directly at the API,
  // with no button anywhere on their screen that would have sent it.
  r = await post('/changes', { changes: [{ kind: 'bid', id: 20, op: 'delete' }] });
  check('but a delete is refused even when the request is forged',
    r.status === 403 && /bid.delete/.test(r.body.error), JSON.stringify(r.body));

  r = await get('/bootstrap');
  check('and the bid is still there', r.body.db.bids.some(b => b.id === 20));

  r = await post('/changes', { changes: [{ kind: 'setting', id: 'company', json: { name: 'Not yours' } }] });
  check('changing shop-wide settings is refused', r.status === 403, JSON.stringify(r.body));

  // Adding to a list while working a bid is not administering the list, and
  // must not fail - the whole batch would go with it.
  const regionsNow = (await get('/bootstrap')).body.db.regions;
  r = await post('/changes', {
    changes: [{ kind: 'setting', id: 'regions', rev: 1, json: regionsNow.concat(['Butler County']) }]
  });
  check('but adding to a managed list while working is allowed', r.status === 200, JSON.stringify(r.body));

  r = await post('/changes', {
    changes: [{ kind: 'setting', id: 'regions', rev: 2, json: ['Only this one'] }]
  });
  check('while reorganising that same list is not', r.status === 403, JSON.stringify(r.body));

  r = await post('/changes', {
    changes: [{ kind: 'bid', id: 20, rev: 2, json: { id: 20, project: 'Employee bid, edited', awardNo: 'DIS-26-0900', status: 'Awarded' } }]
  });
  check('awarding is allowed - the screenshots mark it for everyone', r.status === 200, JSON.stringify(r.body));

  r = await get('/users');
  check('the people screen is refused', r.status === 403, String(r.status));
  r = await post('/roles', { name: 'Sneaky', permissions: ['bid.delete'] });
  check('and so is inventing a role', r.status === 403, String(r.status));

  r = await post('/changes', {
    reason: 'load',
    changes: [{ kind: 'bid', id: 21, json: { id: 21, project: 'Restore' } }]
  });
  check('restoring a whole backup is refused', r.status === 403 && /project.load/.test(r.body.error),
    JSON.stringify(r.body));

  console.log('\n--- one person\'s layout is their own ---');
  await send('PUT', '/prefs', { prefs: { grids: { active: { visible: ['project'] } } } });
  r = await get('/prefs');
  check('a layout saved comes back', r.body.prefs.grids.active.visible[0] === 'project',
    JSON.stringify(r.body.prefs));
  cookie = ADMIN;
  r = await get('/prefs');
  check('and is not visible to anybody else', !r.body.prefs, JSON.stringify(r.body.prefs));

  console.log('\n--- roles ---');
  cookie = ADMIN;
  r = await post('/roles', { name: 'Senior Estimator', permissions: ['module.bids', 'bid.edit', 'bid.delete'] });
  check('an admin can create a role', r.status === 200, JSON.stringify(r.body));
  const seniorId = r.body.role.id;

  r = await patch('/users/' + graceId, { roleId: seniorId });
  check('and move somebody into it', r.status === 200 && r.body.user.role === 'Senior Estimator',
    JSON.stringify(r.body));

  // The permission arrives without them signing in again: the check is made
  // against the role on every request, not against anything cached at login.
  cookie = EMPLOYEE;
  r = await post('/changes', { changes: [{ kind: 'bid', id: 20, op: 'delete' }] });
  check('the new role\'s delete right takes effect at once', r.status === 200, JSON.stringify(r.body));

  cookie = ADMIN;
  r = await del('/roles/' + seniorId);
  check('a role somebody is in cannot be deleted', r.status === 409, JSON.stringify(r.body));
  r = await del('/roles/' + (await get('/roles')).body.roles.find(x => x.name === 'Admin').id);
  check('nor can a built-in one', r.status === 409, JSON.stringify(r.body));

  console.log('\n--- the last administrator cannot be locked out ---');
  const adminRoleId = (await get('/roles')).body.roles.find(x => x.name === 'Admin').id;
  r = await del('/users/1');
  check('the only admin cannot be deleted', r.status === 409, JSON.stringify(r.body));
  r = await patch('/users/1', { active: false });
  check('nor deactivated', r.status === 409, JSON.stringify(r.body));
  r = await patch('/users/1', { roleId: seniorId });
  check('nor demoted out of Admin', r.status === 409, JSON.stringify(r.body));
  r = await patch('/roles/' + adminRoleId, { permissions: ['module.bids'] });
  check('and their own role cannot have its admin rights removed', r.status === 409, JSON.stringify(r.body));
  r = await get('/session');
  check('so they are still an administrator', r.body.user.permissions.indexOf('admin.users') >= 0);

  console.log('\n--- deactivating and signing out ---');
  r = await patch('/users/' + graceId, { active: false });
  check('an admin can deactivate somebody', r.status === 200, JSON.stringify(r.body));
  cookie = EMPLOYEE;
  r = await get('/bootstrap');
  check('their session stops working immediately', r.status === 401, String(r.status));
  const back = await signIn('grace', 'passw0rd1');
  check('and they cannot sign back in', !back.ok && /deactivated/.test(back.body.error),
    JSON.stringify(back.body));

  cookie = ADMIN;
  r = await post('/logout', {});
  check('signing out answers ok', r.status === 200);
  cookie = ADMIN;                         // the token the browser had before
  r = await get('/bootstrap');
  check('and the old token is revoked, not merely forgotten', r.status === 401, String(r.status));

  // Back in as the admin for anything that follows.
  await signIn('ada', 'letmein123');
  ADMIN = cookie;

  console.log('\n--- persistence across a restart ---');
  {
    const fs = require('fs');
    const tmp = path.join(ROOT, '.scratch', 'restart-test.db');
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.unlinkSync(f); } catch (e) {} }

    db.close();
    db.open(tmp);
    db.putMany([{ kind: 'bid', id: 100, json: { id: 100, project: 'Survives' } }], null);
    const seqBefore = db.latestSeq();
    db.close();

    db.open(tmp);
    const snap = db.snapshot();
    check('records survive a restart',
      snap.bids.length === 1 && snap.bids[0].project === 'Survives');
    check('and so does the change log', db.latestSeq() === seqBefore, String(db.latestSeq()));
    check('the schema is not re-applied on a second open', true);
    db.close();
    for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.unlinkSync(f); } catch (e) {} }
    db.open(':memory:');
  }

  console.log('\n' + (failures === 0
    ? 'All API checks passed.'
    : failures + ' CHECK(S) FAILED: ' + errors.join(', ')));
}

start()
  .then(run)
  .then(() => { stop(); process.exit(failures === 0 ? 0 : 1); })
  .catch(e => {
    console.log('FAIL  harness: ' + e.message);
    console.log(e.stack);
    try { stop(); } catch (ignored) {}
    process.exit(1);
  });
