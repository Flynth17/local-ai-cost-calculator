#!/usr/bin/env node
/**
 * server.mjs — zero-dependency static server for the dashboard.
 * Usage:  node server.mjs [port]     (default 8787)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || process.env.PORT || 8787);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
    const file = path.normalize(path.join(HERE, '.' + p));
    if (!file.startsWith(HERE)) { res.writeHead(403); return res.end('forbidden'); }

    fs.stat(file, (err, st) => {
      let target = file;
      if (!err && st.isDirectory()) target = path.join(file, 'index.html');
      fs.readFile(target, (err2, buf) => {
        if (err2) { res.writeHead(404); return res.end('not found: ' + p); }
        const ext = path.extname(target).toLowerCase();
        res.writeHead(200, {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
        });
        res.end(buf);
      });
    });
  } catch (e) {
    res.writeHead(500); res.end(String(e));
  }
});

server.listen(PORT, () => {
  console.log(`LM Studio token dashboard: http://localhost:${PORT}`);
  console.log(`Serving ${HERE}`);
});
