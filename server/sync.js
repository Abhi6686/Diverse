/* sync.js - the live half: who is connected, and what to push at them.
 *
 * Server-Sent Events rather than WebSockets. The traffic here is one-way -
 * the server telling browsers what changed, while writes go up as ordinary
 * POSTs - and SSE is exactly that shape. It rides the existing http server,
 * needs no dependency and no protocol upgrade, and the browser reconnects on
 * its own when the office wifi hiccups.
 *
 * A dropped client does not reload the world when it comes back. Every change
 * carries its `seq` from the append-only log, so a client asks for everything
 * after the last seq it saw and is exactly caught up.
 */
'use strict';

let nextId = 1;
const clients = new Map();      // id -> { res, userId, name, since }

/* Browsers give up on an idle stream, and so do proxies. A comment line every
   25 seconds keeps it open and costs two bytes. */
const HEARTBEAT_MS = 25000;
let heartbeat = null;

function add(res, req, user) {
  const id = nextId++;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    // Node buffers small writes; SSE needs them to go out immediately.
    'X-Accel-Buffering': 'no'
  });
  // Tell the browser how long to wait before retrying a dropped stream.
  res.write('retry: 2000\n\n');

  const client = {
    id: id,
    res: res,
    userId: user ? user.id : null,
    name: user ? user.name : null,
    // The initials the bids table already knows this person by, so a presence
    // marker on a row reads the same as the Engineer column beside it.
    initials: user ? (user.initials || null) : null,
    // Which record this connection is looking at, once it says - see setWhere.
    where: null,
    at: Date.now()
  };
  clients.set(id, client);

  const drop = () => remove(id);
  req.on('close', drop);
  req.on('error', drop);
  res.on('error', drop);

  startHeartbeat();
  sendTo(client, 'hello', { clientId: id, online: presence() });
  broadcastPresence();
  return id;
}

function remove(id) {
  const c = clients.get(id);
  if (!c) return;
  clients.delete(id);
  try { c.res.end(); } catch (e) { /* already gone */ }
  if (!clients.size) stopHeartbeat();
  else broadcastPresence();
}

function sendTo(client, event, data) {
  try {
    client.res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
    return true;
  } catch (e) {
    // A write to a socket the client has already closed: drop it rather than
    // letting one dead connection take the request down.
    remove(client.id);
    return false;
  }
}

/* Sends the applied changes to everyone except the person who made them - they
   already have the result, and echoing it back would repaint the screen under
   their cursor for no reason.

   `originId` is the SSE client id the writer sent with its POST, so two tabs
   belonging to the same user still update each other. */
function broadcast(changes, originId) {
  if (!changes || !changes.length) return;
  for (const client of clients.values()) {
    if (originId && client.id === Number(originId)) continue;
    sendTo(client, 'changes', changes);
  }
}

/* WHERE A CONNECTION IS LOOKING.
 *
 * The stream already knew who was connected. It did not know what any of them
 * had open, which is the thing worth telling everybody else: two people on the
 * same project, each unaware of the other, is how one of them loses an
 * afternoon's edit to the other's.
 *
 * The client says so itself - there is nothing to infer from, since reading is
 * not a request the server sees. Unknown ids are ignored rather than refused: a
 * client whose stream dropped a moment ago is a normal thing, not an error.
 */
function setWhere(clientId, where) {
  const c = clients.get(Number(clientId));
  if (!c) return false;
  const next = where && where.bidId != null
    ? { bidId: where.bidId, section: where.section || null }
    : null;
  // Only broadcast on a real move. A client repeating itself must not repaint
  // every other screen in the office.
  if (JSON.stringify(next) === JSON.stringify(c.where)) return true;
  c.where = next;
  broadcastPresence();
  return true;
}

/* One entry per CONNECTION, not per person: somebody with two tabs open on two
   projects is in two places, and the client is what decides how to group that
   for a given screen. */
function presence() {
  return [...clients.values()].map(c => ({
    clientId: c.id,
    userId: c.userId,
    name: c.name,
    initials: c.initials,
    where: c.where
  }));
}

function broadcastPresence() {
  const online = presence();
  for (const client of clients.values()) sendTo(client, 'presence', { online: online });
}

function startHeartbeat() {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    for (const client of clients.values()) {
      try { client.res.write(': ping\n\n'); } catch (e) { remove(client.id); }
    }
  }, HEARTBEAT_MS);
  // Do not hold the process open on the heartbeat alone.
  if (heartbeat.unref) heartbeat.unref();
}

function stopHeartbeat() {
  if (!heartbeat) return;
  clearInterval(heartbeat);
  heartbeat = null;
}

function closeAll() {
  for (const id of [...clients.keys()]) remove(id);
  stopHeartbeat();
}

module.exports = {
  add, remove, broadcast, broadcastPresence, presence, setWhere, closeAll,
  get count() { return clients.size; }
};
