#!/usr/bin/env node
/**
 * parse.mjs — Extract per-request token usage from LM Studio server logs.
 *
 * Source:  ~/.lmstudio/server-logs/<YYYY-MM>/<date>.N.log
 * Signal:  llama.cpp "print_timing" DEBUG lines, one block per request task:
 *           prompt eval time = X ms / N tokens   -> input (sent) tokens
 *           eval time        = X ms / M tokens   -> output (received) tokens
 * Model attribution: nearest preceding [INFO][<model>] line (best effort;
 * ~98%+ accurate — only misattributes when 2 models run concurrently).
 *
 * Output: data/usage.json  { generatedAt, sourceDir, records: [[tsMs, model, promptTokens, completionTokens], ...] }
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
const files = [];
for (const month of fs.readdirSync(SRC).sort()) {
  const md = path.join(SRC, month);
  if (!fs.statSync(md).isDirectory()) continue;
  for (const f of fs.readdirSync(md).sort()) {
    if (f.endsWith('.log')) files.push(path.join(md, f));
  }
}
console.log(`Scanning ${files.length} log files in ${SRC}`);

const TS_RE = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):(\d{2})\]/;
const MODEL_RE = /\[INFO\]\[([^\]]+)\] (?:Prompt processing|Running chat|Finished streaming)/;
const TIMING_RE = /print_timing: id\s+(\d+) \| task (\d+) \|/;
// llama.cpp right-pads numbers, so allow variable spacing around the slash
const PROMPT_TOK_RE = /prompt eval time\s*=\s*[\d.]+\s*ms\s+\/\s+(\d+) tokens/;
const GEN_TOK_RE = /\beval time\s*=\s*[\d.]+\s*ms\s+\/\s+(\d+) tokens/;

let lastModel = null;      // carried across files (chronological order)
let lastTs = 0;            // fallback ts for groups whose first line lacks a timestamp
let records = new Map();   // key `${fileIdx}:${slot}:${task}` -> [tsMs, model, promptSum, compSum]
let totalLines = 0, timingBlocks = 0;

// Model is captured at group start (nearest preceding [INFO][model] line).
// Task ids reset on server restarts, so the file index is part of the key.
function flushGroup(g, fileIdx) {
  if (!g || (g.prompt === null && g.comp === null)) return;
  const key = `${fileIdx}:${g.slot}:${g.task}`;
  let rec = records.get(key);
  if (!rec) { // first sighting of this slot:task in this file — keep earliest ts + model
    rec = [g.ts, g.modelAtStart, 0, 0];
    records.set(key, rec);
  }
  rec[2] += g.prompt || 0;
  rec[3] += g.comp || 0;
}

function parseFile(file, fileIdx) {
  const text = fs.readFileSync(file, 'utf8');
  let cur = null; // current timing group {slot, task, ts, prompt, comp, modelAtStart}
  for (const line of text.split('\n')) {
    totalLines++;

    const tsm = line.match(TS_RE);
    if (tsm) lastTs = Date.UTC(+tsm[1].slice(0, 4), +tsm[1].slice(5, 7) - 1, +tsm[1].slice(8, 10), +tsm[2], +tsm[3], +tsm[4]);

    const tm = line.match(TIMING_RE);
    if (tm) {
      const slot = +tm[1], task = +tm[2];
      if (!cur || cur.slot !== slot || cur.task !== task) {
        flushGroup(cur, fileIdx);
        cur = { slot, task, ts: lastTs || Date.now(), prompt: null, comp: null, modelAtStart: lastModel };
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
}

files.forEach((f, i) => parseFile(f, i));

// Serialize: [tsMs, model|null, promptTokens, completionTokens]
const out = {
  generatedAt: new Date().toISOString(),
  sourceDir: SRC,
  recordCount: records.size,
  records: [...records.values()],
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out));

// Summary for sanity check
const byModel = new Map();
let tp = 0, tc = 0;
for (const [ts, model, p, c] of out.records) {
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
