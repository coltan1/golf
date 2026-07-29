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
