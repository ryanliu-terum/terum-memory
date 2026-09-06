import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { getMeta, openDb, setMeta, type Db } from "../../db/open.js";
import { importSession } from "../import.js";
import { count, now, pair, session } from "./fixtures.js";

let dir: string;
let db: Db;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "backfill-import-"));
  db = openDb({ dbPath: path.join(dir, "memory.db") });
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

it("imports whole sessions with M10 row derivation, dedup, no distill or sidecar writes", () => {
  const repo = path.join(dir, "MyRepo");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  const file = session(dir, "session", pair("s1", "a1", repo) + pair("s2", "a2") + "bad\n");
  const sidecar = `${file}.terum-offset`;
  fs.writeFileSync(sidecar, "untouched");
  expect(importSession(db, file, { now })).toEqual({ inserted: 2, conversationsTouched: ["s1", "s2"], parseErrors: 1 });
  const rows = db.prepare("SELECT * FROM captures ORDER BY rowid").all() as Array<Record<string, unknown>>;
  expect(rows[0]).toMatchObject({ site: "claude-code", conversation_id: "s1", source_key: "a1",
    prompt: "question", response: "response", model: "model", conversation_title: null,
    metadata: '{"repo_name":"myrepo"}', captured_at: "2026-01-01T00:00:00Z",
    created_at: now().toISOString(), distilled_at: null });
  expect(rows[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(rows[1]!.metadata).toBe("{}");
  expect(count(db, "jobs")).toBe(0);
  expect(importSession(db, file, { now })).toEqual({ inserted: 0, conversationsTouched: [], parseErrors: 1 });
  expect(count(db, "captures")).toBe(2);
  expect(JSON.parse(getMeta(db, "parse_errors")!)[file].count).toBe(2);
  expect(fs.readFileSync(sidecar, "utf8")).toBe("untouched");
  fs.unlinkSync(sidecar);
  importSession(db, file);
  expect(fs.existsSync(sidecar)).toBe(false);
});

it("merges parse error accounting without dropping other paths", () => {
  const file = session(dir, "bad", "bad\n");
  db.transaction(() => setMeta(db, "parse_errors", '{"other":{"count":7,"lastBadOffset":12}}'))();
  expect(importSession(db, file).parseErrors).toBe(1);
  expect(JSON.parse(getMeta(db, "parse_errors")!)).toEqual({ other: { count: 7, lastBadOffset: 12 },
    [file]: { count: 1, lastBadOffset: 0 } });
});

it("rolls back captures when error metadata cannot be persisted", () => {
  const file = session(dir, "broken", pair() + "bad\n");
  db.exec("CREATE TRIGGER reject_meta BEFORE INSERT ON meta WHEN NEW.key = 'parse_errors' BEGIN SELECT RAISE(ABORT, 'metadata failure'); END");
  expect(() => importSession(db, file)).toThrow("metadata failure");
  expect(count(db, "captures")).toBe(0);
  expect(getMeta(db, "parse_errors")).toBeUndefined();
});

it.each(["null", "[]", '{"bad":{"count":-1}}'])("refuses malformed error metadata %s", value => {
  const file = session(dir, "bad", pair() + "bad\n");
  const stored = value.includes('"bad"') ? JSON.stringify({ [file]: { count: -1 } }) : value;
  db.transaction(() => setMeta(db, "parse_errors", stored))();
  expect(() => importSession(db, file)).toThrow(/parse_errors/);
  expect(count(db, "captures")).toBe(0);
});

it("propagates read failures and honors a caller's rollback", () => {
  expect(() => importSession(db, path.join(dir, "missing"))).toThrow();
  const file = session(dir, "valid");
  expect(() => db.transaction(() => { importSession(db, file); throw new Error("crash"); })()).toThrow("crash");
  expect(count(db, "captures")).toBe(0);
});

it("has no LLM, embedder or compactor in its transitive module graph", () => {
  const visited = new Set<string>();
  function walk(file: string): void {
    if (visited.has(file)) return;
    visited.add(file);
    const source = fs.readFileSync(file, "utf8");
    const imports = /(?:\bfrom\s*|\bimport\s*|\b(?:import|require)\s*\(\s*)["']([^"']+)["']/g;
    for (const match of source.matchAll(imports)) {
      const specifier = match[1]!;
      expect(specifier).not.toMatch(/@huggingface\/transformers|embedder|compactor|compact(?:ion)?\.js|\/llm\//);
      if (specifier.startsWith(".")) walk(path.resolve(path.dirname(file), specifier.replace(/\.js$/, ".ts")));
    }
  }
  walk(path.resolve("src/backfill/import.ts"));
  expect(visited.has(path.resolve("src/connect/transcript.ts"))).toBe(true);
});
