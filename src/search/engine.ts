import { getMeta, type Db } from "../db/open.js";
import type { Embedder } from "../engine/embedder-types.js";
import { cosineSimilarity } from "../engine/linker.js";

// Query recall uses a deliberately loose fixed floor, NOT thresholdsFor's
// embedder-calibrated link/decision thresholds used by M6/M7.
export const ANCHOR_THRESHOLD = 0.40;
export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 50;
export const LINK_NEIGHBOR_CAP = 400;

export interface SearchResult {
  kind: "note" | "decision";
  id: string;
  topic: string | null;
  summary: string | null;
  text: string;
  similarity: number;
  via: "anchor" | "link";
  decided_at?: string | null;
  provenance?: string;
}

export interface SearchOutput {
  results: SearchResult[];
  error?: string;
}

interface NoteRow { id: string; topic: string | null; summary: string | null; text: string }
interface DecisionRow extends NoteRow { decided_at: string | null; provenance: string }
interface VectorRow { embedding: Buffer }
interface Edge { a: string; b: string; similarity: number }

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function rank(a: SearchResult, b: SearchResult): number {
  return b.similarity - a.similarity ||
    (a.via === b.via ? 0 : a.via === "anchor" ? -1 : 1) || compareIds(a.id, b.id);
}

function clamp(limit: unknown): number {
  return typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0
    ? DEFAULT_SEARCH_LIMIT : Math.min(MAX_SEARCH_LIMIT, Math.floor(limit));
}

function similarity(query: Float32Array, bytes: Buffer): number {
  if (bytes.byteLength !== query.length * 4) throw new Error("Invalid stored vector dimension");
  const vector = Float32Array.from({ length: query.length }, (_, i) => bytes.readFloatLE(i * 4));
  if (!vector.every(Number.isFinite)) throw new Error("Invalid stored vector values");
  return cosineSimilarity(query, vector);
}

function search(db: Db, query: Float32Array, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  const noteAnchors = new Set<string>();
  const notes = db.prepare(`SELECT n.id, n.topic, n.summary, n.compacted_text AS text, v.embedding
    FROM notes n JOIN note_vec v ON v.note_id = n.id`).iterate() as Iterable<NoteRow & VectorRow>;
  for (const { embedding, ...note } of notes) {
    const score = similarity(query, embedding);
    if (score >= ANCHOR_THRESHOLD) {
      noteAnchors.add(note.id);
      results.push({ ...note, kind: "note", similarity: score, via: "anchor" });
    }
  }
  const decisions = db.prepare(`SELECT d.id, d.topic, d.reason AS summary, d.decision_text AS text,
    d.decided_at, d.provenance, v.embedding
    FROM decisions d JOIN decision_vec v ON v.decision_id = d.id`).iterate() as Iterable<DecisionRow & VectorRow>;
  for (const { embedding, ...decision } of decisions) {
    const score = similarity(query, embedding);
    if (score >= ANCHOR_THRESHOLD) {
      results.push({ ...decision, kind: "decision", similarity: score, via: "anchor" });
    }
  }

  if (noteAnchors.size > 0) {
    const neighbors = new Map<string, number>();
    const edges = db.prepare("SELECT a, b, similarity FROM links").iterate() as Iterable<Edge>;
    for (const edge of edges) {
      const aAnchor = noteAnchors.has(edge.a);
      const bAnchor = noteAnchors.has(edge.b);
      if (aAnchor === bAnchor) continue;
      if (!Number.isFinite(edge.similarity)) throw new Error("Invalid link similarity");
      const id = aAnchor ? edge.b : edge.a;
      neighbors.set(id, Math.max(neighbors.get(id) ?? -Infinity, edge.similarity));
    }
    // Select IDs before hydration; only original note anchors drive this one hop.
    const selected = [...neighbors].sort(([a, x], [b, y]) => y - x || compareIds(a, b))
      .slice(0, LINK_NEIGHBOR_CAP);
    const hydrate = db.prepare("SELECT id, topic, summary, compacted_text AS text FROM notes WHERE id = ?");
    for (const [id, score] of selected) {
      const note = hydrate.get(id) as NoteRow | undefined;
      if (!note) throw new Error("Missing linked note");
      results.push({ ...note, kind: "note", similarity: score, via: "link" });
    }
  }

  const seen = new Set<string>();
  return results.sort(rank).filter(result => {
    const key = JSON.stringify([result.kind, result.id]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, limit);
}

/** Read-only retrieval: no receipts, graph mutations, or progress markers. */
export async function runSearch(
  db: Db, query: string, deps: { embedder: Embedder }, opts: { limit?: number } = {},
): Promise<SearchOutput> {
  let embedding: Float32Array;
  try {
    const vectors = await deps.embedder.embed([query], "query");
    const dim = Number(getMeta(db, "embedder_dim"));
    const vector = vectors[0];
    if (!Number.isSafeInteger(dim) || dim <= 0 || deps.embedder.dim !== dim ||
        vectors.length !== 1 || !(vector instanceof Float32Array) || vector.length !== dim ||
        !vector.every(Number.isFinite)) {
      throw new Error("Invalid query embedding");
    }
    embedding = vector;
  } catch {
    return { results: [], error: "query embedding failed" };
  }

  try {
    return { results: search(db, embedding, clamp(opts.limit)) };
  } catch {
    return { results: [], error: "search failed" };
  }
}
