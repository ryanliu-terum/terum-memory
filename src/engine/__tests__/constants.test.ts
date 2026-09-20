import { describe, expect, it } from "vitest";
import { knownEmbedders, manifestFor } from "../models.js";
import { REFERENCE_EMBEDDER, thresholdsFor } from "../thresholds.js";

describe("thresholds throw-on-placeholder contract", () => {
  it("reference embedder returns the benchmarked anchors", () => {
    const t = thresholdsFor(REFERENCE_EMBEDDER);
    expect(t.link).toBe(0.7);
    expect(t.rail).toEqual({ merge: 0.7, judgeLow: 0.6, floor: 0.55 });
  });

  it("supported local embedders carry measured constants, never reference-space values verbatim", () => {
    for (const id of ["nomic-embed-text-v1", "all-MiniLM-L6-v2"]) {
      const t = thresholdsFor(id);
      expect(t.measuredAt).not.toBe("benchmarked-reference");
      expect(t.corpusSha256).toMatch(/^[0-9a-f]{64}$/);
      // A local model's scale differs from the reference; identical anchors would mean a copy, not a measurement.
      expect(t.rail).not.toEqual({ merge: 0.7, judgeLow: 0.6, floor: 0.55 });
    }
  });

  it("unknown embedder ids throw a distinct error", () => {
    expect(() => thresholdsFor("made-up-model")).toThrow(/unknown embedder/);
  });
});

describe("model artifact pin contract", () => {
  it("knows the two supported local embedders", () => {
    expect(knownEmbedders().sort()).toEqual(["all-MiniLM-L6-v2", "nomic-embed-text-v1"]);
  });

  it("supported artifacts are pinned by exact revision and sha256", () => {
    for (const id of ["nomic-embed-text-v1", "all-MiniLM-L6-v2"]) {
      const m = manifestFor(id);
      expect(m.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(m.onnxFile).toMatch(/\.onnx$/);
    }
  });

  it("unknown embedder ids throw a distinct error", () => {
    expect(() => manifestFor("made-up-model")).toThrow(/unknown embedder/);
  });
});
