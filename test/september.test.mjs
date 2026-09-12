import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, unlinkSync } from "node:fs";

// Verbatim copies of the dashboard's core-metric helpers (index.html) so tests validate
// that data/usage.json feeds the SAME computations the UI performs — without a browser.
function aggregate(recs) {
  const a = { n: 0, evalIn: 0, outTok: 0 };
  for (const r of recs) {
    a.n++;
    if (r.evaluatedIn != null) a.evalIn += r.evaluatedIn;
    if (r.outTokens   != null) a.outTok += r.outTokens;
  }
  return a;
}
function modelKey(r) { return r.model == null ? "(unknown)" : r.model; }

const data = JSON.parse(readFileSync(new URL("../data/usage.json", import.meta.url)));

// September 2026 in UTC (index.html buckets by local time; this window is tz-robust).
const SEP_START = Date.UTC(2026, 8, 1); // Sept 1 2026 00:00Z
const SEP_END   = Date.UTC(2026, 9, 1);  // Oct 1 2026 00:00Z

function september() {
  return data.records.filter(r => r.ts >= SEP_START && r.ts < SEP_END);
}

test("September 2026 records exist and satisfy the canonical contract", () => {
  const sept = september();
  assert.ok(sept.length > 0, "expected September 2026 records");
  for (const r of sept) {
    assert.equal(typeof r.ts, "number");
    assert.equal(typeof r.evaluatedIn, "number");
    assert.equal(typeof r.outTokens, "number");
    assert.ok(r.model === null || typeof r.model === "string");
  }
});

test("September data is renderable through the dashboard's core metric pipeline", () => {
  const sept = september();
  const a = aggregate(sept);           // index.html mirror: request count + measured tokens
  assert.ok(a.n > 0, "September has requests (kReq)");
  assert.ok(a.evalIn > 0, "September has GPU-evaluated input (kEval / tokens-over-time)");
  assert.ok(a.outTok > 0, "September has output tokens (kOut / cost-over-time)");
});

test("dashboard KPIs compute for September without error", () => {
  const sept = september();
  const p = { input: 4.40, cached: 0.44, output: 22.00 }; // index.html defaults
  const a = aggregate(sept);
  // kCostLB formula is verbatim from index.html render():
  const costLB = (a.evalIn * p.input + a.outTok * p.output) / 1e6;
  assert.ok(a.n > 0 && costLB > 0, "kReq and whole-workload lower-bound are positive");
});

test("model ranking builds from canonical records (surviving core feature)", () => {
  const byModel = new Map();
  for (const r of data.records) {
    const k = modelKey(r);
    let m = byModel.get(k); if (!m) { m = { n: 0, evalIn: 0, outTok: 0 }; byModel.set(k, m); }
    m.n++;
    if (r.evaluatedIn != null) m.evalIn += r.evaluatedIn;
    if (r.outTokens   != null) m.outTok += r.outTokens;
  }
  const ranked = [...byModel.values()].sort((x, y) => (y.evalIn + y.outTok) - (x.evalIn + x.outTok));
  assert.ok(ranked.length > 0);
  // total tokens used for share denominator is positive and reproducible.
  const totalTokens = ranked.reduce((s, m) => s + m.evalIn + m.outTok, 0);
  assert.ok(totalTokens > 0);
});
