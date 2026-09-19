/**
 * import.mjs — Incremental log ingestion engine for the Local AI Cost Calculator.
 *
 * Replaces the "reparse the entire ~2 GB historical corpus on every refresh"
 * workflow with an incremental ingest model:
 *
 *   source logs ─▶ discover files ─▶ compare with import manifest ─▶
 *        unchanged → SKIP      new → IMPORT      changed → RE-IMPORT
 *                 ─▶ update usage.json ─▶ update manifest
 *
 * A persistent, gitignored manifest (data/imported-logs.json) records which
 * source log files have already been successfully ingested. Normal "Refresh data"
 * inspects the corpus, imports only what is new or changed, and never re-reads
 * unchanged historical logs. The full parser (parse.mjs) remains available as an
 * explicit "Rebuild All Data" recovery path.
 *
 * Contract with parse.mjs:
 *   - Both the incremental and full-corpus paths call the SAME parseFiles() so they
 *     cannot silently diverge semantically.
 *   - Every emitted record carries an additive `source` field = corpus-relative
 *     path (e.g. "2026-09/2026-09-19.9.log"). This is the canonical relative-path
 *     representation shared with the manifest key — never an absolute, machine-
 *     specific path. Existing dashboard readers only read ts/evaluatedIn/outTokens
 *     and are unaffected by the extra field.
 *   - Model attribution carries across files in chronological order; when parsing a
 *     suffix of the corpus (new files appended at the end) the caller seeds
 *     `startModel` with the previous tail model so boundary requests keep their
 *     correct attribution — identical to a full-corpus parse.
 *
 * Migration rule: existing usage.json records have no source attribution, and an
 * absent/invalid/incompatible manifest cannot safely describe the current output.
 * Therefore, if the dataset has unattributed legacy records OR the manifest is
 * missing/invalid/incompatible, we perform a FULL REBUILD — never an incremental
 * merge into legacy unattributed output. After a successful rebuild every eligible
 * record carries source attribution and the manifest represents the corpus state.
 *
 * Persistence safety: writes go to a temp file, are flushed/closed, then atomically
 * renamed into place; a failure mid-write never leaves usage.json or the manifest
 * partially written. A module-level concurrency guard ensures two refreshes cannot
 * mutate ingestion state concurrently (concurrent callers await the same run).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { collectFiles, parseFiles, relPath, atomicWrite } from './parse.mjs';

export const MANIFEST_NAME = 'imported-logs.json';
const DATASET_NAME = 'usage.json';
const MANIFEST_VERSION = 1;

// Fixed internal corpus location — the SAME default as parse.mjs. The server never
// derives this from a client-supplied path, so callers cannot redirect it.
export function getCorpusDir() {
  return path.join(os.homedir(), '.lmstudio', 'server-logs');
}

function datasetPath(dataDir) { return path.join(dataDir, DATASET_NAME); }
function manifestPath(dataDir) { return path.join(dataDir, MANIFEST_NAME); }

// ---------------------------------------------------------------------------
// Manifest load / validate
// ---------------------------------------------------------------------------
/**
 * Load and validate the import manifest. Returns null if it is missing, not valid
 * JSON, or incompatible (wrong version / missing files map), so callers fall back
 * to a full rebuild rather than trusting an unusable index.
 */
export function loadManifest(dataDir) {
  let raw;
  try { raw = fs.readFileSync(manifestPath(dataDir), 'utf8'); } catch { return null; } // absent → rebuild
  let m;
  try { m = JSON.parse(raw); } catch { return null; } // corrupt → rebuild
  if (!m || typeof m !== 'object' || m.version !== MANIFEST_VERSION || !m.files || typeof m.files !== 'object' || Array.isArray(m.files)) {
    return null; // incompatible → rebuild
  }
  return { version: m.version, lastModel: (typeof m.lastModel === 'string' ? m.lastModel : null), files: m.files };
}

// ---------------------------------------------------------------------------
// Dataset load / validate
// ---------------------------------------------------------------------------
export function loadDataset(dataDir) {
  let raw;
  try { raw = fs.readFileSync(datasetPath(dataDir), 'utf8'); } catch { return null; }
  let d;
  try { d = JSON.parse(raw); } catch { return null; }
  if (!d || d.version !== 1 || !Array.isArray(d.records)) return null;
  return d;
}

// Legacy (pre-attribution) records have no `source`. If any present record lacks a
// non-empty string source, the output is unattributed and cannot be incrementally
// merged — it must be rebuilt. An empty records array is not legacy (fresh start).
export function hasLegacyRecords(dataset) {
  if (!dataset || !Array.isArray(dataset.records)) return true;
  return dataset.records.some(r => typeof r.source !== 'string' || r.source.length === 0);
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------
/**
 * Classify current corpus files against the manifest.
 * @param {string[]} currentFiles absolute log paths in chronological order
 * @param {{files:Object, lastModel?:string|null}} manifest
 * @returns {{ newRel:string[], changedRel:string[], unchangedRel:string[], missingOnDisk:string[] }}
 */
export function classify(currentFiles, manifest, src) {
  const newRel = [], changedRel = [], unchangedRel = [], missingOnDisk = [];
  for (const file of currentFiles) {
    const rel = relPath(src, file);
    const entry = manifest.files[rel];
    if (!entry) {
      newRel.push(rel);
    } else {
      const st = fs.statSync(file);
      if (st.size !== entry.size || st.mtimeMs !== entry.mtimeMs) changedRel.push(rel);
      else unchangedRel.push(rel);
    }
  }
  for (const rel of Object.keys(manifest.files)) {
    if (!currentFiles.some(f => relPath(src, f) === rel)) missingOnDisk.push(rel);
  }
  return { newRel, changedRel, unchangedRel, missingOnDisk };
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------
function serializeManifest(manifest) {
  // Pretty-printed for human-readable local state; compact is fine too.
  return JSON.stringify(manifest, null, 2);
}

/** Build a fresh manifest describing the current corpus after a successful ingest. */
function buildManifest(currentFiles, src, endModel) {
  const files = {};
  for (const file of currentFiles) {
    const st = fs.statSync(file);
    files[relPath(src, file)] = { size: st.size, mtimeMs: st.mtimeMs, lastImportedAt: new Date().toISOString() };
  }
  return { version: MANIFEST_VERSION, lastModel: endModel, files };
}

// ---------------------------------------------------------------------------
// Full rebuild (explicit recovery path + migration fallback)
// ---------------------------------------------------------------------------
/**
 * Parse every current file in one pass and atomically rewrite usage.json + manifest.
 * Used for the explicit "Rebuild All Data" path and for migrating legacy/unattributed
 * output. Never merges into unattributed data — it replaces it wholesale.
 */
export function fullRebuild(currentFiles, src, dataDir) {
  const { records, timingBlocks, endModel } = parseFiles(currentFiles, { src });
  const now = new Date().toISOString();
  const dataset = { version: 1, generatedAt: now, sourceDir: src, recordCount: records.length, records };
  atomicWrite(datasetPath(dataDir), JSON.stringify(dataset));

  const manifest = buildManifest(currentFiles, src, endModel);
  atomicWrite(manifestPath(dataDir), serializeManifest(manifest));

  return {
    rebuildRequired: true,
    newSources: currentFiles.length,
    changedSources: 0,
    unchangedSources: 0,
    missingSources: 0,
    recordsAdded: records.length,
    recordsReplaced: 0,
    parsedFiles: currentFiles.length,
    timingBlocks,
  };
}

// ---------------------------------------------------------------------------
// Refresh (incremental ingestion) with concurrency guard + migration
// ---------------------------------------------------------------------------
let inflight = null; // in-flight refresh promise (concurrent callers await the same run)

/**
 * Inspect the corpus for changes since the persisted manifest and process only the
 * necessary sources. Idempotent: a second refresh against an unchanged corpus is a
 * no-op that rewrites nothing.
 *
 * @param {{src?:string, dataDir?:string, forceRebuild?:boolean}} [opts]
 *   src      — corpus directory (default: fixed internal location)
 *   dataDir  — where usage.json + manifest live (default: project data/)
 *   forceRebuild — always rebuild (explicit "Rebuild All Data")
 */
export function refresh({ src = getCorpusDir(), dataDir, forceRebuild = false } = {}) {
  if (!dataDir) throw new Error('import.refresh requires a dataDir');
  fs.mkdirSync(dataDir, { recursive: true });

  // Concurrency guard: reuse the running operation; concurrent callers share its result.
  if (inflight) return inflight;

  const op = (async () => {
    const currentFiles = collectFiles(src);
    const manifest = loadManifest(dataDir);
    const dataset = loadDataset(dataDir);

    // Migration / full-rebuild triggers: legacy unattributed output, or a manifest
    // that cannot safely describe the current output. Never merge into legacy data.
    if (forceRebuild || !manifest || !dataset || hasLegacyRecords(dataset)) {
      return fullRebuild(currentFiles, src, dataDir);
    }

    const { newRel, changedRel, unchangedRel, missingOnDisk } = classify(currentFiles, manifest, src);

    // A changed source must be re-imported. In-place replacement of a middle file is
    // unsafe for cross-file model attribution, so we rebuild — but only when it cannot
    // silently drop preserved records from sources that are simply absent on disk.
    if (changedRel.length > 0) {
      if (!forceRebuild && missingOnDisk.length > 0) {
        // Don't auto-rebuild while sources are absent on disk — that would drop their
        // preserved records. Report the change and let the user trigger a rebuild.
        return {
          rebuildRequired: false, changedSources: changedRel.length, unchangedSources: unchangedRel.length,
          missingSources: missingOnDisk.length, recordsAdded: 0, recordsReplaced: 0, parsedFiles: 0,
          skippedRebuild: 'source(s) missing on disk; run Rebuild All Data to reconcile',
        };
      }
      // A changed source is reconciled with a full rebuild (safe for cross-file model
      // attribution). Report how many sources triggered it.
      const rb = fullRebuild(currentFiles, src, dataDir);
      return { ...rb, changedSources: changedRel.length };
    }

    // No new sources and no changes: idempotent no-op — rewrite nothing.
    if (newRel.length === 0) {
      return {
        rebuildRequired: false, newSources: 0, changedSources: 0, unchangedSources: unchangedRel.length,
        missingSources: missingOnDisk.length, recordsAdded: 0, recordsReplaced: 0, parsedFiles: 0,
      };
    }

    // New files only (the common append path): parse carrying the previous tail model
    // so boundary requests keep correct attribution — identical to a full-corpus parse.
    const toParse = newRel.map(rel => path.join(src, rel));
    const { records, timingBlocks, endModel } = parseFiles(toParse, { src, startModel: manifest.lastModel });

    // Append new records (new sources cannot duplicate existing ones). Existing records
    // are preserved verbatim; appended files are chronologically later, so ordering is
    // identical to a single full-corpus pass.
    const updatedRecords = [...dataset.records, ...records];
    const now = new Date().toISOString();
    atomicWrite(datasetPath(dataDir), JSON.stringify({
      version: 1, generatedAt: now, sourceDir: src, recordCount: updatedRecords.length, records: updatedRecords,
    }));

    // Update the manifest: add the newly imported files and advance the tail model.
    const files = { ...manifest.files };
    for (const rel of newRel) {
      const st = fs.statSync(path.join(src, rel));
      files[rel] = { size: st.size, mtimeMs: st.mtimeMs, lastImportedAt: now };
    }
    atomicWrite(manifestPath(dataDir), serializeManifest({ version: MANIFEST_VERSION, lastModel: endModel, files }));

    return {
      rebuildRequired: false, newSources: newRel.length, changedSources: 0, unchangedSources: unchangedRel.length,
      missingSources: missingOnDisk.length, recordsAdded: records.length, recordsReplaced: 0, parsedFiles: newRel.length, timingBlocks,
    };
  })();

  // Clear the guard when the operation settles so the next refresh actually runs,
  // while concurrent callers during the run still share this single promise.
  inflight = op.then(
    (v) => { inflight = null; return v; },
    (e) => { inflight = null; throw e; },
  );
  return inflight;
}
