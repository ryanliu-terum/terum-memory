import { randomUUID } from "node:crypto";
import { getMeta, type Db } from "../db/open.js";
import type { Embedder } from "../engine/embedder-types.js";
import { cosineSimilarity } from "../engine/linker.js";
import { thresholdsFor } from "../engine/thresholds.js";
import { decodeVector, embedOne } from "./internal.js";

export const CHECK_CANDIDATE_CAP = 40;
export const DEFAULT_STANDING_LIMIT = 20;
export const MAX_STANDING_LIMIT = 50;
export const STANDING_TOPIC_CAP = 200;

export interface StandingDecision {
  decision_id: string;
  decision_text: string;
  topic: string | null;
  provenance: "distilled" | "ratified";
  decided_at: string | null;
}
export interface CheckCandidate extends StandingDecision {
  reason: string | null;
  similarity: number;
}
export interface CheckResult { candidates: CheckCandidate[]; error?: string }
export interface StandingResult { decisions: StandingDecision[]; error?: string }
export interface ReadDeps { embedder: Embedder; now?: () => Date }
export interface StandingOptions { topic?: string; limit?: number }

const FIELDS = "d.id AS decision_id, d.decision_text, d.topic, d.provenance, d.decided_at";

function relevant(db: Db, embedding: Float32Array, floor: number): CheckCandidate[] {
  const rows = db.prepare(`SELECT ${FIELDS}, d.reason, v.embedding
    FROM decisions d JOIN decision_vec v ON v.decision_id = d.id ORDER BY d.id`).all() as
    Array<StandingDecision & { reason: string | null; embedding: Buffer }>;
  return rows.map(({ embedding: bytes, ...row }) => ({
    ...row, similarity: cosineSimilarity(embedding, decodeVector(bytes)),
  })).filter(row => row.similarity >= floor).sort((a, b) => b.similarity - a.similarity);
}

export async function runCheckDecision(db: Db, statement: string, deps: ReadDeps): Promise<CheckResult> {
  // Placeholder errors intentionally propagate; only embedding failures become
  // the fail-closed embedding result. Never substitute reference constants.
  const rail = thresholdsFor(getMeta(db, "embedder_id") ?? "").rail;
  let embedding: Float32Array;
  try {
    embedding = await embedOne(db, deps.embedder, statement, "query");
  } catch {
    return { candidates: [], error: "embedding failed" };
  }
  const candidates = relevant(db, embedding, rail.floor).slice(0, CHECK_CANDIDATE_CAP);
  db.transaction(() => {
    db.prepare("INSERT INTO receipts (id, statement, surfaced_ids, surfaced_at) VALUES (?, ?, ?, ?)")
      .run(randomUUID(), statement, JSON.stringify(candidates.map(row => row.decision_id)),
        (deps.now ?? (() => new Date()))().toISOString());
  }).immediate();
  return { candidates };
}

function clamp(limit: unknown): number {
  return typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0 ?
    DEFAULT_STANDING_LIMIT : Math.min(MAX_STANDING_LIMIT, Math.floor(limit));
}

function recentFirst(a: StandingDecision, b: StandingDecision): number {
  if (a.decided_at === b.decided_at) return 0;
  if (a.decided_at === null) return 1;
  if (b.decided_at === null) return -1;
  return a.decided_at > b.decided_at ? -1 : 1;
}

export async function runGetStandingDecisions(
  db: Db, opts: StandingOptions, deps: ReadDeps,
): Promise<StandingResult> {
  const limit = clamp(opts.limit);
  if (opts.topic === undefined) {
    return { decisions: db.prepare(`SELECT ${FIELDS} FROM decisions d
      ORDER BY d.decided_at DESC NULLS LAST, d.id LIMIT ?`).all(limit) as StandingDecision[] };
  }
  const rail = thresholdsFor(getMeta(db, "embedder_id") ?? "").rail;
  let embedding: Float32Array;
  try {
    embedding = await embedOne(db, deps.embedder, opts.topic, "query");
  } catch {
    return { decisions: [], error: "embedding failed" };
  }
  return {
    decisions: relevant(db, embedding, rail.floor).slice(0, STANDING_TOPIC_CAP)
      .sort(recentFirst).slice(0, limit)
      .map(({ decision_id, decision_text, topic, provenance, decided_at }) =>
        ({ decision_id, decision_text, topic, provenance, decided_at })),
  };
}
