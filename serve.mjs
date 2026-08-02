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
import { networkInterfaces } from 'node:os';

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

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith('/')) path += 'index.html';

    // POST /shot?name=foo — save a frame the page rendered.
    //
    // The browser can render the game perfectly well in a background tab when
    // driven by hand, but there is no way to *see* the result from outside the
    // page. Writing it to disk turns a screenshot into an ordinary file, which
    // anything can open. Local dev server only; it writes one flat filename
    // into one directory and accepts nothing else.
    if (req.method === 'POST' && path === '/shot') {
      // Loopback only. This writes files to disk, and while the name is
      // sanitised to one flat filename in one directory, a write endpoint has
      // no business answering anyone but this machine.
      const from = req.socket.remoteAddress ?? '';
      if (!/^(::1|::ffff:127\.|127\.)/.test(from)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' }).end('local only');
        return;
      }
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
}).listen(PORT, '0.0.0.0', () => {
  // Print every address this is actually reachable on, not just localhost.
  //
  // "localhost" is the one address that cannot work from another device — it
  // means "this machine", so a phone typing it is asking itself for the game.
  // Printing only that is a good way to make a working server look broken, so
  // the LAN addresses go up front and are the ones to hand round for a match.
  const lan = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) lan.push(a.address);
    }
  }
  console.log('');
  console.log('  Sunny Links');
  console.log(`  this machine   http://localhost:${PORT}`);
  for (const ip of lan) console.log(`  same wifi      http://${ip}:${PORT}`);
  console.log('');
  console.log('  This server is only for playing on this machine. Online matches do');
  console.log('  not go through it at all — the game finds opponents through a public');
  console.log('  broker, so a 1v1 works from any static host and needs nothing');
  console.log('  running here. See HOSTING.md.');
  console.log('');
});
