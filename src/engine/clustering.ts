import GraphImport from "graphology";
import louvainImport from "graphology-communities-louvain";
import { normalizeRepo } from "./normalize-repo.js";

// These packages expose runtime defaults with CommonJS-shaped declarations under NodeNext.
const Graph = GraphImport as unknown as typeof import("graphology").default;
const louvain = louvainImport as unknown as typeof import("graphology-communities-louvain").default;

const REPO_BOOST = 0.10;
const CLUSTER_SEED = 0x7e6d2b79;

function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ClusterResult {
  assignments: Map<string, number>;
  components: string[][];
  clusterCount: number;
  stats: { largestCluster: number; singletons: number };
}

interface Edge { a: string; b: string; similarity: number; }

export function clusterConversations(
  ids: string[],
  edges: Edge[],
  repoMap?: Map<string, string | null>,
): ClusterResult {
  if (ids.length === 0) {
    return { assignments: new Map(), components: [], clusterCount: 0, stats: { largestCluster: 0, singletons: 0 } };
  }
  const sortedIds = [...ids].sort();
  const edgeKey = (e: Edge): [string, string] => (e.a <= e.b ? [e.a, e.b] : [e.b, e.a]);
  const sortedEdges = [...edges].sort((x, y) => {
    const [xa, xb] = edgeKey(x);
    const [ya, yb] = edgeKey(y);
    return xa.localeCompare(ya) || xb.localeCompare(yb);
  });
  const graph = new Graph({ type: "undirected" });
  for (const id of sortedIds) graph.addNode(id);
  for (const edge of sortedEdges) {
    if (graph.hasNode(edge.a) && graph.hasNode(edge.b) && !graph.hasEdge(edge.a, edge.b)) {
      const repoA = normalizeRepo(repoMap?.get(edge.a));
      const repoB = normalizeRepo(repoMap?.get(edge.b));
      const sameRepo = repoA != null && repoA === repoB;
      const weight = sameRepo ? edge.similarity + REPO_BOOST : edge.similarity;
      graph.addEdge(edge.a, edge.b, { weight });
    }
  }
  const communities = louvain(graph, { resolution: 2.0, rng: seededRng(CLUSTER_SEED) });
  const componentMap = new Map<number, string[]>();
  for (const [nodeId, community] of Object.entries(communities)) {
    const comm = community as number;
    const members = componentMap.get(comm) ?? [];
    members.push(nodeId);
    componentMap.set(comm, members);
  }
  const sorted = [...componentMap.values()]
    .map(members => [...members].sort())
    .sort((a, b) => b.length - a.length || (a[0] ?? "").localeCompare(b[0] ?? ""));
  const assignments = new Map<string, number>();
  for (let i = 0; i < sorted.length; i++) for (const id of sorted[i]!) assignments.set(id, i);
  const singletons = sorted.filter(c => c.length === 1).length;
  return { assignments, components: sorted, clusterCount: sorted.length,
    stats: { largestCluster: sorted[0]?.length ?? 0, singletons } };
}
