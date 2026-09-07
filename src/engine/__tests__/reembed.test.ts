import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVecTables, getMeta, openDb, setMeta, type Db } from "../../db/open.js";
import { claimNext, enqueueJob, type JobClaim } from "../../jobs/queue.js";
import * as queue from "../../jobs/queue.js";
import * as models from "../models.js";
import type { Embedder } from "../embedder-types.js";
import { runReembedJob } from "../reembed.js";
import { dispatchClaim, type Runtime } from "../../worker/dispatch.js";

const cleanups: Array<() => void> = [];
const now = () => new Date("2026-01-01T00:00:00Z");
const later = () => new Date("2026-01-01T01:00:00Z");
const manifest: models.EmbedderManifest = {
  id: "new", dim: 3, hfRepo: "fake", revision: "test", sha256: "test", onnxFile: "model.onnx",
  pooling: "mean", l2Normalize: false, maxTokens: 10, truncation: "tail", prefixes: null,
};
function vector(text: string, dim: number) {
  return Float32Array.from({ length: dim }, (_, i) => text.length + i + text.charCodeAt(i % text.length) / 128);
}
function fake(): Embedder {
  return { id: "new", dim: 3, embed: vi.fn(async (texts: string[]) => texts.map(text => vector(text, 3))) };
}
beforeEach(() => {
  const original = models.manifestFor;
  vi.spyOn(models, "manifestFor").mockImplementation(id => id === "new" ? manifest : original(id));
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture(noteCount = 3, decisionCount = 2) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "reembed-test-"));
  vi.stubEnv("TERUM_HOME", home);
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  const db = openDb({ dbPath: path.join(home, "memory.db") });
  cleanups.push(() => db.close());
  db.transaction(() => {
    createVecTables(db, 4); setMeta(db, "embedder_id", "old"); setMeta(db, "embedder_dim", "4");
    for (let i = 0; i < noteCount; i++) {
      const id = `n${String(i).padStart(3, "0")}`, text = `note ${i}`;
      db.prepare(`INSERT INTO notes (id, site, conversation_id, turn_count, compacted_text, model_used,
        first_captured_at, last_captured_at, distilled_at) VALUES (?, 'test', ?, 1, ?, 'chat', 't', 't', 't')`).run(id, id, text);
      db.prepare("INSERT INTO note_vec VALUES (?, ?)").run(id, Buffer.from(vector(text, 4).buffer));
    }
    for (let i = 0; i < decisionCount; i++) {
      const id = `d${i}`, text = `decision ${i}`;
      db.prepare(`INSERT INTO decisions (id, decision_text, content_hash, provenance, decided_at, created_at)
        VALUES (?, ?, ?, 'distilled', 't', 't')`).run(id, text, id);
      db.prepare("INSERT INTO decision_vec VALUES (?, ?)").run(id, Buffer.from(vector(text, 4).buffer));
    }
  }).immediate();
  const id = enqueueJob(db, "reembed", { targetEmbedderId: "new" }, { now });
  const claim = claimNext(db, { now })!;
  return { db, claim, id };
}
function shadows(db: Db) {
  db.transaction(() => db.exec(`CREATE VIRTUAL TABLE note_vec_new USING vec0(note_id TEXT PRIMARY KEY, embedding float[3]);
    CREATE VIRTUAL TABLE decision_vec_new USING vec0(decision_id TEXT PRIMARY KEY, embedding float[3]);`))();
}
function count(db: Db, table: string): number {
  return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}
function assertSpace(db: Db, id: "old" | "new") {
  const dim = id === "old" ? 4 : 3;
  expect(getMeta(db, "embedder_id")).toBe(id); expect(getMeta(db, "embedder_dim")).toBe(String(dim));
  for (const [source, text, table, key] of [
    ["notes", "compacted_text", "note_vec", "note_id"],
    ["decisions", "decision_text", "decision_vec", "decision_id"],
  ]) {
    const rows = db.prepare(`SELECT s.${text} AS text, v.embedding FROM ${source} s JOIN ${table} v ON s.id = v.${key}`).all() as
      Array<{ text: string; embedding: Buffer }>;
    expect(rows).toHaveLength(count(db, source!));
    for (const row of rows) expect(row.embedding).toEqual(Buffer.from(vector(row.text, dim).buffer));
    expect((db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(table) as { sql: string }).sql).toContain(`float[${dim}]`);
  }
}
function assertDone(db: Db) {
  assertSpace(db, "new");
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('note_vec_new', 'decision_vec_new')").all()).toEqual([]);
  expect(db.prepare("SELECT status FROM jobs WHERE kind = 'reembed'").get()).toEqual({ status: "done" });
  expect(count(db, "jobs WHERE kind = 'link-cluster'")).toBe(1);
}

describe("reembed protocol", () => {
  it("atomically switches dimensions and vectors, preserving source rows and coalescing graph work", async () => {
    const { db, claim } = fixture(); const embedder = fake();
    const notes = db.prepare("SELECT * FROM notes").all(), decisions = db.prepare("SELECT * FROM decisions").all();
    enqueueJob(db, "link-cluster", {}, { now });
    expect(await runReembedJob(db, claim, { embedderFor: async () => embedder, now })).toEqual({ status: "done" });
    assertDone(db); expect(db.prepare("SELECT * FROM notes").all()).toEqual(notes);
    expect(db.prepare("SELECT * FROM decisions").all()).toEqual(decisions);
    expect(embedder.embed).toHaveBeenNthCalledWith(1, ["note 0", "note 1", "note 2"], "document");
    expect(embedder.embed).toHaveBeenNthCalledWith(2, ["decision 0", "decision 1"], "document");
  });

  it("keeps the old space readable after interruption, then resumes the durable shadow cursor", async () => {
    const { db, claim } = fixture(); let calls = 0;
    const embedder = fake(); embedder.embed = async texts => {
      expect(db.inTransaction).toBe(false);
      if (++calls === 2) throw new Error("interrupted before swap");
      return texts.map(text => vector(text, 3));
    };
    expect((await runReembedJob(db, claim, { embedderFor: async () => embedder, now })).status).toBe("requeued");
    const reader = openDb({ dbPath: db.name });
    try { assertSpace(reader, "old"); expect(count(reader, "note_vec_new")).toBe(3); expect(count(reader, "decision_vec_new")).toBe(0); }
    finally { reader.close(); }
    const resumed = fake();
    expect((await runReembedJob(db, claimNext(db, { now: later })!, { embedderFor: async () => resumed, now: later })).status).toBe("done");
    expect(resumed.embed).toHaveBeenCalledExactlyOnceWith(["decision 0", "decision 1"], "document"); assertDone(db);
  });

  it("skips arbitrary pre-existing shadow rows, including gaps in id order", async () => {
    const { db, claim } = fixture(); shadows(db);
    db.transaction(() => {
      db.prepare("INSERT INTO note_vec_new VALUES (?, ?)").run("n001", Buffer.from(vector("note 1", 3).buffer));
      db.prepare("INSERT INTO decision_vec_new VALUES (?, ?)").run("d1", Buffer.from(vector("decision 1", 3).buffer));
    })();
    const embedder = fake(); await runReembedJob(db, claim, { embedderFor: async () => embedder, now });
    expect(embedder.embed).toHaveBeenNthCalledWith(1, ["note 0", "note 2"], "document");
    expect(embedder.embed).toHaveBeenNthCalledWith(2, ["decision 0"], "document"); assertDone(db);
  });

  it("cleans a post-commit stray shadow without loading or changing the new vectors", async () => {
    const { db, claim } = fixture(); await runReembedJob(db, claim, { embedderFor: async () => fake(), now });
    db.transaction(() => db.exec("CREATE VIRTUAL TABLE note_vec_new USING vec0(note_id TEXT PRIMARY KEY, embedding float[4])"))();
    enqueueJob(db, "reembed", { targetEmbedderId: "new" }, { now });
    const resumed = claimNext(db, { now })!; const embedderFor = vi.fn(async () => fake());
    expect((await runReembedJob(db, resumed, { embedderFor, now })).status).toBe("done");
    expect(embedderFor).not.toHaveBeenCalled(); assertDone(db);
  });

  it("completes a no-op even when the current model has no pinned manifest", async () => {
    const { db, claim } = fixture(); const embedderFor = vi.fn(async () => fake());
    expect(await runReembedJob(db, { ...claim, payload: { targetEmbedderId: "old" } }, { embedderFor, now })).toEqual({ status: "done" });
    expect(embedderFor).not.toHaveBeenCalled(); assertSpace(db, "old"); expect(count(db, "jobs")).toBe(1);
  });

  it("does not swap an incomplete multi-batch build and accepts raw captures during inference", async () => {
    const { db, claim } = fixture(65, 0); let calls = 0;
    const embedder = fake(); embedder.embed = async texts => {
      expect(db.inTransaction).toBe(false); assertSpace(db, "old");
      if (++calls === 2) {
        expect(count(db, "note_vec_new")).toBe(64);
        const hook = openDb({ dbPath: db.name });
        try { hook.transaction(() => hook.prepare(`INSERT INTO captures
          (id, conversation_id, prompt, response, source_key, captured_at, created_at)
          VALUES ('capture', 'session', 'prompt', 'response', 'source', 't', 't')`).run())(); }
        finally { hook.close(); }
      }
      return texts.map(text => vector(text, 3));
    };
    expect((await runReembedJob(db, claim, { embedderFor: async () => embedder, now })).status).toBe("done");
    expect(calls).toBe(2); assertDone(db); expect(count(db, "captures")).toBe(1);
  });

  it("rolls back real table DDL and meta together if the swap fails", async () => {
    const { db, claim } = fixture();
    db.transaction(() => db.exec(`CREATE TRIGGER interrupt_swap BEFORE UPDATE ON meta
      WHEN NEW.key = 'embedder_dim' BEGIN SELECT RAISE(ABORT, 'interrupted swap'); END;`))();
    expect((await runReembedJob(db, claim, { embedderFor: async () => fake(), now })).status).toBe("requeued");
    assertSpace(db, "old"); expect(count(db, "note_vec_new")).toBe(3); expect(count(db, "decision_vec_new")).toBe(2);
    expect(count(db, "jobs WHERE kind = 'link-cluster'")).toBe(0);
    db.transaction(() => db.exec("DROP TRIGGER interrupt_swap"))();
    const embedder = fake(); await runReembedJob(db, claimNext(db, { now: later })!, { embedderFor: async () => embedder, now: later });
    expect(embedder.embed).not.toHaveBeenCalled(); assertDone(db);
  });

  it("rebuilds a missing shadow row detected by the final completeness gate", async () => {
    const { db, claim } = fixture(); const embedder = fake(); let removed = false;
    const clock = () => {
      const ready = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'decision_vec_new'").get();
      if (!removed && ready && count(db, "note_vec_new") === 3 && count(db, "decision_vec_new") === 2) {
        removed = true;
        db.transaction(() => db.prepare("DELETE FROM note_vec_new WHERE note_id = 'n001'").run())();
        assertSpace(db, "old");
      }
      return now();
    };
    expect((await runReembedJob(db, claim, { embedderFor: async () => embedder, now: clock })).status).toBe("done");
    expect(removed).toBe(true);
    expect(embedder.embed).toHaveBeenNthCalledWith(3, ["note 1"], "document"); assertDone(db);
  });

  it("surfaces excess shadow rows instead of swapping or spinning forever", async () => {
    const { db, claim } = fixture(); shadows(db);
    db.transaction(() => db.prepare("INSERT INTO note_vec_new VALUES (?, ?)")
      .run("orphan", Buffer.from(vector("orphan", 3).buffer)))();
    expect(await runReembedJob(db, claim, { embedderFor: async () => fake(), now }))
      .toMatchObject({ status: "requeued", error: "Unexpected extra rows in note_vec_new" });
    assertSpace(db, "old"); expect(count(db, "jobs WHERE kind = 'link-cluster'")).toBe(0);
  });

  it("abandons a reclaimed lease before writing a computed batch", async () => {
    const { db, claim } = fixture(); const embedder = fake(); let current: JobClaim | null = null;
    embedder.embed = async texts => { current = claimNext(db, { now: later }); return texts.map(text => vector(text, 3)); };
    expect(await runReembedJob(db, claim, { embedderFor: async () => embedder, now })).toEqual({ status: "stale" });
    assertSpace(db, "old"); expect(count(db, "note_vec_new")).toBe(0);
    expect((await runReembedJob(db, current!, { embedderFor: async () => fake(), now: later })).status).toBe("done"); assertDone(db);
  });

  it("completeJob's fence rolls back the entire swap when the token is lost at completion", async () => {
    const { db, claim } = fixture(); const original = queue.completeJob;
    vi.spyOn(queue, "completeJob").mockImplementation((conn, token, writes, opts) => {
      expect(claimNext(conn, { now: later })?.attempts).toBe(token.attempts + 1);
      return original(conn, token, writes, opts);
    });
    expect(await runReembedJob(db, claim, { embedderFor: async () => fake(), now })).toEqual({ status: "stale" });
    assertSpace(db, "old"); expect(count(db, "note_vec_new")).toBe(3);
    expect(count(db, "jobs WHERE kind = 'link-cluster'")).toBe(0);
  });

  it.each([{ vectors: [] }, { vectors: [new Float32Array([1, 2])] }, { vectors: [new Float32Array([NaN, 2, 3])] }])("rejects invalid embedding batches $vectors without partial insertion", async ({ vectors }) => {
    const { db, claim } = fixture(1, 0); const embedder = fake(); embedder.embed = async () => vectors;
    const result = await runReembedJob(db, claim, { embedderFor: async () => embedder, now });
    expect(result).toMatchObject({ status: "requeued", error: expect.stringContaining("Invalid reembed batch") });
    assertSpace(db, "old"); expect(count(db, "note_vec_new")).toBe(0);
  });

  it.each([null, {}, { targetEmbedderId: 3 }, { targetEmbedderId: " " }])("fails malformed payload %j", async payload => {
    const { db, claim } = fixture();
    expect((await runReembedJob(db, { ...claim, payload }, { embedderFor: async () => fake(), now })).status).toBe("requeued"); assertSpace(db, "old");
  });

  it("propagates an unpinned manifest as a job failure without loading a model", async () => {
    const { db, claim } = fixture(); const embedderFor = vi.fn(async () => fake());
    expect(await runReembedJob(db, { ...claim, payload: { targetEmbedderId: "nomic-embed-text-v1" } }, { embedderFor, now }))
      .toMatchObject({ status: "requeued", error: expect.stringContaining("placeholder") });
    expect(embedderFor).not.toHaveBeenCalled(); assertSpace(db, "old");
  });

  it("switches an empty database", async () => {
    const { db, claim } = fixture(0, 0);
    expect((await runReembedJob(db, claim, { embedderFor: async () => fake(), now })).status).toBe("done"); assertDone(db);
  });
});

describe("reembed dispatch", () => {
  it("uses the runtime target factory and updates the cached runtime after success", async () => {
    const { db, claim } = fixture(); const embedder = fake(); const embedderFor = vi.fn(async () => embedder);
    const runtime: Runtime = { backend: { modelId: "fake", completeJSON: async () => "{}" }, embedder: { ...fake(), id: "old", dim: 4 }, embedderFor, now };
    expect(await dispatchClaim(db, claim, runtime)).toEqual({ status: "done" });
    expect(embedderFor).toHaveBeenCalledExactlyOnceWith("new"); expect(runtime.embedder).toBe(embedder); assertDone(db);
  });

  it("leaves unavailable targets queued with a reason without spending retries", async () => {
    const { db, claim } = fixture();
    const runtime: Runtime = { backend: { modelId: "fake", completeJSON: async () => "{}" }, embedder: fake(), now };
    const result = await dispatchClaim(db, { ...claim, payload: { targetEmbedderId: "nomic-embed-text-v1" } }, runtime);
    expect(result).toMatchObject({ status: "requeued", error: expect.stringContaining("placeholder") });
    expect(db.prepare("SELECT status, attempts, epoch, last_error FROM jobs").get()).toMatchObject({ status: "queued", attempts: 0, epoch: 1, last_error: expect.stringContaining("placeholder") });
    assertSpace(db, "old");
  });
});
