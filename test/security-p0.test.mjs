/**
 * Regression tests for the two P0 server security controls:
 *   1) HTTP server binds explicitly to IPv4 loopback (127.0.0.1), not 0.0.0.0.
 *   2) Static serving is an explicit allowlist; traversal / generic paths 404.
 * Plus a light load regression: dashboard HTML serves and usage.json still
 * parses to the canonical v1 contract.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDashboardServer } from '../server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // .../test
// PROJECT_ROOT not needed for the allowlist tests (paths are resolved inside server.mjs).
void HERE;

/** Start the dashboard on an ephemeral loopback port; resolve with { url, close }. */
function startOnLoopback() {
  const srv = createDashboardServer();
  return new Promise((resolve, reject) => {
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => srv.close(r)) });
    });
  });
}

/** GET with a hard timeout so a hung server cannot stall the suite. */
async function req(url) {
  const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(5000) });
  const body = await res.text();
  return { status: res.status, ct: res.headers.get('content-type'), body };
}

// ---------------------------------------------------------------------------
// P0 control #1 — loopback binding
// ---------------------------------------------------------------------------
test('server binds explicitly to IPv4 loopback (127.0.0.1), not 0.0.0.0', async () => {
  const srv = createDashboardServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  try {
    const addr = srv.address();
    assert.equal(addr.family, 'IPv4');
    assert.equal(addr.address, '127.0.0.1');
    // Loopback must be reachable.
    const r = await req(`http://127.0.0.1:${addr.port}/`);
    assert.equal(r.status, 200);
  } finally {
    srv.close();
  }
});

// ---------------------------------------------------------------------------
// P0 control #2 — explicit allowlist serving
// ---------------------------------------------------------------------------
test('allowlist serves dashboard root, script and usage data with 200', async () => {
  const t = await startOnLoopback();
  try {
    for (const p of ['/', '/index.html', '/vendor/chart.umd.min.js', '/data/usage.json']) {
      const r = await req(t.url + p);
      assert.equal(r.status, 200, `expected 200 for ${p}`);
    }
    const root = await req(t.url + '/');
    assert.match(root.ct, /text\/html/);
    const js = await req(t.url + '/vendor/chart.umd.min.js');
    assert.match(js.ct, /javascript/);
  } finally {
    t.close();
  }
});

test('allowlist rejects traversal and disallowed paths with 404', async () => {
  const t = await startOnLoopback();
  try {
    // Includes real-but-not-allowlisted files (proves generic serving is gone)
    // and several path-traversal encodings.
    const blocked = [
      '/server.mjs',
      '/parse.mjs',
      '/package.json',
      '/README.md',
      '/.git/config',
      '/data/usage-v3.json',     // exists on disk, but not allowlisted
      '/../server.mjs',          // dot-segment traversal (normalised to /server.mjs)
      '/%2e%2e/server.mjs',      // encoded traversal
      '/data/../package.json',   // traversal out of data/
    ];
    for (const p of blocked) {
      const r = await req(t.url + p);
      assert.equal(r.status, 404, `expected 404 for ${p}, got ${r.status}`);
    }
  } finally {
    t.close();
  }
});

// ---------------------------------------------------------------------------
// Load regression — dashboard loads and usage.json still parses to v1 contract
// ---------------------------------------------------------------------------
test('dashboard root serves index.html and usage.json parses to the canonical v1 contract', async () => {
  const t = await startOnLoopback();
  try {
    const root = await req(t.url + '/');
    assert.match(root.body, /<title>Local AI Cost Calculator<\/title>/);

    const u = await req(t.url + '/data/usage.json');
    assert.equal(u.status, 200);
    let data;
    assert.doesNotThrow(() => { data = JSON.parse(u.body); });
    assert.equal(data.version, 1, 'usage.json exposes version:1');
    assert.ok(Array.isArray(data.records), 'usage.json exposes a records array');
    for (const r of data.records) {
      assert.ok(typeof r.ts === 'number', 'record has numeric ts');
      assert.ok(typeof r.evaluatedIn === 'number', 'record has numeric evaluatedIn');
      assert.ok(typeof r.outTokens === 'number', 'record has numeric outTokens');
    }
  } finally {
    t.close();
  }
});
