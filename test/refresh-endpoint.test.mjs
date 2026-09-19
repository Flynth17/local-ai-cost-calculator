/**
 * Regression tests for the ingestion API (POST /refresh, POST /rebuild) added to
 * server.mjs. Verifies the security boundaries of the endpoint:
 *   - loopback-only server (inherited from the dashboard server);
 *   - POST only; other methods 405;
 *   - fixed internal corpus + data locations — no client-supplied path is honored,
 *     so query strings / traversal attempts cannot redirect the corpus or leak files;
 *   - responses are structured and contain NO absolute filesystem paths.
 *
 * Each test runs against an ISOLATED temp corpus + data dir injected via
 * createDashboardServer({ corpusDir, dataDir }), so the real corpus/project data/
 * is never touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDashboardServer } from '../server.mjs';

const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));

function pad(n) { return String(n).padStart(2, '0'); }
function timingBlock(dateStr, h, m, s, task, kind, p = 10) {
  const base = `[${dateStr} ${h}:${pad(m)}:${pad(s)}][DEBUG] 0.0 I slot print_timing: id  0 | task ${task} | `;
  return kind === 'prompt'
    ? `${base}prompt eval time =   ${p}.00 ms /   ${p} tokens (1.00 ms per token)`
    : `${base}        eval time =       5.00 ms /     3 tokens (5.00 ms per token)`;
}
function buildLog(entries) {
  const lines = [];
  for (const e of entries) {
    if (e.model) lines.push(`[2026-09-14 00:00:00][DEBUG] 0.0 I [INFO][${e.model}] Running chat`);
    if (e.ts) { const d = new Date(e.ts); lines.push(timingBlock('2026-09-14', d.getHours(), d.getMinutes(), d.getSeconds(), e.task, 'prompt', e.prompt)); }
  }
  return lines.join('\n') + '\n';
}

function makeCorpus() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'endpoint-'));
  const corpusDir = path.join(root, 'server-logs');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(corpusDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  return { root, corpusDir, dataDir };
}

/** Seed a couple of synthetic log files and return their relative paths. */
function seedLogs(corpusDir) {
  const mm = '2026-09';
  fs.mkdirSync(path.join(corpusDir, mm), { recursive: true });
  const write = (name, text) => { fs.writeFileSync(path.join(corpusDir, mm, `${name}.log`), text); return `${mm}/${name}.log`; };
  write('aaa', buildLog([{ model: 'm/a', ts: Date.UTC(2026, 8, 13, 10, 0, 0), task: 1, prompt: 100 }]));
  write('bbb', buildLog([{ model: 'm/b', ts: Date.UTC(2026, 8, 14, 9, 0, 0), task: 1, prompt: 200 }]));
  return [`${mm}/aaa.log`, `${mm}/bbb.log`];
}

async function startServer(corpusDir, dataDir) {
  const srv = createDashboardServer({ corpusDir, dataDir });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = srv.address().port;
  return { srv, url: `http://127.0.0.1:${port}` };
}

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(8000), ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, ct: res.headers.get('content-type'), text, json };
}

async function methodReq(url, method) {
  const res = await fetch(url, { method, signal: AbortSignal.timeout(5000) });
  return { status: res.status, ct: res.headers.get('content-type'), body: await res.text() };
}

test('POST /refresh returns structured status with no absolute filesystem paths', async () => {
  const ws = makeCorpus();
  seedLogs(ws.corpusDir);
  const { srv, url } = await startServer(ws.corpusDir, ws.dataDir);
  try {
    const r = await post(url + '/refresh');
    assert.equal(r.status, 200);
    assert.match(r.ct, /application\/json/);
    assert.ok(r.json && typeof r.json.ok === 'boolean', 'JSON body with ok field');
    assert.equal(r.json.rebuildRequired, true); // first import (no manifest) => full rebuild
    assert.equal(r.json.newSources, 2);         // both seeded logs are new
    assert.equal(r.json.recordsAdded, 2);
    assert.ok(typeof r.json.message === 'string' && r.json.message.length > 0);

    // No absolute host paths anywhere in the response (only counts + a message).
    const leaky = [process.env.HOME, process.env.USERPROFILE, ws.corpusDir].filter(Boolean);
    for (const needle of leaky) {
      if (!needle) continue;
      assert.ok(!r.text.includes(needle), `response leaked absolute path: ${needle}`);
      assert.ok(!r.text.includes('\\'), 'response contains no backslash paths');
    }

    // The isolated data dir now holds usage.json + manifest, attributed records.
    const usage = JSON.parse(fs.readFileSync(path.join(ws.dataDir, 'usage.json'), 'utf8'));
    assert.equal(usage.version, 1);
    assert.ok(usage.records.every((x) => typeof x.source === 'string' && x.source.length > 0));
  } finally { srv.close(); }
});

test('non-POST methods on API paths are rejected with 405', async () => {
  const ws = makeCorpus();
  seedLogs(ws.corpusDir);
  const { srv, url } = await startServer(ws.corpusDir, ws.dataDir);
  try {
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
      for (const p of ['/refresh', '/rebuild']) {
        const r = await methodReq(url + p, method);
        assert.equal(r.status, 405, `${method} ${p} -> 405`);
        assert.match(r.ct, /application\/json/, `${method} ${p} returns JSON content-type`);
      }
    }
  } finally { srv.close(); }
});

test('query strings do not redirect the corpus or leak files', async () => {
  const ws = makeCorpus();
  seedLogs(ws.corpusDir);
  const { srv, url } = await startServer(ws.corpusDir, ws.dataDir);
  try {
    // A traversal-y query string must be ignored: the endpoint resolves its corpus
    // server-side and returns JSON status, never file contents.
    const r = await post(url + '/refresh?foo=../../etc/passwd&x=../..');
    assert.equal(r.status, 200);
    assert.ok(r.json && typeof r.json.ok === 'boolean', 'still a structured JSON response');
    assert.ok(!r.text.includes('root:') && !r.text.includes('passwd'), 'no /etc/passwd contents leaked');
    // The corpus was processed from its fixed location, not the query string.
    assert.equal(r.json.newSources, 2);
  } finally { srv.close(); }
});

test('POST /rebuild forces a full rebuild', async () => {
  const ws = makeCorpus();
  seedLogs(ws.corpusDir);
  const { srv, url } = await startServer(ws.corpusDir, ws.dataDir);
  try {
    // First an incremental import.
    const first = await post(url + '/refresh');
    assert.equal(first.json.newSources, 2);
    // Then an explicit rebuild.
    const second = await post(url + '/rebuild');
    assert.equal(second.status, 200);
    assert.equal(second.json.rebuildRequired, true);
    assert.equal(second.json.recordsAdded, 2);
    // No duplication after a rebuild.
    const usage = JSON.parse(fs.readFileSync(path.join(ws.dataDir, 'usage.json'), 'utf8'));
    assert.equal(usage.records.length, 2);
  } finally { srv.close(); }
});

test('dashboard root still serves index.html and /data/usage.json (unchanged allowlist)', async () => {
  const ws = makeCorpus();
  seedLogs(ws.corpusDir);
  // Serve from a copy of the project so /index.html + /vendor resolve.
  const projRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  for (const f of ['server.mjs', 'import.mjs', 'parse.mjs']) fs.copyFileSync(path.join(PROJECT_ROOT, '..', f), path.join(projRoot, f));
  fs.mkdirSync(path.join(projRoot, 'vendor'), { recursive: true });
  fs.copyFileSync(path.join(PROJECT_ROOT, '..', 'vendor', 'chart.umd.min.js'), path.join(projRoot, 'vendor', 'chart.umd.min.js'));
  fs.copyFileSync(path.join(PROJECT_ROOT, '..', 'index.html'), path.join(projRoot, 'index.html'));

  const HERE = projRoot; // not used by the server (paths resolve via import.meta)
  void HERE;
  const corpusDir = path.join(ws.corpusDir);
  const dataDir = path.join(ws.dataDir);
  const { srv, url } = await startServer(corpusDir, dataDir);
  try {
    const root = await fetch(url + '/', { signal: AbortSignal.timeout(5000) });
    assert.equal(root.status, 200);
    const html = await root.text();
    assert.match(html, /<title>Local AI Cost Calculator<\/title>/);
    assert.match(html, /id="refreshBtn"/, 'dashboard exposes a Refresh control');

    const usage = await fetch(url + '/data/usage.json', { signal: AbortSignal.timeout(5000) });
    assert.equal(usage.status, 200);
    const data = JSON.parse(await usage.text());
    assert.equal(data.version, 1);
    assert.ok(Array.isArray(data.records));
  } finally { srv.close(); }
});
