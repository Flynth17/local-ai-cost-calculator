/**
 * Regression tests for the incremental ingestion engine (import.mjs):
 *   - source attribution (records carry corpus-relative `source`)
 *   - manifest behaviour (load/validate, entries, invalid → rebuild)
 *   - unchanged-file skipping (idempotent no-op refresh rewrites nothing)
 *   - new-file ingestion (append without duplication)
 *   - changed-file replacement (safe full-rebuild fallback; equivalent to clean rebuild)
 *   - idempotent repeated refresh (no duplicates, byte-identical output)
 *   - migration / full rebuild from legacy unattributed data
 *   - atomic persistence / error behaviour (no partial writes, failed run leaves state intact)
 *   - incremental == clean full-rebuild equivalence (initial, add, modify, no-change)
 *
 * All tests use isolated temp corpora + data dirs under os.tmpdir(); the real
 * corpus and project data/ are never touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { refresh, loadManifest, loadDataset, hasLegacyRecords, classify, MANIFEST_NAME } from '../import.mjs';
import { collectFiles, parseFiles } from '../parse.mjs';

// ---------------------------------------------------------------------------
// Synthetic corpus helpers — produce log lines the parser understands.
// ---------------------------------------------------------------------------
function pad(n) { return String(n).padStart(2, '0'); }

/** One llama.cpp timing block: a prompt line and/or an eval line for one task. */
function timingBlock(dateStr, h, m, s, task, kind, promptTokens = 10) {
  const base = `[${dateStr} ${h}:${pad(m)}:${pad(s)}][DEBUG] 0.000 I slot print_timing: id  0 | task ${task} | `;
  if (kind === 'prompt') return `${base}prompt eval time =   ${promptTokens}.00 ms /   ${promptTokens} tokens (1.00 ms per token)`;
  return `${base}        eval time =       5.00 ms /     3 tokens (5.00 ms per token)`;
}

/** An [INFO][model] line that sets attribution for subsequent requests in the file. */
function infoLine(model) { return `[2026-09-14 00:00:00][DEBUG] 0.0 I [INFO][${model}] Running chat`; }

/**
 * Build a log file's text from an ordered list of entries. Each entry is either
 *   { model }            -> injects an [INFO][model] line before the requests
 *   { task, prompt, ts }  -> emits a prompt+eval timing block at that instant
 */
function buildLog(entries) {
  const lines = [];
  for (const e of entries) {
    // Emit the model line and any request block independently so an entry may carry
    // both (a request made under a loaded model) — matching real logs.
    if (e.model) lines.push(infoLine(e.model));
    if (e.ts) lines.push(timingBlock('2026-09-14', ...splitTs(e.ts), e.task, 'prompt', e.prompt));
  }
  return lines.join('\n') + '\n';
}

function splitTs(ts) { const d = new Date(ts); return [d.getHours(), d.getMinutes(), d.getSeconds()]; }

/** Create an isolated temp workspace: { corpusDir, dataDir }. Logs live in <YYYY-MM>/<name>.log. */
function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'import-engine-'));
  const corpusDir = path.join(root, 'server-logs');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(corpusDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  return { root, corpusDir, dataDir };
}

/** Write a log file at <corpusDir>/<YYYY-MM>/<name>.log and return its relative path. */
function writeLog(corpusDir, name, text) {
  const mm = '2026-09';
  fs.mkdirSync(path.join(corpusDir, mm), { recursive: true });
  fs.writeFileSync(path.join(corpusDir, mm, `${name}.log`), text);
  return `${mm}/${name}.log`;
}

function readDataset(dataDir) { return JSON.parse(fs.readFileSync(path.join(dataDir, 'usage.json'), 'utf8')); }

/** Semantic record comparison: order-independent (sort by composite key). */
function recordsEqual(a, b) {
  const key = r => `${r.ts}|${r.model ?? 'null'}|${r.evaluatedIn}|${r.outTokens}|${r.source}`;
  const sort = arr => [...arr].sort((x, y) => key(x).localeCompare(key(y)));
  assert.equal(a.length, b.length, `record count ${a.length} vs ${b.length}`);
  const sa = sort(a), sb = sort(b);
  for (let i = 0; i < sa.length; i++) assert.deepEqual(sa[i], sb[i], `record ${i} differs`);
}

// ---------------------------------------------------------------------------
// Source attribution
// ---------------------------------------------------------------------------
test('records carry corpus-relative source attribution', async () => {
  const { corpusDir, dataDir } = makeWorkspace();
  writeLog(corpusDir, 'aaa', buildLog([{ model: 'm/a', ts: Date.UTC(2026, 8, 13, 10, 0, 0), task: 1, prompt: 100 }]));
  const status = await refresh({ src: corpusDir, dataDir });
  assert.equal(status.rebuildRequired, true); // first import with no manifest => full rebuild
  const recs = readDataset(dataDir).records;
  assert.equal(recs.length, 1);
  assert.equal(recs[0].source, '2026-09/aaa.log');
  assert.ok(typeof recs[0].evaluatedIn === 'number' && typeof recs[0].outTokens === 'number');
});

// ---------------------------------------------------------------------------
// Manifest behaviour
// ---------------------------------------------------------------------------
test('manifest records size/mtime/lastImportedAt per source', async () => {
  const { corpusDir, dataDir } = makeWorkspace();
  writeLog(corpusDir, 'aaa', buildLog([{ model: 'm/a', ts: Date.UTC(2026, 8, 13, 10, 0, 0), task: 1, prompt: 10 }]));
  await refresh({ src: corpusDir, dataDir });
  const manifest = loadManifest(dataDir);
  assert.ok(manifest, 'manifest loads');
  assert.equal(manifest.version, 1);
  const entry = manifest.files['2026-09/aaa.log'];
  assert.ok(entry, 'entry exists for the source');
  assert.equal(typeof entry.size, 'number');
  assert.equal(typeof entry.mtimeMs, 'number');
  assert.ok(typeof entry.lastImportedAt === 'string' && entry.lastImportedAt.endsWith('Z'));
});

test('invalid/corrupt manifest triggers a full rebuild (never trusts an unusable index)', async () => {
  const { corpusDir, dataDir } = makeWorkspace();
  writeLog(corpusDir, 'aaa', buildLog([{ model: 'm/a', ts: Date.UTC(2026, 8, 13, 10, 0, 0), task: 1, prompt: 10 }]));
  // Write a corrupt manifest so loadManifest returns null.
  fs.writeFileSync(path.join(dataDir, MANIFEST_NAME), '{ this is not json ');
  const status = await refresh({ src: corpusDir, dataDir });
  assert.equal(status.rebuildRequired, true);
  const recs = readDataset(dataDir).records;
  assert.equal(recs.length, 1);
  assert.equal(recs[0].source, '2026-09/aaa.log');
  // A valid manifest now exists.
  assert.ok(loadManifest(dataDir));
});

// ---------------------------------------------------------------------------
// Unchanged-file skipping + idempotency
// ---------------------------------------------------------------------------
test('unchanged corpus: second refresh is an idempotent no-op that rewrites nothing', async () => {
  const { corpusDir, dataDir } = makeWorkspace();
  writeLog(corpusDir, 'aaa', buildLog([{ model: 'm/a', ts: Date.UTC(2026, 8, 13, 10, 0, 0), task: 1, prompt: 10 }]));
  const first = await refresh({ src: corpusDir, dataDir });
  assert.equal(first.newSources, 1);

  const before = fs.statSync(path.join(dataDir, 'usage.json'));
  const second = await refresh({ src: corpusDir, dataDir }); // no filesystem changes
  assert.equal(second.rebuildRequired, false);
  assert.equal(second.newSources, 0);
  assert.equal(second.parsedFiles, 0);
  assert.equal(second.recordsAdded, 0);
  const after = fs.statSync(path.join(dataDir, 'usage.json'));
  assert.equal(before.mtimeMs, after.mtimeMs, 'usage.json not rewritten on a no-op refresh');
  // No duplicate records.
  assert.equal(readDataset(dataDir).records.length, 1);
});

// ---------------------------------------------------------------------------
// New-file ingestion
// ---------------------------------------------------------------------------
test('new file is imported without duplicating existing records', async () => {
  const { corpusDir, dataDir } = makeWorkspace();
  writeLog(corpusDir, 'aaa', buildLog([{ model: 'm/a', ts: Date.UTC(2026, 8, 13, 10, 0, 0), task: 1, prompt: 10 }]));
  await refresh({ src: corpusDir, dataDir });

  writeLog(corpusDir, 'bbb', buildLog([{ model: 'm/b', ts: Date.UTC(2026, 8, 14, 9, 0, 0), task: 1, prompt: 20 }]));
  const status = await refresh({ src: corpusDir, dataDir });
  assert.equal(status.newSources, 1);
  assert.equal(status.recordsAdded, 1);
  const recs = readDataset(dataDir).records;
  assert.equal(recs.length, 2); // exactly one new record appended, no duplication
  assert.ok(recs.some(r => r.source === '2026-09/aaa.log'));
  assert.ok(recs.some(r => r.source === '2026-09/bbb.log'));
});

// ---------------------------------------------------------------------------
// Changed-file replacement (safe full-rebuild fallback)
// ---------------------------------------------------------------------------
test('changed file is replaced via a clean rebuild with no duplication', async () => {
  const { corpusDir, dataDir } = makeWorkspace();
  writeLog(corpusDir, 'aaa', buildLog([{ model: 'm/a', ts: Date.UTC(2026, 8, 13, 10, 0, 0), task: 1, prompt: 10 }]));
  await refresh({ src: corpusDir, dataDir });

  // Modify aaa (different token counts => different records).
  writeLog(corpusDir, 'aaa', buildLog([{ model: 'm/a', ts: Date.UTC(2026, 8, 13, 10, 0, 0), task: 1, prompt: 999 }]));
  const status = await refresh({ src: corpusDir, dataDir });
  assert.equal(status.changedSources, 1);
  assert.equal(status.rebuildRequired, true); // changed source => safe rebuild
  const recs = readDataset(dataDir).records;
  assert.equal(recs.length, 1); // replaced, not duplicated
  assert.equal(recs[0].evaluatedIn, 999); // reflects the modified file
});

// ---------------------------------------------------------------------------
// Migration / full rebuild from legacy unattributed data
// ---------------------------------------------------------------------------
test('legacy unattributed usage.json triggers a full rebuild that attributes every record', async () => {
  const { corpusDir, dataDir } = makeWorkspace();
  writeLog(corpusDir, 'aaa', buildLog([{ model: 'm/a', ts: Date.UTC(2026, 8, 13, 10, 0, 0), task: 1, prompt: 10 }]));

  // Seed a legacy dataset with NO source attribution and no manifest.
  fs.writeFileSync(path.join(dataDir, 'usage.json'), JSON.stringify({
    version: 1, generatedAt: new Date().toISOString(), sourceDir: corpusDir, recordCount: 1,
    records: [{ ts: Date.UTC(2026, 8, 13, 10, 0, 0), model: 'm/a', evaluatedIn: 10, outTokens: 3 }],
  }));
  assert.ok(hasLegacyRecords(readDataset(dataDir)), 'helper detects legacy records');

  const status = await refresh({ src: corpusDir, dataDir });
  assert.equal(status.rebuildRequired, true); // migration => full rebuild
  const recs = readDataset(dataDir).records;
  assert.equal(recs.length, 1);
  assert.ok(recs.every(r => typeof r.source === 'string' && r.source.length > 0), 'all records now attributed');
  assert.equal(recs[0].source, '2026-09/aaa.log');
});

test('valid manifest + empty records is a fresh start (append the first real import)', async () => {
  const { corpusDir, dataDir } = makeWorkspace();
  writeLog(corpusDir, 'aaa', buildLog([{ model: 'm/a', ts: Date.UTC(2026, 8, 13, 10, 0, 0), task: 1, prompt: 10 }]));
  // Valid manifest + empty records => not legacy; first real import appends.
  fs.writeFileSync(path.join(dataDir, MANIFEST_NAME), JSON.stringify({ version: 1, lastModel: null, files: {} }));
  fs.writeFileSync(path.join(dataDir, 'usage.json'), JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), sourceDir: corpusDir, recordCount: 0, records: [] }));
  const status = await refresh({ src: corpusDir, dataDir });
  assert.equal(status.rebuildRequired, false); // manifest valid, no legacy records
  assert.equal(status.newSources, 1);
  assert.equal(readDataset(dataDir).records.length, 1);
});

// ---------------------------------------------------------------------------
// Atomic persistence / error behaviour
// ---------------------------------------------------------------------------
test('successful refresh leaves no partial/temp files and a valid dataset', async () => {
  const { corpusDir, dataDir } = makeWorkspace();
  writeLog(corpusDir, 'aaa', buildLog([{ model: 'm/a', ts: Date.UTC(2026, 8, 13, 10, 0, 0), task: 1, prompt: 10 }]));
  await refresh({ src: corpusDir, dataDir });
  const entries = fs.readdirSync(dataDir);
  assert.ok(!entries.some(e => e.includes('.tmp')), `no temp files left behind: ${entries.join(',')}`);
  // Dataset is a valid v1 contract with attributed records.
  const d = loadDataset(dataDir);
  assert.equal(d.version, 1);
  assert.ok(Array.isArray(d.records));
});

test('a failed refresh (missing corpus) rejects and writes nothing', async () => {
  const { dataDir } = makeWorkspace();
  await assert.rejects(refresh({ src: path.join(dataDir, 'does-not-exist'), dataDir }));
  // Nothing was written for the failed run.
  assert.equal(fs.existsSync(path.join(dataDir, 'usage.json')), false);
});

test('concurrent refresh calls share a single in-flight operation', async () => {
  const { corpusDir, dataDir } = makeWorkspace();
  writeLog(corpusDir, 'aaa', buildLog([{ model: 'm/a', ts: Date.UTC(2026, 8, 13, 10, 0, 0), task: 1, prompt: 10 }]));
  const p1 = refresh({ src: corpusDir, dataDir });
  const p2 = refresh({ src: corpusDir, dataDir });
  assert.equal(p1, p2, 'second call reuses the running operation');
  const status = await p1;
  assert.equal(status.newSources, 1);
});

// ---------------------------------------------------------------------------
// Incremental == clean full-rebuild equivalence
// ---------------------------------------------------------------------------
test('equivalence: incremental result equals a clean full rebuild (initial / add / modify / no-change)', async () => {
  const base = makeWorkspace();
  const { corpusDir, dataDir } = base;

  // ---- scenario A — initial import: incremental-from-empty vs clean rebuild ----
  writeLog(corpusDir, 'aaa', buildLog([{ model: 'm/a', ts: Date.UTC(2026, 8, 13, 10, 0, 0), task: 1, prompt: 100 }]));
  const initial = await refresh({ src: corpusDir, dataDir }); // no manifest => rebuild
  assert.equal(initial.rebuildRequired, true);
  {
    const all = collectFiles(corpusDir);
    const { records } = parseFiles(all, { src: corpusDir });
    const clean = { version: 1, generatedAt: new Date().toISOString(), sourceDir: corpusDir, recordCount: records.length, records };
    recordsEqual(readDataset(dataDir).records, clean.records);
  }

  // ---- scenario B — add a new file: incremental append vs clean rebuild ----
  writeLog(corpusDir, 'bbb', buildLog([{ model: 'm/b', ts: Date.UTC(2026, 8, 14, 9, 0, 0), task: 1, prompt: 250 }]));
  const added = await refresh({ src: corpusDir, dataDir }); // append bbb
  assert.equal(added.newSources, 1);
  {
    const all = collectFiles(corpusDir);
    const { records } = parseFiles(all, { src: corpusDir });
    const clean = { version: 1, generatedAt: new Date().toISOString(), sourceDir: corpusDir, recordCount: records.length, records };
    recordsEqual(readDataset(dataDir).records, clean.records);
  }

  // ---- scenario C — modify an existing file: rebuild vs clean rebuild ----
  writeLog(corpusDir, 'aaa', buildLog([{ model: 'm/a', ts: Date.UTC(2026, 8, 13, 10, 0, 0), task: 1, prompt: 777 }]));
  const modified = await refresh({ src: corpusDir, dataDir }); // changed => rebuild
  assert.equal(modified.changedSources, 1);
  {
    const all = collectFiles(corpusDir);
    const { records } = parseFiles(all, { src: corpusDir });
    const clean = { version: 1, generatedAt: new Date().toISOString(), sourceDir: corpusDir, recordCount: records.length, records };
    recordsEqual(readDataset(dataDir).records, clean.records);
    assert.equal(readDataset(dataDir).records[0].evaluatedIn, 777);
  }

  // ---- scenario D — refresh with no filesystem changes is a stable no-op ----
  const before = fs.readFileSync(path.join(dataDir, 'usage.json'));
  await refresh({ src: corpusDir, dataDir }); // no changes
  const after = fs.readFileSync(path.join(dataDir, 'usage.json'));
  assert.deepEqual(after, before, 'byte-identical usage.json on a no-op refresh');
});

// ---------------------------------------------------------------------------
// Model-attribution carryover across files (the reason the manifest seeds lastModel)
// ---------------------------------------------------------------------------
test('new-file import carries the previous tail model so boundary requests match a full rebuild', async () => {
  const { corpusDir, dataDir } = makeWorkspace();
  // aaa loads m/carry and ends with it still loaded; bbb starts WITHOUT an [INFO] line.
  writeLog(corpusDir, 'aaa', buildLog([
    { model: 'm/carry' },
    { ts: Date.UTC(2026, 8, 13, 10, 0, 0), task: 1, prompt: 100 },
  ]));
  await refresh({ src: corpusDir, dataDir }); // imports aaa; manifest.lastModel = 'm/carry'

  writeLog(corpusDir, 'bbb', buildLog([
    { ts: Date.UTC(2026, 8, 14, 9, 0, 0), task: 1, prompt: 200 }, // no [INFO] before it -> carryover
  ]));
  await refresh({ src: corpusDir, dataDir }); // append bbb seeded with lastModel

  const inc = readDataset(dataDir).records.find(r => r.source === '2026-09/bbb.log');
  assert.ok(inc, 'bbb record present after incremental import');
  assert.equal(inc.model, 'm/carry', 'boundary request inherits the tail model from the prior file');

  // A clean full rebuild must agree.
  const all = collectFiles(corpusDir);
  const { records: clean } = parseFiles(all, { src: corpusDir });
  const fullBbb = clean.find(r => r.source === '2026-09/bbb.log');
  assert.equal(fullBbb.model, 'm/carry');
  recordsEqual([inc], [fullBbb]);
});

// ---------------------------------------------------------------------------
// classify() unit check
// ---------------------------------------------------------------------------
test('classify separates new / changed / unchanged / missing sources', async () => {
  const { corpusDir, dataDir } = makeWorkspace();
  const relA = writeLog(corpusDir, 'aaa', buildLog([{ model: 'm/a', ts: Date.UTC(2026, 8, 13, 10, 0, 0), task: 1, prompt: 10 }]));
  writeLog(corpusDir, 'bbb', buildLog([{ model: 'm/b', ts: Date.UTC(2026, 8, 14, 9, 0, 0), task: 1, prompt: 10 }]));
  await refresh({ src: corpusDir, dataDir });

  const manifest = loadManifest(dataDir);
  const cls = classify(collectFiles(corpusDir), manifest, corpusDir);
  assert.deepEqual(cls.newRel.sort(), []);
  assert.deepEqual(cls.changedRel.sort(), []);
  assert.equal(cls.unchangedRel.length, 2);

  // Modify aaa -> it becomes "changed".
  writeLog(corpusDir, 'aaa', buildLog([{ model: 'm/a', ts: Date.UTC(2026, 8, 13, 10, 0, 0), task: 1, prompt: 99 }]));
  const cls2 = classify(collectFiles(corpusDir), loadManifest(dataDir), corpusDir);
  assert.deepEqual(cls2.changedRel.sort(), [relA]);
});
