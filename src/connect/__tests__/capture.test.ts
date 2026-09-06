import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMeta, openDb, setMeta, type Db } from "../../db/open.js";
import { captureFromTranscript, resolveRepoName } from "../capture.js";

let dir: string;
let db: Db;
let transcript: string;
const now = () => new Date("2026-01-03T00:00:00Z");
function pair(sessionId = "s1", uuid = "a1", cwd: string | null = "/work/repo"): string {
  return [ { type: "user", message: { content: "question" } },
    { type: "assistant", uuid, timestamp: "2026-01-01T00:00:00Z", message: { content: "response", model: "model" } },
  ].map(r => JSON.stringify({ ...r, sessionId, cwd })).join("\n") + "\n";
}
const options = { now, repoResolver: () => "repository" };
const count = (table: string): number => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capture-test-"));
  db = openDb({ dbPath: path.join(dir, "memory.db") });
  transcript = path.join(dir, "session.jsonl");
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("capture", () => {
  it("inserts full rows and coalesces jobs once per conversation before sidecar rename", () => {
    const text = pair() + pair("s1", "a2") + pair("s2", "a3", null);
    fs.writeFileSync(transcript, text);
    const rename = fs.renameSync;
    const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      expect(db.inTransaction).toBe(false);
      expect(count("captures")).toBe(3);
      expect(count("jobs")).toBe(2);
      expect(fs.existsSync(`${transcript}.terum-offset`)).toBe(false);
      rename(from, to);
    });
    expect(captureFromTranscript(db, transcript, options)).toEqual({
      inserted: 3, conversationsTouched: ["s1", "s2"], parseErrors: 0, nextOffset: Buffer.byteLength(text),
    });
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
    const rows = db.prepare("SELECT * FROM captures ORDER BY rowid").all() as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ site: "claude-code", conversation_id: "s1", source_key: "a1",
      conversation_title: null, prompt: "question", response: "response", model: "model",
      metadata: '{"repo_name":"repository"}', captured_at: "2026-01-01T00:00:00Z",
      created_at: now().toISOString(), distilled_at: null });
    expect(rows[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rows[2]?.metadata).toBe("{}");
    expect(JSON.parse(fs.readFileSync(`${transcript}.terum-offset`, "utf8"))).toEqual({ offset: Buffer.byteLength(text) });
    expect(fs.statSync(`${transcript}.terum-offset`).mode & 0o777).toBe(0o600);
    expect(captureFromTranscript(db, transcript, options).inserted).toBe(0);
  });

  it("replays a committed insert after sidecar failure without duplicating captures or jobs", () => {
    fs.writeFileSync(transcript, pair());
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw new Error("simulated crash"); });
    expect(() => captureFromTranscript(db, transcript, options)).toThrow("simulated crash");
    expect(count("captures")).toBe(1);
    expect(count("jobs")).toBe(1);
    expect(fs.existsSync(`${transcript}.terum-offset`)).toBe(false);
    expect(fs.readdirSync(dir).filter(name => name.endsWith(".tmp"))).toEqual([]);
    expect(captureFromTranscript(db, transcript, options)).toMatchObject({ inserted: 0, conversationsTouched: [] });
    expect(count("captures")).toBe(1);
    expect(count("jobs")).toBe(1);
    expect(fs.existsSync(`${transcript}.terum-offset`)).toBe(true);
  });

  it("rolls back inserts, jobs and error metadata when a write fails", () => {
    fs.writeFileSync(transcript, pair() + "bad\n");
    db.exec("CREATE TRIGGER reject_meta BEFORE INSERT ON meta WHEN NEW.key = 'parse_errors' BEGIN SELECT RAISE(ABORT, 'metadata failure'); END");
    expect(() => captureFromTranscript(db, transcript, options)).toThrow("metadata failure");
    expect(count("captures")).toBe(0);
    expect(count("jobs")).toBe(0);
    expect(getMeta(db, "parse_errors")).toBeUndefined();
    expect(fs.existsSync(`${transcript}.terum-offset`)).toBe(false);
  });

  it("preserves the old offset on queue failure and can retry", () => {
    fs.writeFileSync(transcript, pair());
    captureFromTranscript(db, transcript, options);
    const sidecar = fs.readFileSync(`${transcript}.terum-offset`, "utf8");
    fs.appendFileSync(transcript, pair("s2", "a2"));
    db.exec("CREATE TRIGGER reject_job BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT, 'queue failure'); END");
    expect(() => captureFromTranscript(db, transcript, options)).toThrow("queue failure");
    expect(count("captures")).toBe(1);
    expect(fs.readFileSync(`${transcript}.terum-offset`, "utf8")).toBe(sidecar);
    db.exec("DROP TRIGGER reject_job");
    expect(captureFromTranscript(db, transcript, options).inserted).toBe(1);
  });

  it("merges durable error accounting across deltas and paths", () => {
    db.transaction(() => setMeta(db, "parse_errors", '{"other":{"count":7,"lastBadOffset":12}}'))();
    fs.writeFileSync(transcript, "bad\n" + pair());
    expect(captureFromTranscript(db, transcript, options).parseErrors).toBe(1);
    const offset = fs.statSync(transcript).size;
    fs.appendFileSync(transcript, "also bad\n");
    expect(captureFromTranscript(db, transcript, options).parseErrors).toBe(1);
    expect(JSON.parse(getMeta(db, "parse_errors")!)).toEqual({
      other: { count: 7, lastBadOffset: 12 }, [transcript]: { count: 2, lastBadOffset: offset },
    });
  });

  it("captures a later reply using prefix context after persisting the user offset", () => {
    const [user, assistant] = pair().split("\n");
    fs.writeFileSync(transcript, `${user}\n${assistant!.slice(0, 10)}`);
    expect(captureFromTranscript(db, transcript, options).inserted).toBe(0);
    fs.appendFileSync(transcript, `${assistant!.slice(10)}\n`);
    expect(captureFromTranscript(db, transcript, options).inserted).toBe(1);
  });

  it("does not use timestamp as identity and skips repo lookup for null cwd", () => {
    fs.writeFileSync(transcript, pair("s1", "a1", null) + pair("s1", "a2", null));
    const repoResolver = vi.fn(() => null);
    expect(captureFromTranscript(db, transcript, { repoResolver }).inserted).toBe(2);
    expect(repoResolver).not.toHaveBeenCalled();
  });

  it("rejects outer transactions before any sidecar write", () => {
    fs.writeFileSync(transcript, pair());
    expect(() => db.transaction(() => captureFromTranscript(db, transcript, options))()).toThrow(/independent transaction/);
    expect(fs.existsSync(`${transcript}.terum-offset`)).toBe(false);
  });

  it.each(['{"offset":-1}', '{"offset":1.5}', '{"offset":999999}', 'broken', 'null'])("refuses corrupt or out-of-range sidecar %s", sidecar => {
    fs.writeFileSync(transcript, pair());
    fs.writeFileSync(`${transcript}.terum-offset`, sidecar, { mode: 0o600 });
    expect(() => captureFromTranscript(db, transcript, options)).toThrow();
    expect(count("captures")).toBe(0);
    expect(fs.readFileSync(`${transcript}.terum-offset`, "utf8")).toBe(sidecar);
  });

  it("finds a normalized containing git directory and returns null otherwise", () => {
    const repo = path.join(dir, "MyRepo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(path.join(repo, "src"));
    expect(resolveRepoName(path.join(repo, "src", "..", "src"))).toBe("myrepo");
    expect(resolveRepoName(dir)).toBeNull();
    expect(resolveRepoName("relative")).toBeNull();
    const worktree = path.join(dir, "worktree");
    fs.mkdirSync(worktree);
    fs.writeFileSync(path.join(worktree, ".git"), "gitdir: elsewhere");
    expect(resolveRepoName(worktree)).toBeNull();
  });
});
