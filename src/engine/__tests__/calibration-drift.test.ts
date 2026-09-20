/**
 * Two-piece drift gate (secretless, deterministic — CI never recomputes an embedding):
 *  1. the checked-in synthetic corpus still hashes to what the results file measured;
 *  2. the shipped constants in thresholds.ts and the artifact pins in models.ts equal
 *     what the results file recorded for every supported embedder.
 * If any of these drift, the calibration run must be redone (scripts/calibrate-thresholds.ts).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { knownEmbedders, manifestFor } from "../models.js";
import { REFERENCE_EMBEDDER, thresholdsFor } from "../thresholds.js";

const repo = path.resolve(__dirname, "..", "..", "..");
const resultsPath = path.join(repo, "fixtures", "calibration-results.json");

interface Results {
  schema: number;
  measuredAt: string;
  reference: { id: string; anchors: { link: number; merge: number; judgeLow: number; floor: number } };
  corpus: { path: string; sha256: string; notes: number; provenance: string };
  embedders: Record<string, {
    revision: string; onnxFile: string; sha256: string; dim: number; spearman: number;
    thresholds: { link: number; rail: { merge: number; judgeLow: number; floor: number } };
  }>;
  reconciliation: null | { corpusSha256: string; notes: number; applied: Record<string, string[]> };
}

const results = JSON.parse(fs.readFileSync(resultsPath, "utf8")) as Results;

describe("calibration drift gate", () => {
  it("results file is the schema this gate understands and was measured against the reference space", () => {
    expect(results.schema).toBe(1);
    expect(results.reference.id).toBe(REFERENCE_EMBEDDER);
    expect(results.reference.anchors).toEqual({ link: 0.7, merge: 0.7, judgeLow: 0.6, floor: 0.55 });
    expect(Date.parse(results.measuredAt)).not.toBeNaN();
  });

  it("checked-in corpus is synthetic, large enough, and unchanged since the measurement", () => {
    expect(results.corpus.provenance).toBe("synthetic");
    expect(results.corpus.notes).toBeGreaterThanOrEqual(200);
    const file = path.join(repo, results.corpus.path);
    const bytes = fs.readFileSync(file);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(results.corpus.sha256);
    const lines = bytes.toString("utf8").split(/\r?\n/).filter(Boolean);
    expect(lines).toHaveLength(results.corpus.notes);
    for (const line of lines) {
      const row = JSON.parse(line) as { id?: unknown; text?: unknown };
      expect(typeof row.id).toBe("string");
      expect(typeof row.text).toBe("string");
    }
  });

  it("covers exactly the supported local embedders", () => {
    expect(Object.keys(results.embedders).sort()).toEqual(knownEmbedders().sort());
  });

  it.each(knownEmbedders())("%s: shipped constants equal the measured results", (id) => {
    const measured = results.embedders[id]!;
    const shipped = thresholdsFor(id);
    expect(shipped.link).toBe(measured.thresholds.link);
    expect(shipped.rail).toEqual(measured.thresholds.rail);
    expect(shipped.measuredAt).toBe(results.measuredAt);
    expect(shipped.corpusSha256).toBe(results.corpus.sha256);
    for (const value of [shipped.link, shipped.rail.merge, shipped.rail.judgeLow, shipped.rail.floor]) {
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThan(1);
    }
    // The rail must keep its reference-space ordering: floor <= judgeLow < merge.
    expect(shipped.rail.floor).toBeLessThanOrEqual(shipped.rail.judgeLow);
    expect(shipped.rail.judgeLow).toBeLessThan(shipped.rail.merge);
  });

  it.each(knownEmbedders())("%s: artifact pin equals what was measured", (id) => {
    const measured = results.embedders[id]!;
    const manifest = manifestFor(id);
    expect(manifest.revision).toBe(measured.revision);
    expect(manifest.onnxFile).toBe(measured.onnxFile);
    expect(manifest.sha256).toBe(measured.sha256);
    expect(manifest.dim).toBe(measured.dim);
    expect(manifest.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rank agreement with the reference space is on record and not degenerate", () => {
    for (const [, measured] of Object.entries(results.embedders)) {
      expect(measured.spearman).toBeGreaterThan(0.5);
      expect(measured.spearman).toBeLessThanOrEqual(1);
    }
  });
});
