import { createVecTables, getMeta, setMeta, type Db } from "../db/open.js";
import { completeJob, enqueueCoalesced, failJob, renewLease, type JobClaim } from "../jobs/queue.js";
import type { Embedder } from "./embedder-types.js";
import { manifestFor } from "./models.js";

export interface ReembedDeps {
  embedderFor: (id: string) => Promise<Embedder>;
  now?: () => Date;
}
export interface ReembedResult {
  status: "done" | "stale" | "requeued" | "dead-letter";
  error?: string;
}

// Operational batch size, independent of any model calibration.
const BATCH_SIZE = 64;
const tables = [
  { source: "notes", text: "compacted_text", real: "note_vec", shadow: "note_vec_new", key: "note_id" },
  { source: "decisions", text: "decision_text", real: "decision_vec", shadow: "decision_vec_new", key: "decision_id" },
] as const;

export function reembedTarget(claim: JobClaim): string {
  const payload = claim.payload;
  if (claim.kind !== "reembed" || typeof payload !== "object" || payload === null ||
      !("targetEmbedderId" in payload) || typeof payload.targetEmbedderId !== "string" ||
      !payload.targetEmbedderId.trim()) throw new Error("Expected reembed payload { targetEmbedderId: string }");
  return payload.targetEmbedderId;
}

function dropShadows(db: Db): void {
  for (const table of tables) db.exec(`DROP TABLE IF EXISTS ${table.shadow}`);
}

/** Shadow rows are the durable cursor. Only the fenced completion changes the lock and real vectors. */
export async function runReembedJob(db: Db, claim: JobClaim, deps: ReembedDeps): Promise<ReembedResult> {
  try {
    const target = reembedTarget(claim);
    // Check the token before reading phase state: another worker may already have swapped.
    if (!renewLease(db, claim, deps)) return { status: "stale" };
    if (getMeta(db, "embedder_id") === target) {
      const hasShadows = tables.some(table => db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get(table.shadow));
      const completed = completeJob(db, claim, tx => {
        if (hasShadows) {
          dropShadows(tx);
          enqueueCoalesced(tx, "link-cluster", {}, deps);
        }
      }, deps);
      return { status: completed ? "done" : "stale" };
    }

    const { dim } = manifestFor(target);
    if (!Number.isSafeInteger(dim) || dim <= 0) throw new Error("Invalid target embedding dimension");
    const embedder = await deps.embedderFor(target);
    if (embedder.id !== target || embedder.dim !== dim) throw new Error("Target embedder does not match its manifest");
    const prepared = db.transaction(() => {
      if (!renewLease(db, claim, deps)) return false;
      for (const table of tables) db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${table.shadow}
        USING vec0(${table.key} TEXT PRIMARY KEY, embedding float[${dim}])`);
      return true;
    }).immediate();
    if (!prepared) return { status: "stale" };

    for (;;) {
      for (const table of tables) {
        for (;;) {
          if (!renewLease(db, claim, deps)) return { status: "stale" };
          const rows = db.prepare(`SELECT id, ${table.text} AS text FROM ${table.source} AS source
            WHERE NOT EXISTS (SELECT 1 FROM ${table.shadow} AS shadow WHERE shadow.${table.key} = source.id)
            ORDER BY id LIMIT ?`).all(BATCH_SIZE) as Array<{ id: string; text: string }>;
          if (!rows.length) break;
          // Inference must never hold SQLite's write lock, including across awaits.
          const vectors = await embedder.embed(rows.map(row => row.text), "document");
          if (vectors.length !== rows.length || vectors.some(vector =>
            !(vector instanceof Float32Array) || vector.length !== dim || !vector.every(Number.isFinite))) {
            throw new Error("Invalid reembed batch: expected one finite target-dimension vector per row");
          }
          const inserted = db.transaction(() => {
            if (!renewLease(db, claim, deps)) return false;
            const insert = db.prepare(`INSERT INTO ${table.shadow} (${table.key}, embedding) VALUES (?, ?)`);
            rows.forEach((row, index) => insert.run(row.id, Buffer.from(vectors[index]!.buffer,
              vectors[index]!.byteOffset, vectors[index]!.byteLength)));
            return true;
          }).immediate();
          if (!inserted) return { status: "stale" };
        }
      }

      const result = db.transaction(() => {
        if (!renewLease(db, claim, deps)) return "stale";
        for (const table of tables) {
          // Exact set reconciliation under the write lock, not a row-count compare: a source row
          // deleted and another inserted between batches (distill replaces decisions this way) keeps
          // the counts equal while leaving one row unembedded and one shadow row orphaned.
          const { missing } = db.prepare(`SELECT count(*) AS missing FROM ${table.source} AS source
            WHERE NOT EXISTS (SELECT 1 FROM ${table.shadow} AS shadow WHERE shadow.${table.key} = source.id)`)
            .get() as { missing: number };
          if (missing > 0) return "incomplete";
        }
        const completed = completeJob(db, claim, tx => {
          // vec0 cannot reliably ALTER RENAME. Re-create and copy under one write transaction.
          for (const table of tables) tx.exec(`DROP TABLE ${table.real}`);
          createVecTables(tx, dim);
          // Orphaned shadow rows (source row gone since it was embedded) are pruned by the join.
          for (const table of tables) tx.exec(`INSERT INTO ${table.real} (${table.key}, embedding)
            SELECT shadow.${table.key}, shadow.embedding FROM ${table.shadow} AS shadow
            WHERE EXISTS (SELECT 1 FROM ${table.source} AS source WHERE source.id = shadow.${table.key})`);
          setMeta(tx, "embedder_id", target);
          setMeta(tx, "embedder_dim", String(dim));
          dropShadows(tx);
          enqueueCoalesced(tx, "link-cluster", {}, deps);
        }, deps);
        return completed ? "done" : "stale";
      }).immediate();
      if (result !== "incomplete") return { status: result };
    }
  } catch (error) {
    return { status: failJob(db, claim, error, deps), error: error instanceof Error ? error.message : String(error) };
  }
}
