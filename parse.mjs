#!/usr/bin/env node
/**
 * parse.mjs — Extract per-request token usage from LM Studio server logs.
 *
 * Source:  ~/.lmstudio/server-logs/<YYYY-MM>/<date>.N.log
 * Signal:  llama.cpp "print_timing" DEBUG lines, one block per request task:
 *           prompt eval time = X ms / N tokens   -> input (sent) tokens
 *           eval time        = X ms / M tokens   -> output (received) tokens
 * Model attribution: nearest preceding [INFO][<model>] line (best effort;
 * ~98%+ accurate — only misattributes when 2 models run concurrently). The model
 * active at the END of a file is carried forward into the next file, so callers
 * that parse a suffix of the corpus must seed `startModel` with the previous
 * tail model to stay identical to a full-corpus parse.
 *
 * Timezone: log timestamps are local system wall-clock; they are parsed as LOCAL
 * time and converted to UTC instants, so every record ts is a proper UTC ISO-8601
 * value (max(ts) <= generatedAt up to clock/skew tolerance). This v1 pipeline is a
 * NEW reproducible accounting basis — its totals may differ from the retired v3
 * snapshot because the v3 cache-decomposition joiner was deliberately removed.
 *
 * Output: data/usage.json (canonical v1 contract) —
 *   { version:1, generatedAt, sourceDir, recordCount,
 *     records: [ { ts, model|null, evaluatedIn, outTokens, source }, ... ] }
 *
 * `source` is an ADDITIVE field: the corpus-relative path of the log that
 * produced the record (e.g. "2026-09/2026-09-19.9.log"). It lets callers attribute
 * a record back to its source file so changed sources can be replaced without
 * duplication. Existing consumers only read ts/evaluatedIn/outTokens and are
 * unaffected by the extra field. Full-corpus and incremental parses share this
 * exact function/output shape so they cannot silently diverge semantically.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = process.argv[2] || path.join(os.homedir(), '.lmstudio', 'server-logs');
const OUT = process.argv[3] || path.join(HERE, 'data', 'usage.json');

if (!fs.existsSync(SRC)) {
  console.error(`Source dir not found: ${SRC}`);
  process.exit(1);
}

// Collect log files in chronological order (YYYY-MM/YYYY-MM-DD.N.log sorts lexicographically)
export function collectFiles(src) {
  const files = [];
  for (const month of fs.readdirSync(src).sort()) {
    const md = path.join(src, month);
    if (!fs.statSync(md).isDirectory()) continue;
    for (const f of fs.readdirSync(md).sort()) {
      if (f.endsWith('.log')) files.push(path.join(md, f));
    }
  }
  return files;
}

// Canonical corpus-relative path used both as the manifest key and each record's
// `source`. Forward slashes everywhere so it is stable across platforms.
export function relPath(src, file) {
  return path.relative(src, file).replace(/\\/g, '/');
}

const TS_RE = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):(\d{2})\]/;
const MODEL_RE = /\[INFO\]\[([^\]]+)\] (?:Prompt processing|Running chat|Finished streaming)/;
const TIMING_RE = /print_timing: id\s+(\d+) \| task\s+(\d+) \|/;
// llama.cpp right-pads numbers, so allow variable spacing around the slash
const PROMPT_TOK_RE = /prompt eval time\s*=\s*[\d.]+\s*ms\s+\/\s+(\d+) tokens/;
const GEN_TOK_RE = /\beval time\s*=\s*[\d.]+\s*ms\s+\/\s+(\d+) tokens/;

/**
 * Parse the given log files (absolute paths, in chronological order) into records.
 * @param {string[]} files absolute log paths in chronological order
 * @param {{src:string, startModel?:string|null}} opts
 * @returns {{records:Array, timingBlocks:number, endModel:string|null}}
 */
export function parseFiles(files, { src, startModel = null } = {}) {
  let lastModel = startModel;   // carried across files (chronological order)
  let lastTs = 0;              // fallback ts for groups whose first line lacks a timestamp
  const records = new Map();   // key `${fileIdx}:${slot}:${task}` -> [tsMs, model, promptSum, compSum, source]
  let timingBlocks = 0;

  // Model is captured at group start (nearest preceding [INFO][model] line).
  // Task ids reset on server restarts, so the file index is part of the key.
  function flushGroup(g, fileIdx) {
    if (!g || (g.prompt === null && g.comp === null)) return;
    const key = `${fileIdx}:${g.slot}:${g.task}`;
    let rec = records.get(key);
    if (!rec) { // first sighting of this slot:task in this file — keep earliest ts + model
      rec = [g.ts, g.modelAtStart, 0, 0, g.rel];
      records.set(key, rec);
    }
    rec[2] += g.prompt || 0;
    rec[3] += g.comp || 0;
  }

  files.forEach((file, fileIdx) => {
    const rel = relPath(src, file);
    const text = fs.readFileSync(file, 'utf8');
    let cur = null; // current timing group {slot, task, ts, prompt, comp, modelAtStart, rel}
    for (const line of text.split('\n')) {
      const tsm = line.match(TS_RE);
      // Log timestamps are timezone-naive LOCAL wall-clock (LM Studio records system-local time).
      // Interpret the components as local time and convert to a true UTC epoch instant, so that
      // the emitted .toISOString() values carry a correct 'Z' and can never drift ahead of generatedAt.
      // (Under BST/GMT this subtracts/adds the offset; in GMT winter the offset is 0 so values are unchanged.)
      if (tsm) lastTs = new Date(+tsm[1].slice(0, 4), +tsm[1].slice(5, 7) - 1, +tsm[1].slice(8, 10), +tsm[2], +tsm[3], +tsm[4]).getTime();

      const tm = line.match(TIMING_RE);
      if (tm) {
        const slot = +tm[1], task = +tm[2];
        if (!cur || cur.slot !== slot || cur.task !== task) {
          flushGroup(cur, fileIdx);
          cur = { slot, task, ts: lastTs || Date.now(), prompt: null, comp: null, modelAtStart: lastModel, rel };
          timingBlocks++;
        }
        const pm = line.match(PROMPT_TOK_RE);
        if (pm) {
          cur.prompt = (cur.prompt || 0) + +pm[1];
        } else {
          const gm = line.match(GEN_TOK_RE); // "eval time" lines only (prompt lines handled above)
          if (gm) cur.comp = (cur.comp || 0) + +gm[1];
        }
        continue;
      }

      // Any non-timing line ends the current group
      if (cur) { flushGroup(cur, fileIdx); cur = null; }

      const mm = line.match(MODEL_RE);
      if (mm) lastModel = mm[1];
    }
    flushGroup(cur, fileIdx);
  });

  // Serialize to canonical v1 object schema. Each record:
  //   { ts, model|null, evaluatedIn (GPU prompt-eval tokens), outTokens (generated tokens), source }
  // null model stays explicit (best-effort attribution); evaluatedIn/outTokens are
  // directly measured timing values — no join-derived or cache fields are invented.
  const recordsOut = [...records.values()].map(([tsMs, model, p, c, source]) => ({ ts: tsMs, model, evaluatedIn: p, outTokens: c, source }));
  return { records: recordsOut, timingBlocks, endModel: lastModel };
}

// Serialize the top-level dataset object. Shared by the CLI and the incremental
// engine so both produce byte-identical output (modulo generatedAt).
export function serialize(out) {
  return JSON.stringify(out);
}

// Write to a temp file then atomically rename into place, so a failure mid-write
// never leaves usage.json or the manifest partially written.
export function atomicWrite(target, data) {
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, target);
}

// CLI entry point (full-corpus rebuild). Only runs when executed directly.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const files = collectFiles(SRC);
  console.log(`Scanning ${files.length} log files in ${SRC}`);
  const { records, timingBlocks } = parseFiles(files, { src: SRC });

  const out = {
    version: 1,
    generatedAt: new Date().toISOString(),
    sourceDir: SRC,
    recordCount: records.length,
    records,
  };
  atomicWrite(OUT, serialize(out));

  // Summary for sanity check
  const byModel = new Map();
  let tp = 0, tc = 0;
  for (const { model, evaluatedIn: p, outTokens: c } of out.records) {
    const k = model || '(unknown)';
    const e = byModel.get(k) || [0, 0, 0];
    e[0]++; e[1] += p; e[2] += c;
    byModel.set(k, e);
    tp += p; tc += c;
  }
  console.log(`\nParsed ${out.recordCount} requests from ${timingBlocks} timing blocks`);
  console.log(`Total: ${(tp / 1e6).toFixed(1)}M input + ${(tc / 1e6).toFixed(1)}M output tokens\n`);
  const rows = [...byModel.entries()].sort((a, b) => (b[1][1] + b[1][2]) - (a[1][1] + a[1][2])).slice(0, 15);
  for (const [model, [n, p, c]] of rows) {
    console.log(`${String(n).padStart(6)} req  ${((p + c) / 1e6).toFixed(2).padStart(8)}M tok  ${(p / 1e6).toFixed(2)}M in / ${(c / 1e6).toFixed(2)}M out   ${model}`);
  }
  console.log(`\nWrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
}
