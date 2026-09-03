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

function presence() {
  const byUser = new Map();
  for (const c of clients.values()) {
    const key = c.userId == null ? 'anon-' + c.id : 'u' + c.userId;
    if (!byUser.has(key)) byUser.set(key, { userId: c.userId, name: c.name, tabs: 0 });
    byUser.get(key).tabs++;
  }
  return [...byUser.values()];
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
  add, remove, broadcast, broadcastPresence, presence, closeAll,
  get count() { return clients.size; }
};
