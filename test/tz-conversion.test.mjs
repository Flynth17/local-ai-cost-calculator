import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// Deterministic BST/UTC conversion checks. The host machine's own timezone must NOT matter,
// so we run tiny child `node` processes with an explicit TZ and assert the local->UTC instant.
function convertISO(tz, y, mo, d, h, mi, s) {
  const code =
    "console.log(new Date(" + y + "," + (mo - 1) + "," + d + "," + h + "," + mi + "," + s + ").toISOString())";
  const out = spawnSync("node", ["-e", code], {
    env: { ...process.env, TZ: tz },
    encoding: "utf8",
  });
  if (out.status !== 0) throw new Error(out.stderr || `child failed status=${out.status}`);
  return out.stdout.trim();
}

test("BST summer wall-clock converts to true UTC by subtracting the +1h offset", () => {
  // LM Studio log reads local '2026-09-13 00:23:12' (BST). Correct UTC instant is prev-day 23:23:12Z.
  assert.equal(convertISO("Europe/London", 2026, 9, 13, 0, 23, 12), "2026-09-12T23:23:12.000Z");
});

test("UTC wall-clock is left unchanged (conversion is tz-aware, not a hardcoded shift)", () => {
  assert.equal(convertISO("UTC", 2026, 9, 13, 0, 23, 12), "2026-09-13T00:23:12.000Z");
});

test("winter GMT wall-clock has no spurious shift (offset is 0 outside BST)", () => {
  assert.equal(convertISO("Europe/London", 2026, 1, 15, 9, 0, 0), "2026-01-15T09:00:00.000Z");
});
