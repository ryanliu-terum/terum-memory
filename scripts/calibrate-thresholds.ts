#!/usr/bin/env node
/**
 * Calibrate per-embedder similarity thresholds (maintainer tool; never runs in CI).
 *
 * The reference space is `text-embedding-3-small`, where the anchors were
 * benchmarked: 0.70 link/merge, 0.60 judge-low, 0.55 candidate floor. For each
 * supported local embedder this script embeds the SAME corpus under the
 * reference model and under the exact pinned local artifact (through the
 * product's own embed choke point, prefixes included), computes the pairwise
 * cosine distributions, and percentile-matches each reference anchor into the
 * local model's scale: the local threshold is the value that yields the same
 * edge density the reference anchor yields.
 *
 * Modes
 *   measure    embed the checked-in synthetic corpus and write
 *              fixtures/calibration-results.json (the CI drift gate compares it
 *              against src/engine/thresholds.ts and src/engine/models.ts).
 *   reconcile  embed a PRIVATE corpus (never committed) and compare its
 *              thresholds against the results file; with --apply, any anchor
 *              whose offset exceeds the tolerance is replaced by the private
 *              reading (the private corpus is the truth, the synthetic one is
 *              the publishable proxy). Only statistics are ever written.
 *
 * Requirements: `npm run build` first (imports from dist/), OPENAI_API_KEY for
 * the reference lane, network for the one-time model download, Node >= 22.6
 * (type stripping) or run through a TypeScript loader.
 *
 *   node scripts/calibrate-thresholds.ts measure
 *   node scripts/calibrate-thresholds.ts reconcile --corpus /private/real.jsonl [--apply]
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const distEngine = path.join(repo, "dist", "engine");
if (!fs.existsSync(path.join(distEngine, "embedder.js"))) {
  console.error("dist/ is missing: run `npm run build` first");
  process.exit(2);
}
const { createLocalEmbedder } = await import(path.join(distEngine, "embedder.js").replace(/\\/g, "/").replace(/^([A-Za-z]):/, "file:///$1:"));
const { knownEmbedders, manifestFor } = await import(path.join(distEngine, "models.js").replace(/\\/g, "/").replace(/^([A-Za-z]):/, "file:///$1:"));
const { REFERENCE_EMBEDDER } = await import(path.join(distEngine, "thresholds.js").replace(/\\/g, "/").replace(/^([A-Za-z]):/, "file:///$1:"));

const ANCHORS = { link: 0.7, merge: 0.7, judgeLow: 0.6, floor: 0.55 } as const;
const TOLERANCE = 0.02;
const MIN_NOTES = 200;
const DEFAULT_CORPUS = path.join("fixtures", "calibration-corpus", "synthetic.jsonl");
const DEFAULT_RESULTS = path.join("fixtures", "calibration-results.json");

interface Note { id: string; text: string }
interface Thresholds { link: number; rail: { merge: number; judgeLow: number; floor: number } }
interface EmbedderResult {
  revision: string; onnxFile: string; sha256: string; dim: number;
  spearman: number; distribution: { mean: number; sd: number }; thresholds: Thresholds;
}
interface Results {
  schema: 1;
  measuredAt: string;
  reference: { id: string; anchors: typeof ANCHORS; distribution: { mean: number; sd: number } };
  corpus: { path: string; sha256: string; notes: number; pairs: number; provenance: "synthetic" };
  densities: Record<keyof typeof ANCHORS, number>;
  embedders: Record<string, EmbedderResult>;
  reconciliation: null | {
    appliedAt: string; notes: number; corpusSha256: string; tolerance: number;
    offsets: Record<string, Record<keyof typeof ANCHORS, number>>;
    applied: Record<string, Array<keyof typeof ANCHORS>>;
  };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}
function flag(name: string): boolean { return process.argv.includes(name); }

function loadCorpus(file: string): { notes: Note[]; sha256: string } {
  const bytes = fs.readFileSync(file);
  const notes = bytes.toString("utf8").split(/\r?\n/).filter(Boolean).map((line, i) => {
    const row = JSON.parse(line) as Partial<Note>;
    if (typeof row.id !== "string" || typeof row.text !== "string" || !row.text.trim()) {
      throw new Error(`corpus line ${i + 1}: expected {id, text}`);
    }
    return { id: row.id, text: row.text };
  });
  if (new Set(notes.map(n => n.id)).size !== notes.length) throw new Error("corpus ids must be unique");
  return { notes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function cacheFile(kind: string, corpusSha: string): string {
  const dir = path.join(os.tmpdir(), "terum-memory-calibration");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${corpusSha.slice(0, 16)}.${kind}.json`);
}
function cached<T>(file: string, produce: () => Promise<T>): Promise<T> {
  if (fs.existsSync(file)) return Promise.resolve(JSON.parse(fs.readFileSync(file, "utf8")) as T);
  return produce().then(value => { fs.writeFileSync(file, JSON.stringify(value)); return value; });
}

async function referenceEmbeddings(texts: string[]): Promise<number[][]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is required for the reference lane");
  const out: number[][] = [];
  const BATCH = 50;
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: REFERENCE_EMBEDDER, input: batch, encoding_format: "float" }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`reference embeddings HTTP ${res.status}`);
    const json = await res.json() as { data: Array<{ index: number; embedding: number[] }> };
    for (const item of [...json.data].sort((a, b) => a.index - b.index)) out.push(item.embedding);
    process.stderr.write(`  reference ${Math.min(i + BATCH, texts.length)}/${texts.length}\r`);
  }
  process.stderr.write("\n");
  return out;
}

async function localEmbeddings(id: string, texts: string[], modelsDir: string): Promise<number[][]> {
  const manifest = manifestFor(id);
  const embedder = await createLocalEmbedder(manifest, { modelsDir });
  const out: number[][] = [];
  const STEP = 16;
  for (let i = 0; i < texts.length; i += STEP) {
    const vectors = await embedder.embed(texts.slice(i, i + STEP), "document");
    for (const v of vectors) out.push(Array.from(v));
    process.stderr.write(`  ${id} ${Math.min(i + STEP, texts.length)}/${texts.length}\r`);
  }
  process.stderr.write("\n");
  return out;
}

function normalize(v: number[]): number[] { const n = Math.hypot(...v); return v.map(x => x / n); }
function pairwise(vectors: number[][]): Float64Array {
  const V = vectors.map(normalize);
  const n = V.length;
  const sims = new Float64Array((n * (n - 1)) / 2);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const a = V[i]!;
    for (let j = i + 1; j < n; j++) {
      const b = V[j]!;
      let s = 0;
      for (let d = 0; d < a.length; d++) s += a[d]! * b[d]!;
      sims[k++] = s;
    }
  }
  return sims;
}
function sortedAsc(a: Float64Array): Float64Array { return Float64Array.from(a).sort(); }
/** Value at which the fraction of pairs >= value equals `density` (same estimator as the original experiment). */
function thresholdAtDensity(sorted: Float64Array, density: number): number {
  const q = 1 - density;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return round4(sorted[index]!);
}
function density(sims: Float64Array, anchor: number): number {
  let count = 0;
  for (const s of sims) if (s >= anchor) count++;
  return count / sims.length;
}
function stats(a: Float64Array): { mean: number; sd: number } {
  let sum = 0;
  for (const x of a) sum += x;
  const mean = sum / a.length;
  let sq = 0;
  for (const x of a) sq += (x - mean) ** 2;
  return { mean: round4(mean), sd: round4(Math.sqrt(sq / a.length)) };
}
function ranks(a: Float64Array): Float64Array {
  const idx = Array.from(a.keys()).sort((x, y) => a[x]! - a[y]!);
  const r = new Float64Array(a.length);
  idx.forEach((i, k) => { r[i] = k; });
  return r;
}
function spearman(a: Float64Array, b: Float64Array): number {
  const ra = ranks(a), rb = ranks(b);
  const m = (a.length - 1) / 2;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (ra[i]! - m) * (rb[i]! - m);
    da += (ra[i]! - m) ** 2;
    db += (rb[i]! - m) ** 2;
  }
  return round4(num / Math.sqrt(da * db));
}
function round4(x: number): number { return Math.round(x * 1e4) / 1e4; }

interface Measurement {
  corpusSha: string; notes: number; pairs: number;
  reference: { mean: number; sd: number };
  densities: Record<keyof typeof ANCHORS, number>;
  embedders: Record<string, EmbedderResult>;
}

async function measure(corpusFile: string, modelsDir: string): Promise<Measurement> {
  const { notes, sha256 } = loadCorpus(corpusFile);
  if (notes.length < MIN_NOTES) throw new Error(`corpus has ${notes.length} notes; need at least ${MIN_NOTES}`);
  const texts = notes.map(n => n.text);
  console.error(`corpus ${corpusFile}: ${notes.length} notes, sha256 ${sha256.slice(0, 12)}…`);

  console.error(`embedding: ${REFERENCE_EMBEDDER} (reference)`);
  const reference = await cached(cacheFile("reference", sha256), () => referenceEmbeddings(texts));
  const refSims = pairwise(reference);
  const densities = Object.fromEntries(
    Object.entries(ANCHORS).map(([name, anchor]) => [name, density(refSims, anchor)]),
  ) as Record<keyof typeof ANCHORS, number>;

  const embedders: Record<string, EmbedderResult> = {};
  for (const id of knownEmbedders()) {
    const manifest = manifestFor(id);
    console.error(`embedding: ${id} (${manifest.onnxFile} @ ${manifest.revision.slice(0, 8)})`);
    const vectors = await cached(cacheFile(`${id}.${manifest.sha256.slice(0, 12)}`, sha256), () => localEmbeddings(id, texts, modelsDir));
    const sims = pairwise(vectors);
    const sorted = sortedAsc(sims);
    const at = (name: keyof typeof ANCHORS) => thresholdAtDensity(sorted, densities[name]);
    embedders[id] = {
      revision: manifest.revision, onnxFile: manifest.onnxFile, sha256: manifest.sha256, dim: manifest.dim,
      spearman: spearman(refSims, sims), distribution: stats(sims),
      thresholds: { link: at("link"), rail: { merge: at("merge"), judgeLow: at("judgeLow"), floor: at("floor") } },
    };
  }
  return { corpusSha: sha256, notes: notes.length, pairs: refSims.length, reference: stats(refSims), densities, embedders };
}

function flatten(t: Thresholds): Record<keyof typeof ANCHORS, number> {
  return { link: t.link, merge: t.rail.merge, judgeLow: t.rail.judgeLow, floor: t.rail.floor };
}
function printTable(rows: string[][]): void {
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map(r => r[c]!.length)));
  for (const row of rows) console.log(row.map((cell, c) => cell.padEnd(widths[c]!)).join("  "));
}

const mode = process.argv[2];
const modelsDir = process.env.TERUM_CALIBRATION_MODELS_DIR ?? path.join(os.tmpdir(), "terum-memory-calibration", "models");
const resultsFile = path.resolve(repo, arg("--results") ?? DEFAULT_RESULTS);

if (mode === "measure") {
  const corpusRel = arg("--corpus") ?? DEFAULT_CORPUS;
  const m = await measure(path.resolve(repo, corpusRel), modelsDir);
  const results: Results = {
    schema: 1,
    measuredAt: new Date().toISOString(),
    reference: { id: REFERENCE_EMBEDDER, anchors: ANCHORS, distribution: m.reference },
    corpus: { path: corpusRel.replace(/\\/g, "/"), sha256: m.corpusSha, notes: m.notes, pairs: m.pairs, provenance: "synthetic" },
    densities: m.densities,
    embedders: m.embedders,
    reconciliation: null,
  };
  fs.writeFileSync(resultsFile, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`wrote ${path.relative(repo, resultsFile)}`);
  printTable([
    ["embedder", "spearman", "link", "merge", "judgeLow", "floor"],
    ...Object.entries(m.embedders).map(([id, e]) => {
      const t = flatten(e.thresholds);
      return [id, String(e.spearman), ...(["link", "merge", "judgeLow", "floor"] as const).map(k => String(t[k]))];
    }),
  ]);
  console.log("Next: copy these constants into src/engine/thresholds.ts (measuredAt + corpus sha256 included); the drift test enforces the match.");
} else if (mode === "reconcile") {
  const corpusFile = arg("--corpus");
  if (!corpusFile) { console.error("reconcile requires --corpus <private.jsonl>"); process.exit(2); }
  if (!fs.existsSync(resultsFile)) { console.error(`no results file at ${resultsFile}; run measure first`); process.exit(2); }
  const results = JSON.parse(fs.readFileSync(resultsFile, "utf8")) as Results;
  const m = await measure(path.resolve(corpusFile), modelsDir);
  const offsets: NonNullable<Results["reconciliation"]>["offsets"] = {};
  const applied: NonNullable<Results["reconciliation"]>["applied"] = {};
  const rows: string[][] = [["embedder", "anchor", "synthetic", "private", "offset", "verdict"]];
  for (const [id, priv] of Object.entries(m.embedders)) {
    const syn = results.embedders[id];
    if (!syn) throw new Error(`results file has no entry for ${id}; run measure first`);
    if (syn.sha256 !== priv.sha256 || syn.revision !== priv.revision) {
      throw new Error(`${id}: artifact pin changed since measure (results ${syn.sha256.slice(0, 12)}, now ${priv.sha256.slice(0, 12)}); rerun measure`);
    }
    const s = flatten(syn.thresholds), p = flatten(priv.thresholds);
    offsets[id] = { link: 0, merge: 0, judgeLow: 0, floor: 0 };
    applied[id] = [];
    for (const k of ["link", "merge", "judgeLow", "floor"] as const) {
      const offset = round4(s[k] - p[k]);
      offsets[id][k] = offset;
      const over = Math.abs(offset) > TOLERANCE;
      rows.push([id, k, String(s[k]), String(p[k]), String(offset), over ? "PRIVATE WINS" : "within tolerance"]);
      if (over && flag("--apply")) {
        applied[id].push(k);
        if (k === "link") syn.thresholds.link = p[k]; else syn.thresholds.rail[k] = p[k];
      }
    }
  }
  printTable(rows);
  console.log(`spearman (private corpus): ${Object.entries(m.embedders).map(([id, e]) => `${id}=${e.spearman}`).join(", ")}`);
  if (flag("--apply")) {
    results.reconciliation = {
      appliedAt: new Date().toISOString(), notes: m.notes, corpusSha256: m.corpusSha, tolerance: TOLERANCE, offsets, applied,
    };
    fs.writeFileSync(resultsFile, `${JSON.stringify(results, null, 2)}\n`);
    console.log(`applied private readings to ${path.relative(repo, resultsFile)} (statistics only; the private corpus stays where it is). Update src/engine/thresholds.ts to match.`);
  } else if (rows.some(r => r[5] === "PRIVATE WINS")) {
    console.log(`offsets above ${TOLERANCE} found; rerun with --apply to adopt the private readings.`);
    process.exitCode = 1;
  }
} else {
  console.error("usage: calibrate-thresholds.ts measure [--corpus F] [--results F] | reconcile --corpus F [--results F] [--apply]");
  process.exit(2);
}
