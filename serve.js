/* serve.js - the application server.
 *
 *   node serve.js                  -> http://localhost:9000, ./diverse.db
 *   node serve.js 3000             -> a different port
 *   node serve.js --db /path/x.db  -> a different database file
 *
 * 9000 rather than the usual 8080, which was already taken on the machine this
 * runs on. Pass a different port as the first argument if 9000 clashes.
 *
 * This serves two things: the static files, and the /api routes that hold the
 * shared database. One process, no dependencies - the SQLite driver is built
 * into Node 22 (node:sqlite). It prints an "experimental" warning, which the
 * npm script silences with --no-warnings; the API it uses is stable and becomes
 * non-experimental in Node 24.
 *
 * Everyone in the office points a browser at this one machine, so there is one
 * set of bids rather than one per laptop.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const db = require('./server/db');
const api = require('./server/api');
const sync = require('./server/sync');

const ROOT = __dirname;

/* ---- arguments --------------------------------------------------------- */

const argv = process.argv.slice(2);
function flag(name, fallback) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const PORT = Number(argv.find(a => /^\d+$/.test(a))) || Number(flag('port', 0)) || 9000;
const DB_FILE = flag('db', path.join(ROOT, 'diverse.db'));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};

const server = http.createServer(function (req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.parse(req.url).pathname);
  } catch (e) {
    res.writeHead(400).end('Bad request');
    return;
  }

  // The API answers first; anything it does not claim falls through to a file.
  // Who is asking is read from the session cookie inside api.handle, so there
  // is one place that decides it rather than two that can disagree.
  if (pathname.startsWith('/api/')) {
    api.handle(req, res).catch(function (e) {
      console.error('Unhandled API failure:', e);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Server error' }));
    });
    return;
  }

  if (pathname === '/') pathname = '/Bid_Proposal_Manager_2026.html';

  // The database is not a downloadable asset.
  if (/\.db(-wal|-shm)?$/i.test(pathname)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Forbidden');
    return;
  }

  // Resolve inside ROOT only - refuse anything that climbs out with ../
  const filePath = path.join(ROOT, pathname);
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(filePath, function (err, stat) {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found: ' + pathname);
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      // The app is edited constantly during development; never serve a stale module.
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

/* The addresses other machines on the office network use to reach this one.
   Printed because "open it on your laptop" is the first thing anybody asks. */
function lanAddresses() {
  const nets = require('os').networkInterfaces();
  const out = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

db.open(DB_FILE, function (m) { console.log(m); });

server.listen(PORT, function () {
  console.log('\n  DiverSe Project Management');
  console.log('  http://localhost:' + PORT);
  lanAddresses().forEach(function (ip) {
    console.log('  http://' + ip + ':' + PORT + '   (from other machines)');
  });
  console.log('\n  Database  ' + db.path);
  console.log('  Files     ' + ROOT);
  console.log('  Ctrl+C to stop\n');
});

/* Close the database cleanly so WAL is checkpointed rather than left for the
   next process to recover. */
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n  Stopping...');
  sync.closeAll();
  server.close(function () {
    db.close();
    process.exit(0);
  });
  // Do not hang forever on a client that will not let go of its SSE stream.
  setTimeout(function () { db.close(); process.exit(0); }, 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.on('error', function (e) {
  if (e.code === 'EADDRINUSE') {
    console.error('\n  Port ' + PORT + ' is already in use.');
    console.error('  Either it is already running, or try:  node serve.js ' + (PORT + 1) + '\n');
  } else {
    console.error(e);
  }
  process.exit(1);
});
