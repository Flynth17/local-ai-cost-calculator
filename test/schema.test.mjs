import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const data = JSON.parse(readFileSync(new URL("../data/usage.json", import.meta.url)));

test("canonical v1 contract shape", () => {
  assert.equal(data.version, 1);
  assert.ok(Array.isArray(data.records));
  assert.equal(data.recordCount, data.records.length);
  assert.equal(typeof data.generatedAt, "string");
  assert.equal(typeof data.sourceDir, "string");
});

test("every record has canonical fields with correct types", () => {
  for (const r of data.records) {
    assert.equal(typeof r.ts, "number", `ts numeric @${r.ts}`);
    assert.equal(typeof r.evaluatedIn, "number", `evaluatedIn numeric @${r.ts}`);
    assert.equal(typeof r.outTokens, "number", `outTokens numeric @${r.ts}`);
    // model is a non-empty string OR explicit null — never "" (unknown stays unknown)
    assert.ok(r.model === null || typeof r.model === "string", `model string|null @${r.ts}`);
    assert.notEqual(r.model, "", `model never empty @${r.ts}`);
  }
});

test("no NaN / non-finite token values anywhere", () => {
  for (const r of data.records) {
    for (const k of ["ts", "evaluatedIn", "outTokens"]) assert.ok(Number.isFinite(r[k]), `finite ${k} @${r.ts}`);
  }
});

test("record ids are unique (no duplicate timing lines)", () => {
  const seen = new Set();
  for (const r of data.records) assert.ok(seen.add(r.ts), `duplicate ts @${r.ts}`);
});
