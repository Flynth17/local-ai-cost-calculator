#!/usr/bin/env node
/**
 * server.mjs — zero-dependency static server for the dashboard.
 * Usage:  node server.mjs [port]     (default 8787)
 *
 * Security model (loopback + explicit allowlist):
 *   - The socket is bound explicitly to the IPv4 loopback address (127.0.0.1),
 *     never to 0.0.0.0, so the dashboard is reachable only from this machine.
 *   - Only an explicit allowlist of files may be served. Request paths are mapped
 *     directly to a fixed set of safe absolute files; there is NO
 *     repository-directory traversal, so anything not on the list (including
 *     path-traversal attempts such as ../ or %2e%2e) is rejected with 404.
 *   - The ingestion API (/refresh, /rebuild) is loopback-only like everything else,
 *     accepts POST only, and resolves its corpus + data directories entirely
 *     server-side (getCorpusDir() + HERE/data). It never reads a client-supplied
 *     path and performs no command execution; responses contain counts only — no
 *     absolute filesystem paths.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { refresh, getCorpusDir } from './import.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || process.env.PORT || 8787);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Explicit allowlist of the only resources the dashboard requires. Each entry
// maps a request path to a fixed absolute file under HERE — no string-prefix or
// directory-traversal guard is needed, because nothing outside this map can be
// resolved. Traversal sequences (%2e%2e, ../) never match and are 404'd.
const ROUTES = {
  '/':                        path.join(HERE, 'index.html'),
  '/index.html':              path.join(HERE, 'index.html'),
  '/vendor/chart.umd.min.js': path.join(HERE, 'vendor', 'chart.umd.min.js'),
  '/data/usage.json':         path.join(HERE, 'data', 'usage.json'),
};

// Where usage.json + the import manifest live: the project's data/ dir — the same
// location the dashboard reads via /data/usage.json. Never derived from client input.
const DATA_DIR = path.join(HERE, 'data');

export function createDashboardServer({ corpusDir = getCorpusDir(), dataDir = DATA_DIR } = {}) {
  // Fixed internal locations for production. Tests may inject temp dirs to avoid
  // touching the real corpus/data; client input never reaches these values.
  return http.createServer((req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

      // Normalise a trailing-slash path (never serve directory listings).
      let key = url.pathname;
      if (key.length > 1 && key.endsWith('/')) key = key.replace(/\/+$/, '');

      // Ingestion API — loopback-only, POST only, fixed internal corpus location.
      // Resolved entirely server-side; no client-supplied paths, no command exec.
      if (key === '/refresh' || key === '/rebuild') {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ error: 'method not allowed; use POST' }));
        }
        handleRefresh(res, key === '/rebuild', corpusDir, dataDir);
        return;
      }

      const file = ROUTES[key];
      if (!file) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('not found: ' + key);
      }

      fs.readFile(file, (err, buf) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('server error');
        }
        const ext = path.extname(file).toLowerCase();
        res.writeHead(200, {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
        });
        res.end(buf);
      });
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(String(e));
    }
  });
}

// ---------------------------------------------------------------------------
// Ingestion API helpers (loopback-only; see security model above)
// ---------------------------------------------------------------------------
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// Concise, path-free summary of a refresh result for the UI.
function summarize(s) {
  if (s.rebuildRequired) return `Full rebuild complete — ${s.recordsAdded.toLocaleString()} records across ${s.newSources} source(s).`;
  if (s.newSources > 0) return `${s.newSources} new, ${s.changedSources} updated, ${s.unchangedSources} unchanged · ${s.recordsAdded.toLocaleString()} imported.`;
  if (s.changedSources > 0) return `Rebuilt after ${s.changedSources} changed source(s).`;
  if (s.missingSources > 0) return `${s.unchangedSources} unchanged, ${s.missingSources} source(s) missing on disk.`;
  return `Up to date — no changes (${s.unchangedSources} sources unchanged).`;
}

// POST /refresh: inspect the corpus for changes since the persisted manifest and
// process only what is necessary (idempotent). POST /rebuild: force a full rebuild.
// The corpus + data directories are fixed server-side; concurrent callers share one
// in-flight operation (see import.mjs).
function handleRefresh(res, forceRebuild, corpusDir, dataDir) {
  refresh({ src: corpusDir, dataDir, forceRebuild })
    .then((s) => sendJson(res, 200, {
      ok: true, rebuildRequired: s.rebuildRequired, newSources: s.newSources,
      changedSources: s.changedSources, unchangedSources: s.unchangedSources,
      missingSources: s.missingSources, recordsAdded: s.recordsAdded,
      recordsReplaced: s.recordsReplaced, parsedFiles: s.parsedFiles, message: summarize(s),
    }))
    .catch((err) => {
      // Never leak absolute filesystem paths to the browser.
      console.error('refresh failed:', err);
      sendJson(res, 500, { ok: false, error: 'refresh failed' });
    });
}

const server = createDashboardServer();

// Auto-listen only when run directly as a script (not when imported by tests).
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  // Bind explicitly to IPv4 loopback so the dashboard is reachable only locally,
  // never on a LAN/external interface. Fail clearly if binding fails.
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`LM Studio token dashboard: http://localhost:${PORT}`);
    console.log(`Listening on 127.0.0.1:${PORT} (${HERE})`);
  });
  server.on('error', (err) => {
    console.error(`server listen error: ${err.message}`);
    process.exit(1);
  });
}
