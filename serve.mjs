/**
 * serve.mjs — minimal static dev server.
 *
 * The only thing it does beyond serving files is send `Cache-Control:
 * no-store`. Without that, browsers apply *heuristic* freshness to responses
 * that carry only `Last-Modified` — the longer a file has gone unchanged, the
 * longer it gets cached — so a file you have not touched in a while is exactly
 * the one that goes stale the moment you finally edit it. That failure mode is
 * silent and extremely confusing: the page renders fine, just not your code.
 *
 *   node serve.mjs [port]
 */

import { createServer } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

const ROOT = process.cwd();
const PORT = Number(process.argv[2] ?? 5177);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Where POST /shot drops frames. Outside the served tree on purpose: these are
// scratch images, not part of the game.
const SHOTS = process.env.GOLF_SHOTS ?? join(ROOT, '.shots');

/**
 * Multiplayer relay.
 *
 * Server-Sent Events downstream, plain POSTs upstream. Not WebSockets, and not
 * WebRTC: both would mean either a dependency or a hand-rolled protocol, and a
 * turn-of-the-hole golf match sends a handful of small messages a minute. SSE
 * is built into every browser and into Node's plain http module, so this adds
 * nothing to install and nothing to configure.
 *
 * The server knows nothing about golf. It pairs whoever is waiting and copies
 * bytes between them; every rule lives in the client, where it can be read.
 */
const mp = {
  clients: new Map(),   // id -> { res, name, matchId, seen }
  matches: new Map(),   // matchId -> [idA, idB]
  waiting: [],          // ids queued for an opponent
  seq: 0,
};

// SSE frames are newline-delimited. Built with an explicit character rather
// than escapes so the shape of the wire format is impossible to misread.
const NL = String.fromCharCode(10);

function mpSend(id, event, data) {
  const c = mp.clients.get(id);
  if (!c || !c.res || c.res.writableEnded) return false;
  c.res.write('event: ' + event + NL + 'data: ' + JSON.stringify(data) + NL + NL);
  return true;
}

function mpOpponent(id) {
  const c = mp.clients.get(id);
  if (!c || !c.matchId) return null;
  const pair = mp.matches.get(c.matchId) ?? [];
  return pair.find((x) => x !== id) ?? null;
}

/** Pair anyone queued. Called whenever the queue might have changed. */
function mpPair() {
  while (mp.waiting.length >= 2) {
    const a = mp.waiting.shift();
    const b = mp.waiting.shift();
    const ca = mp.clients.get(a), cb = mp.clients.get(b);
    if (!ca || !ca.res) { if (cb) mp.waiting.unshift(b); continue; }
    if (!cb || !cb.res) { mp.waiting.unshift(a); continue; }
    const matchId = 'm' + (++mp.seq);
    ca.matchId = cb.matchId = matchId;
    mp.matches.set(matchId, [a, b]);
    // Side decides nothing about play; it only breaks ties deterministically.
    mpSend(a, 'matched', { matchId, side: 0, opponent: cb.name });
    mpSend(b, 'matched', { matchId, side: 1, opponent: ca.name });
  }
}

function mpDrop(id) {
  const c = mp.clients.get(id);
  if (!c) return;
  const other = mpOpponent(id);
  if (other) mpSend(other, 'left', {});
  if (c.matchId) mp.matches.delete(c.matchId);
  const q = mp.waiting.indexOf(id);
  if (q >= 0) mp.waiting.splice(q, 1);
  mp.clients.delete(id);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith('/')) path += 'index.html';

    // ---- multiplayer ------------------------------------------------------
    if (path === '/mp/events') {
      const id = 'p' + (++mp.seq) + Math.random().toString(36).slice(2, 7);
      const name = (url.searchParams.get('name') || 'Player').slice(0, 20);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      mp.clients.set(id, { res, name, matchId: null, seen: Date.now() });
      mpSend(id, 'hello', { id });
      // A comment line every 25s so proxies and phones do not idle the socket
      // out mid-match.
      const ping = setInterval(() => {
        if (res.writableEnded) return clearInterval(ping);
        res.write(':ping' + NL + NL);
      }, 25000);
      req.on('close', () => { clearInterval(ping); mpDrop(id); mpPair(); });
      return;
    }

    if (req.method === 'POST' && path === '/mp/queue') {
      const id = url.searchParams.get('id');
      if (mp.clients.has(id) && !mp.waiting.includes(id)) mp.waiting.push(id);
      mpPair();
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      return;
    }

    if (req.method === 'POST' && path === '/mp/say') {
      const id = url.searchParams.get('id');
      const body = await readBody(req);
      const other = mpOpponent(id);
      if (other) mpSend(other, 'msg', JSON.parse(body || '{}'));
      res.writeHead(200, { 'Content-Type': 'application/json' })
         .end(JSON.stringify({ delivered: !!other }));
      return;
    }

    if (req.method === 'POST' && path === '/mp/leave') {
      mpDrop(url.searchParams.get('id'));
      mpPair();
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      return;
    }

    // POST /shot?name=foo — save a frame the page rendered.
    //
    // The browser can render the game perfectly well in a background tab when
    // driven by hand, but there is no way to *see* the result from outside the
    // page. Writing it to disk turns a screenshot into an ordinary file, which
    // anything can open. Local dev server only; it writes one flat filename
    // into one directory and accepts nothing else.
    if (req.method === 'POST' && path === '/shot') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString('utf8');
      const b64 = raw.slice(raw.indexOf(',') + 1);
      const name = (url.searchParams.get('name') ?? 'shot').replace(/[^\w.-]/g, '');
      await mkdir(SHOTS, { recursive: true });
      await writeFile(join(SHOTS, `${name}.jpg`), Buffer.from(b64, 'base64'));
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end(join(SHOTS, `${name}.jpg`));
      return;
    }

    const full = normalize(join(ROOT, path));
    // Refuse anything that escapes the served directory.
    if (full !== ROOT && !full.startsWith(ROOT + sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    const info = await stat(full);
    const file = info.isDirectory() ? join(full, 'index.html') : full;
    const body = await readFile(file);

    res.writeHead(200, {
      'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
  }
}).listen(PORT, () => {
  console.log(`Sunny Links dev server → http://localhost:${PORT}`);
});
