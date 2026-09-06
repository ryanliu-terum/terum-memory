import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createVecTables, openDb, setMeta, type Db } from "../../db/open.js";
import type { Embedder } from "../../engine/embedder-types.js";
import {
  ANCHOR_THRESHOLD, DEFAULT_SEARCH_LIMIT, LINK_NEIGHBOR_CAP, MAX_SEARCH_LIMIT, runSearch,
} from "../engine.js";

const NOW = "2026-04-01T00:00:00.000Z";
const AXIS = new Float32Array([1, 0, 0, 0]);
const AWAY = new Float32Array([-1, 0, 0, 0]);
const cleanups: Array<() => void> = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "search-engine-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = openDb({ dbPath: path.join(dir, "memory.db"), warn: () => undefined });
  cleanups.push(() => db.close());
  db.transaction(() => {
    createVecTables(db, 4);
    setMeta(db, "embedder_dim", "4");
    // Search must not require measured link thresholds for this embedder.
    setMeta(db, "embedder_id", "nomic-embed-text-v1");
  })();
  const embed = vi.fn<Embedder["embed"]>(async () => [AXIS]);
  return { db, embed, deps: { embedder: { id: "nomic-embed-text-v1", dim: 4, embed } } };
}

function vector(score: number): Float32Array {
  return new Float32Array([score, Math.sqrt(1 - score ** 2), 0, 0]);
}

function note(db: Db, id: string, embedding: Float32Array | null = AXIS): void {
  db.transaction(() => {
    db.prepare(`INSERT INTO notes (id, site, conversation_id, turn_count, topic, summary,
      compacted_text, model_used, first_captured_at, last_captured_at, distilled_at)
      VALUES (?, 'test', ?, 1, 'storage', ?, ?, 'fake', ?, ?, ?)`)
      .run(id, id, `Summary ${id}`, `Note ${id}`, NOW, NOW, NOW);
    if (embedding) db.prepare("INSERT INTO note_vec (note_id, embedding) VALUES (?, ?)").run(id, embedding);
  })();
}

function decision(db: Db, id: string, embedding: Float32Array | null = AXIS, parent: string | null = null): void {
  db.transaction(() => {
    db.prepare(`INSERT INTO decisions (id, note_id, decision_text, reason, topic, content_hash,
      provenance, human_quote, decided_at, created_at) VALUES (?, ?, ?, ?, 'storage', ?, ?, ?, ?, ?)`)
      .run(id, parent, `Decision ${id}`, `Reason ${id}`, id, parent ? "distilled" : "ratified",
        parent ? null : "I choose this", NOW, NOW);
    if (embedding) db.prepare("INSERT INTO decision_vec (decision_id, embedding) VALUES (?, ?)").run(id, embedding);
  })();
}

function link(db: Db, a: string, b: string, score: number): void {
  db.transaction(() => {
    db.prepare("INSERT INTO links (a, b, similarity, computed_at) VALUES (?, ?, ?, ?)")
      .run(...[a, b].sort(), score, NOW);
  })();
}

it("exports the specified search constants", () => {
  expect([ANCHOR_THRESHOLD, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT, LINK_NEIGHBOR_CAP])
    .toEqual([0.4, 20, 50, 400]);
});

it("anchors notes and decisions by cosine, including exactly 0.40, using the query prefix", async () => {
  const f = fixture();
  note(f.db, "A", new Float32Array([8, 0, 0, 0]));
  decision(f.db, "D", vector(0.8));
  // Integer components give norm 5 and cosine exactly 2/5, without Float32 rounding.
  const boundary = new Float32Array([2, 1, 2, 4]);
  note(f.db, "boundary-note", boundary);
  decision(f.db, "boundary-decision", boundary);
  note(f.db, "below-note", vector(0.3999));
  decision(f.db, "below-decision", vector(0.3999));
  note(f.db, "no-vector", null);
  const output = await runSearch(f.db, "storage choices", f.deps);
  expect(output.error).toBeUndefined();
  expect(output.results.map(row => row.id)).toEqual(["A", "D", "boundary-decision", "boundary-note"]);
  expect(output.results[0]).toEqual({ kind: "note", id: "A", topic: "storage",
    summary: "Summary A", text: "Note A", similarity: 1, via: "anchor" });
  expect(output.results[1]).toEqual({ kind: "decision", id: "D", topic: "storage",
    summary: "Reason D", text: "Decision D", similarity: expect.closeTo(0.8, 6), via: "anchor",
    decided_at: NOW, provenance: "ratified" });
  expect(output.results.slice(2).map(row => row.similarity)).toEqual([0.4, 0.4]);
  expect(output.results.every(row => row.via === "anchor")).toBe(true);
  expect(f.embed).toHaveBeenCalledExactlyOnceWith(["storage choices"], "query");
});

it("walks both edge directions once, takes each neighbor's best anchor edge, and hydrates vectorless notes", async () => {
  const f = fixture();
  note(f.db, "M");
  note(f.db, "Z", vector(0.95));
  note(f.db, "B", AWAY);
  note(f.db, "C", null);
  note(f.db, "two-hops", AWAY);
  link(f.db, "M", "B", 0.6);
  link(f.db, "Z", "B", 0.8);
  link(f.db, "M", "C", 0.7);
  link(f.db, "B", "two-hops", 1);
  const output = await runSearch(f.db, "query", f.deps);
  expect(output.results.map(row => row.id)).toEqual(["M", "Z", "B", "C"]);
  expect(output.results.slice(2)).toEqual([
    { kind: "note", id: "B", topic: "storage", summary: "Summary B", text: "Note B", similarity: 0.8, via: "link" },
    { kind: "note", id: "C", topic: "storage", summary: "Summary C", text: "Note C", similarity: 0.7, via: "link" },
  ]);
});

it("caps neighbor IDs before hydration, selecting by best edge then ID regardless of insertion order", async () => {
  const f = fixture();
  note(f.db, "anchor");
  note(f.db, "second-anchor");
  const ids = Array.from({ length: LINK_NEIGHBOR_CAP + 25 }, (_, i) => `n${String(i).padStart(4, "0")}`);
  f.db.transaction(() => {
    for (const id of [...ids].reverse()) {
      note(f.db, id, null);
      link(f.db, "anchor", id, 0.5);
    }
    link(f.db, "second-anchor", ids.at(-1)!, 0.9);
  })();
  const hydrated: string[] = [];
  const prepare = f.db.prepare.bind(f.db);
  vi.spyOn(f.db, "prepare").mockImplementation(sql => {
    const statement = prepare(sql);
    if (sql === "SELECT id, topic, summary, compacted_text AS text FROM notes WHERE id = ?") {
      const get = statement.get.bind(statement);
      vi.spyOn(statement, "get").mockImplementation((...params: unknown[]) => {
        hydrated.push(params[0] as string);
        return get(...params);
      });
    }
    return statement;
  });
  const output = await runSearch(f.db, "query", f.deps, { limit: MAX_SEARCH_LIMIT });
  expect(output.error).toBeUndefined();
  expect(hydrated).toEqual([ids.at(-1), ...ids.slice(0, LINK_NEIGHBOR_CAP - 1)]);
  expect(hydrated).toHaveLength(LINK_NEIGHBOR_CAP);
  expect(output.results.map(row => row.id)).toEqual(["anchor", "second-anchor", ids.at(-1), ...ids.slice(0, 47)]);
});

it("deduplicates linked anchors, preserves kind/id identity, and ranks score before via before ID", async () => {
  const f = fixture();
  note(f.db, "z-anchor");
  note(f.db, "shared", new Float32Array([3, 4, 0, 0]));
  decision(f.db, "shared", vector(0.8));
  note(f.db, "a-link", AWAY);
  note(f.db, "b-link", AWAY);
  note(f.db, "high-link", AWAY);
  link(f.db, "z-anchor", "shared", 0.99);
  link(f.db, "z-anchor", "a-link", 0.6);
  link(f.db, "z-anchor", "b-link", 0.6);
  link(f.db, "z-anchor", "high-link", 0.9);
  const output = await runSearch(f.db, "query", f.deps);
  expect(output.results.map(row => [row.kind, row.id, row.via])).toEqual([
    ["note", "z-anchor", "anchor"], ["note", "high-link", "link"],
    ["decision", "shared", "anchor"], ["note", "shared", "anchor"],
    ["note", "a-link", "link"], ["note", "b-link", "link"],
  ]);
  expect(output.results.find(row => row.kind === "note" && row.id === "shared")!.similarity).toBe(0.6);
  const scores = output.results.map(row => row.similarity);
  expect(scores).toEqual([...scores].sort((a, b) => b - a));
});

it.each([
  [undefined, 20], [null, 20], ["5", 20], [true, 20], [{}, 20],
  [0, 20], [-1, 20], [NaN, 20], [Infinity, 20], [-Infinity, 20],
  [0.5, 0], [2.9, 2], [50, 50], [100, 50],
])("clamps limit %s to %s", async (limit, count) => {
  const f = fixture();
  f.db.transaction(() => {
    for (let i = 54; i >= 0; i--) note(f.db, `n${String(i).padStart(2, "0")}`);
  })();
  const output = await runSearch(f.db, "query", f.deps, { limit: limit as number | undefined });
  expect(output.error).toBeUndefined();
  expect(output.results).toHaveLength(count as number);
  expect(output.results.map(row => row.id)).toEqual(
    Array.from({ length: count as number }, (_, i) => `n${String(i).padStart(2, "0")}`),
  );
  if (limit === undefined) expect((await runSearch(f.db, "query", f.deps)).results).toHaveLength(20);
});

it.each(["throw", "dimension", "declared-dimension", "missing", "extra", "nan", "infinity", "wrong-type", "missing-meta", "invalid-meta"])(
  "fails closed for query embedding failure: %s", async mode => {
    const f = fixture();
    note(f.db, "A");
    decision(f.db, "D");
    if (mode === "throw") f.embed.mockRejectedValueOnce(new Error("offline"));
    if (mode === "dimension") f.embed.mockResolvedValueOnce([new Float32Array(3)]);
    if (mode === "declared-dimension") f.deps.embedder.dim = 3;
    if (mode === "missing") f.embed.mockResolvedValueOnce([]);
    if (mode === "extra") f.embed.mockResolvedValueOnce([AXIS, AXIS]);
    if (mode === "nan") f.embed.mockResolvedValueOnce([new Float32Array([NaN, 0, 0, 0])]);
    if (mode === "infinity") f.embed.mockResolvedValueOnce([new Float32Array([Infinity, 0, 0, 0])]);
    if (mode === "wrong-type") f.embed.mockResolvedValueOnce([[1, 0, 0, 0] as unknown as Float32Array]);
    if (mode === "missing-meta") f.db.transaction(() => f.db.prepare("DELETE FROM meta WHERE key = 'embedder_dim'").run())();
    if (mode === "invalid-meta") f.db.transaction(() => setMeta(f.db, "embedder_dim", "bad"))();
    expect(await runSearch(f.db, "query", f.deps)).toEqual({ results: [], error: "query embedding failed" });
  },
);

it.each(["decision_vec", "links"])("returns no partial anchors when infrastructure fails at %s", async table => {
  const f = fixture();
  note(f.db, "A");
  f.db.transaction(() => f.db.exec(`DROP TABLE ${table}`))();
  expect(await runSearch(f.db, "query", f.deps)).toEqual({ results: [], error: "search failed" });
});

it.each([false, true])("returns a normal empty result for an empty/unrelated database (populated=%s)", async populated => {
  const f = fixture();
  if (populated) {
    note(f.db, "A", AWAY);
    decision(f.db, "D", new Float32Array(4));
  }
  expect(await runSearch(f.db, "query", f.deps)).toEqual({ results: [] });
});

it("only anchors decisions by their own vectors, regardless of parent notes or decision edges", async () => {
  const f = fixture();
  note(f.db, "A");
  note(f.db, "B", AWAY);
  link(f.db, "A", "B", 0.7);
  decision(f.db, "anchor-child", AWAY, "A");
  decision(f.db, "linked-child", AWAY, "B");
  decision(f.db, "vectorless-child", null, "B");
  decision(f.db, "clears-floor", AXIS, "B");
  f.db.transaction(() => {
    f.db.prepare(`INSERT INTO decision_edges (id, decision_a, decision_b, edge_type, created_at)
      VALUES ('edge', 'clears-floor', 'linked-child', 'compatible', ?)` ).run(NOW);
  })();
  const output = await runSearch(f.db, "query", f.deps);
  expect(output.results.filter(row => row.kind === "decision")).toEqual([
    { kind: "decision", id: "clears-floor", topic: "storage", summary: "Reason clears-floor",
      text: "Decision clears-floor", similarity: 1, via: "anchor", decided_at: NOW, provenance: "distilled" },
  ]);
});

it("preserves nullable fields and succeeds on a query-only connection without writing receipts", async () => {
  const f = fixture();
  note(f.db, "A");
  note(f.db, "B", null);
  link(f.db, "A", "B", 0.7);
  decision(f.db, "D");
  f.db.transaction(() => {
    f.db.exec("UPDATE notes SET topic = NULL, summary = NULL; UPDATE decisions SET topic = NULL, reason = NULL");
  })();
  const before = f.db.prepare("SELECT total_changes() AS count").get();
  f.db.pragma("query_only = ON");
  const output = await runSearch(f.db, "query", f.deps);
  expect(output.error).toBeUndefined();
  expect(output.results).toHaveLength(3);
  expect(output.results.every(row => row.topic === null && row.summary === null)).toBe(true);
  expect(f.db.prepare("SELECT total_changes() AS count").get()).toEqual(before);
  expect(f.db.prepare("SELECT * FROM receipts").all()).toEqual([]);
});
