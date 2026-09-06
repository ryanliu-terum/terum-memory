import { describe, expect, it } from "vitest";
import { knownEmbedders, manifestFor } from "../models.js";
import { REFERENCE_EMBEDDER, thresholdsFor } from "../thresholds.js";

describe("thresholds throw-on-placeholder contract", () => {
  it("reference embedder returns the benchmarked anchors", () => {
    const t = thresholdsFor(REFERENCE_EMBEDDER);
    expect(t.link).toBe(0.7);
    expect(t.rail).toEqual({ merge: 0.7, judgeLow: 0.6, floor: 0.55 });
  });

  it("unmeasured local embedders throw, they never return a guess", () => {
    expect(() => thresholdsFor("nomic-embed-text-v1")).toThrow(/TBD-by-script/);
    expect(() => thresholdsFor("all-MiniLM-L6-v2")).toThrow(/TBD-by-script/);
  });

  it("unknown embedder ids throw a distinct error", () => {
    expect(() => thresholdsFor("made-up-model")).toThrow(/unknown embedder/);
  });
});

describe("model artifact pin contract", () => {
  it("knows the two supported local embedders", () => {
    expect(knownEmbedders().sort()).toEqual(["all-MiniLM-L6-v2", "nomic-embed-text-v1"]);
  });

  it("unpinned artifacts throw, they never download unverified", () => {
    expect(() => manifestFor("nomic-embed-text-v1")).toThrow(/unmeasured placeholder/);
    expect(() => manifestFor("all-MiniLM-L6-v2")).toThrow(/unmeasured placeholder/);
  });

  it("unknown embedder ids throw a distinct error", () => {
    expect(() => manifestFor("made-up-model")).toThrow(/unknown embedder/);
  });
});
