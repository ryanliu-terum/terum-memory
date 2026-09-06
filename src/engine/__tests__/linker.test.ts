import { describe, expect, it } from "vitest";
import { normalizeRepo } from "../normalize-repo.js";
import {
  computeLinkEdges, cosineSimilarity, LINK_TOP_K, REPO_BACKBONE_K,
  REPO_BACKBONE_SIMILARITY, repoBackboneEdges,
} from "../linker.js";

const row = (id: string, values: number[], repo_name: string | null = null) =>
  ({ id, embedding: new Float32Array(values), repo_name });

it.each([
  [null, null], [undefined, null], ["", null], [" \t\n", null],
  ["  Org/APP  ", "org/app"], ["a/b/", "a/b/"],
])("normalizes repository %j to %j", (input, expected) => {
  expect(normalizeRepo(input)).toBe(expected);
});

describe("cosine", () => {
  it.each([
    [[1, 0], [1, 0], 1], [[1, 0], [0, 1], 0], [[1, 0], [-1, 0], -1],
    [[3, 4], [5, 0], 0.6], [[0, 0], [3, 4], 0], [[], [], 0],
  ])("computes %j against %j", (a, b, expected) => {
    expect(cosineSimilarity(a, new Float32Array(b))).toBe(expected);
    expect(cosineSimilarity(new Float32Array(b), a)).toBe(expected);
  });
  it("rejects mismatched dimensions instead of silently truncating", () => {
    expect(() => cosineSimilarity([1], [1, 2])).toThrow("dimensions");
  });
});

describe("threshold links", () => {
  it("includes the threshold boundary, excludes lower similarities, and deduplicates mutual neighbors", () => {
    const rows = [row("z", [3, 4]), row("a", [1, 0]), row("b", [-1, 0])];
    expect(computeLinkEdges(rows, 0.6)).toEqual([{ a: "a", b: "z", similarity: 0.6 }]);
    expect(computeLinkEdges(rows, 0.60001)).toEqual([]);
  });
  it("caps choices per source, unions incoming choices, and resolves similarity ties by ID", () => {
    const rows = ["d", "b", "a", "c"].map(id => row(id, [1, 0]));
    const expected = ["b", "c", "d"].map(b => ({ a: "a", b, similarity: 1 }));
    expect(computeLinkEdges(rows, 1, 1)).toEqual(expected);
    expect(computeLinkEdges(rows.reverse(), 1, 1)).toEqual(expected);
    expect(computeLinkEdges(rows, 1, 0)).toEqual([]);
  });
  it("uses the default top ten and preserves IDs with delimiter-like content", () => {
    expect(LINK_TOP_K).toBe(10);
    const rows = Array.from({ length: 12 }, (_, i) => row(String(i).padStart(2, "0"), [1, 0]));
    expect(computeLinkEdges(rows, 1)).toHaveLength(65);
    const unusual = ["a", "a|b", "b|c", "c"].map(id => row(id, [1]));
    expect(computeLinkEdges(unusual, 1)).toHaveLength(6);
    expect(computeLinkEdges([], 0)).toEqual([]);
    expect(computeLinkEdges([row("alone", [1])], 0)).toEqual([]);
  });
});

describe("repository backbone", () => {
  it("groups normalized identities, excludes null/blank repos, and uses fixed sub-threshold weight", () => {
    const rows = [row("b", [1, 0], " APP "), row("a", [-1, 0], "app"),
      row("c", [1, 0], "other"), row("d", [1, 0]), row("e", [1, 0], "  ")];
    expect(repoBackboneEdges(rows)).toEqual([{ a: "a", b: "b", similarity: 0.5 }]);
    expect(repoBackboneEdges(rows, 3, 0.2)).toEqual([{ a: "a", b: "b", similarity: 0.2 }]);
    expect(REPO_BACKBONE_K).toBe(3);
    expect(REPO_BACKBONE_SIMILARITY).toBe(0.5);
  });
  it("selects closest siblings with a per-source cap and deduplicates", () => {
    const rows = [row("a", [1, 0], "r"), row("b", [1, 0], "R"),
      row("c", [-1, 0], "r"), row("d", [-1, 0], "r")];
    expect(repoBackboneEdges(rows, 1)).toEqual([
      { a: "a", b: "b", similarity: 0.5 }, { a: "c", b: "d", similarity: 0.5 },
    ]);
    expect(repoBackboneEdges(rows, 0)).toEqual([]);
    expect(repoBackboneEdges(rows)).toHaveLength(6);
    expect(repoBackboneEdges([])).toEqual([]);
  });
  it.each([-1, 1.5, NaN])("rejects invalid K %s", k => {
    const rows = [row("a", [1], "r"), row("b", [1], "r")];
    expect(() => repoBackboneEdges(rows, k)).toThrow("Neighbor count");
    expect(() => computeLinkEdges(rows, 0, k)).toThrow("Neighbor count");
  });
});
