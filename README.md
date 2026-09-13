# Local AI Cost Calculator — LM Studio Token Dashboard

Parses your LM Studio server logs into per-request token usage and renders an interactive dashboard:
per-model split (dropdown), day/week/month/year trends, most-used models ranking, and cost at your
token prices.

## Quick start

```bat
run.bat
```
or manually:

```bash
node parse.mjs     # scan ~/.lmstudio/server-logs -> data/usage.json
node server.mjs    # serve dashboard on http://localhost:8787
```

Then open **http://localhost:8787**. After LM Studio writes more logs, re-run `node parse.mjs` and hit
**↻ Refresh** in the UI.

## What's shown

| Feature | Detail |
|---|---|
| Model dropdown | Filter every panel/chart to one model (or all) |
| Granularity | Day / Week / Month / Year buckets, gaps shown as zero |
| Trend chart | Stacked input+output bars per period (gaps shown as zero) |
| Trend KPI | Last *complete* period vs previous (▲/▼ %) |
| Most used models | Ranking by tokens with request counts, share bar, est. cost (filter the whole dashboard via the Model dropdown above) |
| Prices | Editable per-1M-token input (**$4.40**) and output (**$22.00**) rates — no cache-rate field, since the v3 cache-decomposition joiner is retired |

## Where the data comes from

LM Studio has no usage database — token counts only exist in its server logs when debug logging is on:

```
~/.lmstudio/server-logs/<YYYY-MM>/<date>.N.log
  [ts][DEBUG] ... print_timing: id S | task T | prompt eval time = X ms / N tokens   <- evaluatedIn (GPU-evaluated / cache-miss input)
  ...          print_timing: id S | task T |        eval time = X ms / M tokens      <- outTokens (generated output)
```

`parse.mjs` groups those lines per request and attributes the model from the nearest preceding
`[INFO][<model>]` log line.

## Accuracy notes

- **New accounting basis (v1).** `parse.mjs` produces a fresh, reproducible accounting basis straight
  from the LM Studio server logs. The retired v3 cache-decomposition joiner was removed deliberately and is
  NOT reimplemented, so **the canonical series is not numerically continuous with the frozen `usage-v3.json`
  snapshot.** Do not diff new values against the old v3 numbers as if they were the same metric: token volume
  is conserved (within ~0.5% in the comparable period), but *request counts* can diverge because request
  grouping/attribution changed. Historical values may differ; equivalence is intentionally not forced.
- **Model attribution** is best-effort (~98% accurate on this machine): it's only ambiguous when two
  models run concurrently in different slots.
- **Cached / reused (logical) input is not recorded** by LM Studio logs, so only GPU-evaluated input
  (`evaluatedIn`) and generated output (`outTokens`) are measured. Historical cachedInput is therefore
  not reproducibly recoverable from the reproducible log source; cost is computed on this measurable
  canonical basis, and cached-cost shows $0. For exact numbers (including cache hits), capture `usage`
  from API responses (`stream_options: {"include_usage": true}`) via a small proxy and merge it into
  `data/usage.json`.
- **History depth**: only dates with debug timing lines are counted (on this machine: ~June 2026 onward).
- Request bodies (including prompts) appear in the raw logs — keep that in mind if you share log files.

## Files

```
parse.mjs        log scanner -> data/usage.json   [node parse.mjs <srcDir> <outFile>]
server.mjs       zero-dependency static server    [node server.mjs <port=8787>]
index.html       dashboard (vanilla JS + vendored Chart.js, works offline)
vendor/chart.umd.min.js
data/usage.json  generated (canonical v1): { version:1, records:[{ ts, model|null, evaluatedIn, outTokens }] }
run.bat          parse + serve + open browser
```
