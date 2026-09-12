import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// modelKey() is a verbatim copy of index.html's grouping used for the (unknown) bucket.
function modelKey(r) { return r.model == null ? "(unknown)" : r.model; }

const data = JSON.parse(readFileSync(new URL("../data/usage.json", import.meta.url)));

test("unattributed records stay explicitly unknown (null preserved, never coerced)", () => {
  const nullModels = data.records.filter(r => r.model === null);
  assert.ok(nullModels.length > 0, "dataset contains unattributed requests");
  for (const r of nullModels) {
    // index.html groups them under "(unknown)" — never treated as zero or empty.
    assert.equal(modelKey(r), "(unknown)", `null model @${r.ts}`);
    // token values are still measured and feed KPIs normally.
    assert.equal(typeof r.evaluatedIn, "number");
    assert.equal(typeof r.outTokens, "number");
  }
});

test("the '(unknown)' bucket coexists with named models in rankings", () => {
  const names = new Set(data.records.map(r => modelKey(r)));
  assert.ok(names.has("(unknown)"), "'(unknown)' present alongside real models");
  assert.ok([...names].some(n => n !== "(unknown)"), "named models also present");
});
