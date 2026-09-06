import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createVecTables, getMeta, openDb, setMeta, type Db } from "../open.js";

const TABLES = [
  "meta",
  "captures",
  "projects",
  "notes",
  "links",
  "decisions",
  "decision_edges",
  "receipts",
  "jobs",
];

const INDEXES = ["idx_captures_pending", "idx_decisions_ratified_hash", "idx_jobs_runnable"];

let cleanup: Array<() => void> = [];

function freshDb(): { db: Db; dir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "terum-test-"));
  const db = openDb({ dbPath: path.join(dir, "terum.db"), warn: () => {} });
  cleanup.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { db, dir };
}

afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

describe("schema", () => {
  it("fresh open creates every table and index", () => {
    const { db } = freshDb();
    const names = new Set(
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')")
          .all() as Array<{ name: string }>
      ).map((row) => row.name),
    );
    for (const table of TABLES) expect(names, `missing table ${table}`).toContain(table);
    for (const index of INDEXES) expect(names, `missing index ${index}`).toContain(index);
  });

  it("stamps schema_version and created_at in meta", () => {
    const { db } = freshDb();
    expect(getMeta(db, "schema_version")).toBe("1");
    expect(getMeta(db, "created_at")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("reopen of an existing db is idempotent", () => {
    const { db, dir } = freshDb();
    setMeta(db, "probe", "value");
    db.close();
    const reopened = openDb({ dbPath: path.join(dir, "terum.db"), warn: () => {} });
    cleanup.push(() => reopened.close());
    expect(getMeta(reopened, "probe")).toBe("value");
    expect(getMeta(reopened, "schema_version")).toBe("1");
  });

  it("createVecTables creates queryable vec0 tables at the given dimension", () => {
    const { db } = freshDb();
    createVecTables(db, 4);
    db.prepare("INSERT INTO note_vec (note_id, embedding) VALUES (?, ?)").run(
      "n1",
      JSON.stringify([1, 0, 0, 0]),
    );
    const row = db
      .prepare(
        "SELECT note_id, distance FROM note_vec WHERE embedding MATCH ? ORDER BY distance LIMIT 1",
      )
      .get(JSON.stringify([1, 0, 0, 0])) as { note_id: string; distance: number };
    expect(row.note_id).toBe("n1");
    expect(row.distance).toBeCloseTo(0);
  });

  it("createVecTables rejects a non-positive or fractional dimension", () => {
    const { db } = freshDb();
    expect(() => createVecTables(db, 0)).toThrow(/invalid embedding dimension/);
    expect(() => createVecTables(db, 1.5)).toThrow(/invalid embedding dimension/);
  });

  it("wrong-dimension vector insert fails once the dimension is locked", () => {
    const { db } = freshDb();
    createVecTables(db, 4);
    expect(() =>
      db
        .prepare("INSERT INTO note_vec (note_id, embedding) VALUES (?, ?)")
        .run("n2", JSON.stringify([1, 0])),
    ).toThrow();
  });

  it("dedup constraints: same (note_id, content_hash) rejected; ratified rows unique by hash", () => {
    const { db } = freshDb();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO notes (id, site, conversation_id, turn_count, compacted_text, model_used, first_captured_at, last_captured_at, distilled_at) VALUES ('note1', 'claude-code', 'c1', 1, 'text', 'm', ?, ?, ?)",
    ).run(now, now, now);
    const insertDecision = db.prepare(
      "INSERT INTO decisions (id, note_id, decision_text, content_hash, provenance, decided_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    insertDecision.run("d1", "note1", "use X", "hash1", "distilled", now, now);
    expect(() => insertDecision.run("d2", "note1", "use X", "hash1", "distilled", now, now)).toThrow(
      /UNIQUE/,
    );
    insertDecision.run("d3", null, "use Y", "hash2", "ratified", now, now);
    expect(() => insertDecision.run("d4", null, "use Y", "hash2", "ratified", now, now)).toThrow(
      /UNIQUE/,
    );
  });
});
