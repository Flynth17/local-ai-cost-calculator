/**
 * Regression test for the POST /refresh HTTP lifecycle (the heap-OOM bug).
 *
 * Proves that after run.bat gives the server enough heap, a /refresh:
 *   - completes and returns HTTP 200 JSON (no aborted connection / NetworkError);
 *   - leaves the server process alive to serve subsequent requests;
 *   - makes the freshly written usage.json immediately fetchable over HTTP;
 *   - is idempotent: a second refresh against an unchanged corpus adds no records
 *     (no duplication).
 *
 * Faithful layout: we copy server.mjs + its local deps into a temp project and import
 * the COPIED server.mjs, so import.meta.url (HERE) resolves to the temp dir. That makes
 * BOTH the /data/usage.json route and the refresh dataDir point at the temp copy — exactly
 * like production (`createDashboardServer()` with no injection), and without ever touching
 * the real project's data/ directory. A small synthetic corpus keeps parseFiles off the
 * heap limit so this exercises the HTTP contract rather than OOMing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));

/** Two timing blocks (prompt + eval) => one parsed record per call. */
function timingBlocks(task) {
  const base = `[2026-01-01 ${String(task)}:00:00][DEBUG] 0.0 I slot print_timing: id  0 | task ${task} | `;
  return [
    `${base}prompt eval time =   10.00 ms /    5 tokens (1.00 ms per token)`,
    `${base}        eval time =       5.00 ms /    3 tokens (5.00 ms per token)`,
  ];
}

/** Build an isolated temp project copy holding only the modules needed to run the server. */
function buildTempProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-lifecycle-'));
  for (const f of ['server.mjs', 'import.mjs', 'parse.mjs']) {
    fs.copyFileSync(path.join(PROJECT_ROOT, '..', f), path.join(root, f));
  }
  return root;
}

test('POST /refresh completes with HTTP 200 JSON, server stays alive, usage.json is fetchable, and a second refresh does not duplicate records', async () => {
  const root = buildTempProject();
  // collectFiles(src) expects month subdirs under src, so the corpus root is server-logs/
  // and the two seeded logs live under its 2026-01 month directory.
  const corpusDir = path.join(root, 'server-logs');
  const mm = path.join(corpusDir, '2026-01');
  fs.mkdirSync(mm, { recursive: true });
  fs.writeFileSync(path.join(mm, 'aaa.log'), timingBlocks(1).join('\n') + '\n');
  fs.writeFileSync(path.join(mm, 'bbb.log'), timingBlocks(2).join('\n') + '\n');

  // data/ starts with an (empty) usage.json but NO manifest -> first /refresh is a full rebuild.
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'usage.json'), JSON.stringify({
    version: 1, generatedAt: new Date(0).toISOString(), sourceDir: null, recordCount: 0, records: [],
  }));

  // Import the COPIED server so HERE == temp root (route + dataDir both resolve to temp/data).
  const { createDashboardServer } = await import(pathToFileURL(path.join(root, 'server.mjs')).href);
  const srv = createDashboardServer({ corpusDir }); // dataDir defaults to HERE/data (temp copy)
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${srv.address().port}`;

  try {
    // #1 — full rebuild (no manifest present yet): must return HTTP 200 JSON and NOT abort.
    const r1 = await fetch(base + '/refresh', { method: 'POST', signal: AbortSignal.timeout(30_000) });
    const b1 = await r1.json();
    assert.equal(r1.status, 200, '#1 returns HTTP 200');
    assert.equal(b1.ok, true);
    assert.equal(b1.rebuildRequired, true);
    assert.equal(b1.recordsAdded, 2, 'both seeded files parsed');

    // Server must still be alive: usage.json is immediately fetchable over HTTP.
    const uRes = await fetch(base + '/data/usage.json', { signal: AbortSignal.timeout(10_000) });
    assert.equal(uRes.status, 200, 'server alive; /data/usage.json fetchable after refresh');
    const u1 = await uRes.json();
    assert.equal(u1.recordCount, 2);

    // #2 — manifest now exists + corpus unchanged -> idempotent no-op, no duplication.
    const r2 = await fetch(base + '/refresh', { method: 'POST', signal: AbortSignal.timeout(30_000) });
    const b2 = await r2.json();
    assert.equal(r2.status, 200, '#2 returns HTTP 200');
    assert.equal(b2.ok, true);
    assert.equal(b2.rebuildRequired, false);
    assert.equal(b2.recordsAdded, 0, 'no records added on unchanged corpus');

    const u2 = await (await fetch(base + '/data/usage.json', { signal: AbortSignal.timeout(10_000) })).json();
    assert.equal(u2.recordCount, 2, 'record count unchanged after no-op refresh (no duplication)');
  } finally {
    srv.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
