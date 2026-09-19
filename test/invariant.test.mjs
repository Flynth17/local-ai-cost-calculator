import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { unlinkSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// End-to-end invariant: for a freshly generated usage.json, max(records[].ts) must NOT
// materially exceed generatedAt. A few seconds of clock/skew tolerance is acceptable; an
// ~1 hour drift (the naive-local-as-UTC bug) must fail this test.
const TOLERANCE_MS = 60_000; // 60s — far below the ~1h (3.6e6 ms) bug, well above realistic skew
const OUT = path.join(os.tmpdir(), "usage-invariant-check.json");
const src = path.join(os.homedir(), ".lmstudio", "server-logs");

test("max record ts <= generatedAt + small tolerance (parser emits true UTC instants)", () => {
  // Force the host timezone (Europe/London) so the local->UTC conversion is exercised exactly
  // as it runs in production. GeneratedAt is always true UTC regardless of TZ.
  // Parse with a large old-space heap: the corpus is now multi-gigabyte and Node's
  // default ~4 GB heap is insufficient. Use process.execPath + an explicit flag so the
  // checked-in `npm test` path is viable without relying on an ambient NODE_OPTIONS.
  const r = spawnSync(process.execPath, ["--max-old-space-size=8192", "parse.mjs", src, OUT], {
    cwd: process.cwd(),
    env: { ...process.env, TZ: "Europe/London" },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `parser failed: ${r.stderr || r.stdout}`);
  try {
    const data = JSON.parse(readFileSync(OUT, "utf8"));
    const genMs = Date.parse(data.generatedAt);
    const maxTs = Math.max(...data.records.map(x => x.ts));
    const deltaSec = ((maxTs - genMs) / 1000).toFixed(1);

    assert.ok(maxTs <= genMs + TOLERANCE_MS, `max ts ${new Date(maxTs).toISOString()} exceeds generatedAt by ${deltaSec}s (> ${TOLERANCE_MS/1000}s tolerance)`);
    // Explicit guard against the ~1h regression specifically.
    assert.ok((maxTs - genMs) < 3_500_000, `max ts is within an hour of generatedAt (bug would place it ~1h ahead)`);

    return { maxTs, genMs, deltaSec };
  } finally {
    if (existsSync(OUT)) unlinkSync(OUT);
  }
}, { skip: !existsSync(src) });
