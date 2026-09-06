import { expect, it } from "vitest";
import { clusterConversations } from "../clustering.js";
import type { LinkEdge } from "../linker.js";

function clique(ids: string[], similarity = 1): LinkEdge[] {
  return ids.flatMap((a, index) => ids.slice(index + 1).map(b => ({ a, b, similarity })));
}

it("handles empty inputs and isolated nodes", () => {
  expect(clusterConversations([], [])).toEqual({
    assignments: new Map(), components: [], clusterCount: 0, stats: { largestCluster: 0, singletons: 0 },
  });
  expect(clusterConversations(["c", "a", "b"], [])).toEqual({
    assignments: new Map([["a", 0], ["b", 1], ["c", 2]]),
    components: [["a"], ["b"], ["c"]], clusterCount: 3, stats: { largestCluster: 1, singletons: 3 },
  });
});

it("keeps dense subgraphs separate across a weak bridge with deterministic canonical assignments", () => {
  const left = ["a", "b", "c", "d"];
  const right = ["e", "f", "g", "h"];
  const ids = [...left, ...right, "singleton"];
  const edges = [...clique(left), ...clique(right), { a: "d", b: "e", similarity: 0.01 }];
  const result = clusterConversations(ids, edges);
  expect(result.components).toEqual([left, right, ["singleton"]]);
  expect(result.stats).toEqual({ largestCluster: 4, singletons: 1 });
  expect(clusterConversations(ids, edges)).toEqual(result);
  const shuffledIds = ["h", "c", "a", "g", "singleton", "d", "b", "f", "e"];
  const shuffledEdges = [...edges].reverse().map(e => ({ ...e, a: e.b, b: e.a }));
  expect(clusterConversations(shuffledIds, shuffledEdges)).toEqual(result);
});

it("the normalized same-repo boost merges borderline groups that otherwise split", () => {
  const ids = [..."abcdefghij"];
  const edges = [
    { a: "a", b: "b", similarity: 0.2 }, { a: "b", b: "c", similarity: 0.06 },
    { a: "c", b: "d", similarity: 0.2 }, ...clique([..."efghij"], 0.2),
  ];
  const plain = clusterConversations(ids, edges);
  expect(plain.components).toContainEqual(["a", "b"]);
  expect(plain.components).toContainEqual(["c", "d"]);
  const repoMap = new Map([["a", " My-App "], ["b", "my-app"], ["c", "MY-APP"], ["d", "my-app"]]);
  const boosted = clusterConversations(ids, edges, repoMap);
  expect(boosted.components).toContainEqual(["a", "b", "c", "d"]);
  expect(clusterConversations(ids.reverse(), edges.reverse(), repoMap)).toEqual(boosted);
  expect(clusterConversations(ids, edges, new Map(ids.map(id => [id, "  "])))).toEqual(plain);
});

it("ignores edges outside the input node set and duplicate pairs", () => {
  const edges = [{ a: "a", b: "b", similarity: 0.9 }, { a: "c", b: "d", similarity: 0.9 }];
  const ids = [..."abcd"];
  expect(clusterConversations(ids, [...edges, edges[0]!, { a: "missing", b: "a", similarity: 1 }]))
    .toEqual(clusterConversations(ids, edges));
});
