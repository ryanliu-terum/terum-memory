import { normalizeRepo } from "./normalize-repo.js";

export const LINK_TOP_K = 10;
export const REPO_BACKBONE_K = 3;
export const REPO_BACKBONE_SIMILARITY = 0.5;

export interface LinkEdge { a: string; b: string; similarity: number }
interface EmbeddedRow { id: string; embedding: Float32Array }

export function cosineSimilarity(a: Float32Array | number[], b: Float32Array | number[]): number {
  if (a.length !== b.length) throw new Error("Embedding dimensions differ");
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

/** JSON tuple keys avoid collisions even when IDs contain delimiters. */
export function linkEdgeKey(a: string, b: string): string {
  return JSON.stringify(a < b ? [a, b] : [b, a]);
}

function selectEdges(rows: EmbeddedRow[], threshold: number, k: number, weight?: number): LinkEdge[] {
  if (!Number.isInteger(k) || k < 0) throw new Error("Neighbor count must be a nonnegative integer");
  const edges = new Map<string, LinkEdge>();
  for (const row of rows) {
    const neighbors = rows.filter(other => other.id !== row.id)
      .map(other => ({ id: other.id, similarity: cosineSimilarity(row.embedding, other.embedding) }))
      .filter(other => other.similarity >= threshold)
      .sort((a, b) => b.similarity - a.similarity || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, k);
    for (const other of neighbors) {
      const [a, b] = row.id < other.id ? [row.id, other.id] : [other.id, row.id];
      edges.set(linkEdgeKey(a, b), { a, b, similarity: weight ?? other.similarity });
    }
  }
  return [...edges.values()].sort((x, y) => x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
}

/** Top-K is per source; the undirected union can have degree greater than K. */
export function computeLinkEdges(rows: EmbeddedRow[], threshold: number, topK = LINK_TOP_K): LinkEdge[] {
  return selectEdges(rows, threshold, topK);
}

export function repoBackboneEdges(
  rows: Array<EmbeddedRow & { repo_name: string | null }>,
  k = REPO_BACKBONE_K,
  weight = REPO_BACKBONE_SIMILARITY,
): LinkEdge[] {
  const groups = new Map<string, EmbeddedRow[]>();
  for (const row of rows) {
    const repo = normalizeRepo(row.repo_name);
    if (repo === null) continue;
    const group = groups.get(repo) ?? [];
    group.push(row);
    groups.set(repo, group);
  }
  return [...groups.values()].flatMap(group => group.length < 2 ? [] : selectEdges(group, -Infinity, k, weight));
}
