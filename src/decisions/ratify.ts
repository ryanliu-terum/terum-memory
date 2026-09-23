import { randomUUID } from "node:crypto";
import { getMeta, type Db } from "../db/open.js";
import type { Embedder } from "../engine/embedder-types.js";
import { cosineSimilarity } from "../engine/linker.js";
import { scrubSecrets } from "../engine/secret-scrub.js";
import { thresholdsFor } from "../engine/thresholds.js";
import type { ChatBackend } from "../llm/backend.js";
import { effectiveRail, makeDedupJudge, selectDedupCandidate, type DedupCandidate } from "./dedup.js";
import { decisionContentHash } from "./hash.js";
import { decodeVector, embedOne } from "./internal.js";

export interface RatifyInput {
  decision_text: string;
  reason?: string;
  topic?: string;
  human_confirmed?: boolean;
  human_confirmation_quote?: string;
}

export type RatifyResult =
  | { ok: true; decisionId: string; merged: boolean }
  | { ok: false; error: string };

export interface RatifyDeps {
  embedder: Embedder;
  backend: ChatBackend;
  now?: () => Date;
}

interface StoredCandidate extends Omit<DedupCandidate, "embedding"> {
  embedding: Buffer;
}
interface Winner {
  id: string;
  provenance: "distilled" | "ratified";
  content_hash: string;
}

export async function ratifyDecision(db: Db, input: RatifyInput, deps: RatifyDeps): Promise<RatifyResult> {
  if (input.human_confirmed !== true || typeof input.human_confirmation_quote !== "string" ||
      !input.human_confirmation_quote.trim()) {
    return { ok: false, error: "ratify_decision requires an explicit human confirmation and non-blank verbatim quote" };
  }
  const decisionText = scrubSecrets(input.decision_text);
  const quote = scrubSecrets(input.human_confirmation_quote);
  const reason = input.reason === undefined ? null : scrubSecrets(input.reason);
  const topic = input.topic === undefined ? null : scrubSecrets(input.topic);
  const contentHash = decisionContentHash(decisionText);
  const rail = effectiveRail(thresholdsFor(getMeta(db, "embedder_id") ?? "").rail);
  let embedding: Float32Array;
  try {
    embedding = await embedOne(db, deps.embedder, decisionText, "document");
  } catch {
    return { ok: false, error: "embedding failed" };
  }
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const candidates = (db.prepare(`
    SELECT d.id, d.decision_text, d.content_hash, d.decided_at, d.created_at, v.embedding
    FROM decisions d JOIN decision_vec v ON v.decision_id = d.id WHERE d.origin = 'local'
  `).all() as StoredCandidate[]).map(row => ({ ...row, embedding: decodeVector(row.embedding) }));
  const selected = await selectDedupCandidate(
    { decisionText, contentHash, embedding, decidedAt: now }, candidates, rail, makeDedupJudge(deps.backend),
  );

  return db.transaction((): RatifyResult => {
    // Exact hashes outrank a stale semantic selection. Stable sorting preserves
    // the SQL creation/id order when cosine ties; even vector-less rows qualify.
    const exact = db.prepare(`
      SELECT d.id, d.provenance, d.content_hash, v.embedding
      FROM decisions d LEFT JOIN decision_vec v ON v.decision_id = d.id
      WHERE d.origin = 'local' AND d.content_hash = ? ORDER BY d.created_at, d.id
    `).all(contentHash) as Array<Winner & { embedding: Buffer | null }>;
    const winner = exact.map(row => ({
      ...row, similarity: row.embedding ? cosineSimilarity(embedding, decodeVector(row.embedding)) : 0,
    })).sort((a, b) => b.similarity - a.similarity)[0] ?? (selected.candidate ?
      db.prepare("SELECT id, provenance, content_hash FROM decisions WHERE id = ? AND origin = 'local'")
        .get(selected.candidate.id) as Winner | undefined : undefined);
    if (winner) {
      // Same-hash retries/races retain the first ratification's audit quote.
      if (winner.provenance === "distilled" || winner.content_hash !== contentHash) {
        db.prepare("UPDATE decisions SET provenance = 'ratified', human_quote = ? WHERE id = ?")
          .run(quote, winner.id);
      }
      return { ok: true, decisionId: winner.id, merged: true };
    }
    const id = randomUUID();
    try {
      db.prepare(`
        INSERT INTO decisions (id, note_id, decision_text, reason, topic, content_hash,
          provenance, human_quote, origin, decided_at, created_at)
        VALUES (?, NULL, ?, ?, ?, ?, 'ratified', ?, 'local', ?, ?)
      `).run(id, decisionText, reason, topic, contentHash, quote, now, now);
    } catch (error) {
      if (error !== null && typeof error === "object" && "code" in error &&
          error.code === "SQLITE_CONSTRAINT_UNIQUE") {
        const existing = db.prepare(`
          SELECT id FROM decisions WHERE content_hash = ? AND note_id IS NULL AND origin = 'local'
        `).get(contentHash) as { id: string } | undefined;
        if (existing) return { ok: true, decisionId: existing.id, merged: true };
      }
      throw error;
    }
    db.prepare("INSERT INTO decision_vec (decision_id, embedding) VALUES (?, ?)")
      .run(id, Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength));
    return { ok: true, decisionId: id, merged: false };
  }).immediate();
}
