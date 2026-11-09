#!/usr/bin/env node
// tools/preview.mjs — full-fidelity local preview: the REAL /api handlers
// (worker/src/api-router.js) over a seeded local SQLite DB (tests/_local-d1),
// plus the SPA from app/. Unlike tools/serve.py (read-only), every mutation
// works here — the whole app can be exercised end to end, including the
// automatic default-admin sign-in and the first-run database setup.
//
//   node tools/preview.mjs [port]     (default 8788, binds 0.0.0.0)

import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi } from '../worker/src/api-router.js';
import { openLocalD1 } from '../tests/_local-d1.js';
import { makeEnv } from '../tests/_harness.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'app');
const PORT = Number(process.argv[2] || process.env.PORT || 8788);

const env = makeEnv(openLocalD1(':memory:', { seed: true }));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.normalize(path.join(APP, p));
  if (!file.startsWith(APP)) { res.writeHead(404); res.end('not found'); return; }
  let target = file;
  let status = 200;
  if (!existsSync(target) || statSync(target).isDirectory()) {
    target = path.join(APP, '404.html');
    status = 404;
  }
  res.writeHead(status, { 'content-type': TYPES[path.extname(target)] || 'application/octet-stream' });
  res.end(readFileSync(target));
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/api/')) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const request = new Request(`http://${req.headers.host || 'localhost'}${req.url}`, {
        method: req.method,
        headers: req.headers,
        body: hasBody ? Buffer.concat(chunks) : undefined,
      });
      const out = await handleApi(request, env);
      res.writeHead(out.status, Object.fromEntries(out.headers));
      res.end(Buffer.from(await out.arrayBuffer()));
      return;
    }
    serveStatic(req, res);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: String((e && e.message) || e) }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`preview: real API + seeded SPA on http://0.0.0.0:${PORT}`);
});
