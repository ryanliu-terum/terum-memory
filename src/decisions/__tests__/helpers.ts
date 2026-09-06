import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, vi, type Mock } from "vitest";
import { createVecTables, openDb, setMeta, type Db } from "../../db/open.js";
import type { Embedder } from "../../engine/embedder-types.js";
import { REFERENCE_EMBEDDER } from "../../engine/thresholds.js";
import type { ChatBackend } from "../../llm/backend.js";
import { decisionContentHash } from "../hash.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

export const NOW = "2026-04-01T00:00:00.000Z";
export const axis = new Float32Array([1, 0, 0]);
export function vector(similarity: number): Float32Array {
  return new Float32Array([similarity, Math.sqrt(1 - similarity ** 2), 0]);
}

interface Fixture {
  db: Db;
  connect: () => Db;
  embed: Mock<Embedder["embed"]>;
  completeJSON: Mock<ChatBackend["completeJSON"]>;
  deps: {
    embedder: { id: string; dim: number; embed: Mock<Embedder["embed"]> };
    backend: { modelId: string; completeJSON: Mock<ChatBackend["completeJSON"]> };
    now: () => Date;
  };
}

export function fixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "decision-rail-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const connect = (): Db => {
    const db = openDb({ dbPath: path.join(dir, "memory.db"), warn: () => undefined });
    cleanups.push(() => db.close());
    return db;
  };
  const db: Db = connect();
  db.transaction(() => {
    createVecTables(db, 3);
    setMeta(db, "embedder_id", REFERENCE_EMBEDDER);
    setMeta(db, "embedder_dim", "3");
  })();
  const embed = vi.fn<Embedder["embed"]>(async texts => texts.map(() => axis));
  const completeJSON = vi.fn<ChatBackend["completeJSON"]>(async () => '{"verdict":"same_decision"}');
  const deps = {
    embedder: { id: REFERENCE_EMBEDDER, dim: 3, embed },
    backend: { modelId: "fake", completeJSON },
    now: () => new Date(NOW),
  };
  return { db, connect, deps, embed, completeJSON };
}

export function seed(db: Db, opts: {
  id?: string; text?: string; embedding?: Float32Array; decidedAt?: string; createdAt?: string;
  provenance?: "distilled" | "ratified"; origin?: "local" | "ledger"; quote?: string;
  withVector?: boolean;
} = {}): string {
  const id = opts.id ?? randomUUID();
  const text = opts.text ?? `Decision ${id}`;
  db.transaction(() => {
    const noteId = opts.provenance === "distilled" ? randomUUID() : null;
    if (noteId) db.prepare(`INSERT INTO notes (id, site, conversation_id, turn_count,
      compacted_text, model_used, first_captured_at, last_captured_at, distilled_at)
      VALUES (?, 'test', ?, 1, 'note', 'fake', ?, ?, ?)`)
      .run(noteId, noteId, NOW, NOW, NOW);
    db.prepare(`INSERT INTO decisions (id, note_id, decision_text, reason, topic, content_hash,
      provenance, human_quote, origin, decided_at, created_at)
      VALUES (?, ?, ?, 'because', 'storage', ?, ?, ?, ?, ?, ?)`)
      .run(id, noteId, text, decisionContentHash(text), opts.provenance ?? "ratified",
        opts.quote ?? "first quote", opts.origin ?? "local", opts.decidedAt ?? NOW, opts.createdAt ?? NOW);
    if (opts.withVector !== false) db.prepare("INSERT INTO decision_vec (decision_id, embedding) VALUES (?, ?)")
      .run(id, opts.embedding ?? axis);
  })();
  return id;
}

export function rows(db: Db, table: "decisions" | "decision_vec" | "receipts") {
  return db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
}
