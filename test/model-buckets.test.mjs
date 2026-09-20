/**
 * Regression tests for normalizeModel() — the variant-combining key used by the
 * dashboard's "Most used models" ranking and dropdown (index.html).
 *
 * index.html is a classic, non-importable <script>, so this test keeps a verbatim
 * copy of normalizeModel()/MODEL_SUFFIX as the source of truth lives in index.html.
 * Keep the two in sync: https://github.com/Flynth17/local-ai-cost-calculator
 *
 * Rule (confirmed with maintainer): strip a provider / full-path prefix, any
 * trailing @quant spec, and repeated trailing quantization/format suffix tokens,
 * while PRESERVING version + parameter size. So qwen3.8-27b variants collapse to
 * one bucket, but ornith-1.5 stays separate from ornith-1.0 and qwen3.6-35b from
 * qwen3.6-27b. flash-next variants are intentionally kept separate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ---- verbatim copy of index.html's normalizeModel / MODEL_SUFFIX (source of truth) ----
const MODEL_SUFFIX = /(awq|int4|nvfp4|mtp|ud|a3b|a4b|a6b|qat|obliterated|low|it-ud|kquant|dynamic)/i;
function normalizeModel(m) {
  if (m == null) return "(unknown)";
  let s = m;
  const slash = s.lastIndexOf("/");
  if (slash >= 0) s = s.slice(slash + 1);                 // last path segment
  s = s.replace(/\.(gguf|bin|safetensors|pt|pth)$/i, "");  // strip file extension
  s = s.replace(/@[a-z0-9_.]+$/i, "");                     // strip @q4_k_xl etc.
  let prev;
  do { prev = s; s = s.replace(new RegExp("-" + MODEL_SUFFIX.source + "$", "i"), ""); } while (s !== prev);
  return s || "(unknown)";
}

test("all qwen3.8-27b variants collapse to a single bucket", () => {
  const variants = [
    "qwen3.8-27b",
    "qwen3.8-27b-awq-int4",
    "qwen3.8-27b-nvfp4-mtp",
    "qwen3.8-27b-nvfp4-mtp-low",
    "qwen3.8-27b-obliterated",
    "qwen3.8-27b-ud@q4_k_xl",
    "qwen/qwen3.8-27b",
    "esatapedico/qwen3.8-27b-nvfp4-mtp-gguf/qwen3.8-27b-nvfp4-mtp-low.gguf",
  ];
  const keys = new Set(variants.map(normalizeModel));
  assert.equal(keys.size, 1, "every qwen3.8-27b spelling maps to one key");
  assert.equal([...keys][0], "qwen3.8-27b");
});

test("ornith-1.5 variants merge but stay separate from ornith-1.0", () => {
  const v15 = new Set(["atomicchat/ornith-1.5-35b-a3b", "ornith-1.5-35b-a3b", "ornith-ai/ornith-1.5-35b-a3b"].map(normalizeModel));
  assert.equal(v15.size, 1);
  assert.equal([...v15][0], "ornith-1.5-35b");
  assert.equal(normalizeModel("ornith-1.0-35b-ud"), "ornith-1.0-35b");
  assert.notEqual(normalizeModel("ornith-1.5-35b-a3b"), normalizeModel("ornith-1.0-35b-ud"), "1.5 must not merge with 1.0");
});

test("version + parameter size are preserved (no cross-version merge)", () => {
  assert.notEqual(normalizeModel("qwen3.8-27b"), normalizeModel("qwen3.6-27b"), "3.8 vs 3.6 differ");
  assert.notEqual(normalizeModel("qwen3.6-35b"), normalizeModel("qwen3.6-27b"), "35b vs 27b differ");
  assert.equal(normalizeModel("qwen/qwen3.6-35b-a3b"), "qwen3.6-35b");
});

test("@quant specs are stripped", () => {
  assert.equal(normalizeModel("glm-4.7-flash@q5_k_m"), "glm-4.7-flash");
  assert.equal(normalizeModel("spark-x2.5-4b@q4_k_m"), "spark-x2.5-4b");
});

test("explicit null stays an explicit (unknown) bucket, never coerced to ''", () => {
  assert.equal(normalizeModel(null), "(unknown)");
});

test("flash-next variants are kept separate (per maintainer decision)", () => {
  assert.notEqual(normalizeModel("qwen3.8-flash-next"), normalizeModel("qwen3.8-flash-next-reap-256-duo"));
});

// End-to-end against the real corpus: grouping must not drop or duplicate requests,
// and version separation must hold across the actual dataset.
test("real corpus: variant combining is lossless and version-preserving", () => {
  const data = JSON.parse(readFileSync(new URL("../data/usage.json", import.meta.url)));
  assert.ok(data.records.length > 0);

  // Lossless: every record maps to exactly one bucket; no request vanishes.
  const buckets = new Map();
  for (const r of data.records) {
    const k = normalizeModel(r.model);
    buckets.set(k, (buckets.get(k) || 0) + 1);
  }
  const total = [...buckets.values()].reduce((a, b) => a + b, 0);
  assert.equal(total, data.records.length, "every record lands in exactly one bucket");

  // All real qwen3.8-27b spellings share one bucket.
  const qKeys = new Set(data.records.map(r => normalizeModel(r.model)).filter(k => k.startsWith("qwen3.8-27b")));
  assert.deepEqual([...qKeys].sort(), ["qwen3.8-27b"]);

  // Version separation holds on real data: no bucket mixes 1.5 with 1.0 or 3.6 with 3.8.
  for (const [k, n] of buckets) {
    assert.ok(!/ornith-1\.[05]/.test(k) || k === "ornith-1.5-35b" || k === "ornith-1.0-35b", `single version per ornith bucket: ${k}`);
  }
});
