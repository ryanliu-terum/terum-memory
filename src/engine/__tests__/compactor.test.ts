import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVecTables, openDb, setMeta, type Db } from "../../db/open.js";
import { claimNext, completeJob, enqueueDistill } from "../../jobs/queue.js";
import type { ChatBackend } from "../../llm/backend.js";
import { DISTILL_CONTENT_BUDGET, runDistillJob } from "../compactor.js";
import { DISTILL_PROMPT, DISTILL_SCHEMA, type DistilledNote } from "../distill.js";
import type { Embedder } from "../embedder-types.js";
import { parseDistilledNote, renderCompactedText } from "../parse.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.useRealTimers();
  for (const fn of cleanup.splice(0)) fn();
});

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "terum-distill-"));
  const dbPath = path.join(dir, "terum.db");
  const connections: Db[] = [];
  const connect = () => {
    const db = openDb({ dbPath });
    connections.push(db);
    return db;
  };
  cleanup.push(() => {
    for (const db of connections) db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const db = connect();
  db.transaction(() => {
    createVecTables(db, 3);
    setMeta(db, "embedder_dim", "3");
    setMeta(db, "embedder_id", "fake-embedder");
  })();
  let time = Date.parse("2026-01-01T00:00:00.000Z");
  const clock = { now: () => new Date(time) };
  let output: DistilledNote = parseDistilledNote(JSON.stringify({
    topic: "queue fencing", summary: "built fenced queue", context: "leases could expire",
    key_details: ["fenced every write"], decisions: ["Chose SQLite for local storage", "Used leases to recover workers"],
    derived_conclusions: ["recommended a load test"], code_implementation: ["updated queue.ts"],
    preferences_corrections: ["kept Node 20"], open_threads: ["deferred worker loop"], tags: ["SQLite", "queue.ts"],
  }));
  const completeJSON = vi.fn<ChatBackend["completeJSON"]>(async () => {
    expect(db.inTransaction).toBe(false);
    return JSON.stringify(output);
  });
  const embed = vi.fn<Embedder["embed"]>(async (texts, kind) => {
    expect(db.inTransaction).toBe(false);
    expect(kind).toBe("document");
    return texts.map((_, index) => new Float32Array([index + 1, 2, 3]));
  });
  const deps = {
    ...clock,
    backend: { modelId: "fake-model", completeJSON },
    embedder: { id: "fake-embedder", dim: 3, embed },
  };
  let index = 0;
  const capture = (overrides: Partial<{
    site: string; conversation_id: string; prompt: string; response: string; captured_at: string;
    created_at: string; metadata: string; distilled_at: string | null; conversation_title: string | null;
  }> = {}, target: Db = db) => {
    const id = randomUUID();
    const row = {
      id, site: "site", conversation_id: "conversation", prompt: `prompt ${++index}`, response: `response ${index}`,
      captured_at: new Date(time + index).toISOString(), created_at: new Date(time + index).toISOString(),
      metadata: '{}', distilled_at: null, conversation_title: null, ...overrides,
    };
    target.transaction(() => target.prepare(`
      INSERT INTO captures (id, site, conversation_id, source_key, prompt, response, captured_at,
        created_at, metadata, distilled_at, conversation_title)
      VALUES (@id, @site, @conversation_id, @id, @prompt, @response, @captured_at,
        @created_at, @metadata, @distilled_at, @conversation_title)
    `).run(row))();
    return id;
  };
  const claim = () => {
    enqueueDistill(db, "site", "conversation", clock);
    // Drain unrelated downstream jobs; their actual handler is outside this scope.
    for (;;) {
      const next = claimNext(db, clock);
      if (!next) throw new Error("Expected a distill claim");
      if (next.kind === "distill") return next;
      if (next.kind !== "link-cluster") throw new Error("Unexpected queued kind");
      completeJob(db, next, undefined, clock);
    }
  };
  return {
    db, connect, clock, deps, capture, claim, completeJSON, embed,
    advance: (ms: number) => { time += ms; },
    output: () => output,
    setOutput: (value: Partial<DistilledNote>) => { output = { ...output, ...value }; },
  };
}

function rows(db: Db, table: string) {
  const order = table === "note_vec" ? "note_id" : table === "decision_vec" ? "decision_id" : "rowid";
  return db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all() as Array<Record<string, unknown>>;
}
function pending(db: Db) {
  return db.prepare("SELECT id FROM captures WHERE distilled_at IS NULL ORDER BY rowid").all() as Array<{ id: string }>;
}
function hash(text: string) {
  return createHash("sha256").update(text.trim().replace(/\s+/g, " ").toLowerCase()).digest("hex");
}
function decisionState(db: Db, text: string) {
  const row = db.prepare("SELECT rowid, * FROM decisions WHERE content_hash = ?").get(hash(text)) as Record<string, unknown>;
  return {
    row,
    vector: db.prepare("SELECT * FROM decision_vec WHERE decision_id = ?").get(row.id),
    vectorRow: db.prepare("SELECT * FROM decision_vec_rowids WHERE id = ?").get(row.id),
  };
}
function businessState(db: Db) {
  return Object.fromEntries(["notes", "decisions", "note_vec", "decision_vec", "captures"].map((table) => [table, rows(db, table)]));
}

it("persists a scrubbed full-history note, metadata, vectors, decisions and one coalesced link-cluster job", async () => {
  const f = fixture();
  const secret = "sk-abcdefghijklmnopqrstuvwxyz";
  const later = "2026-01-02T00:00:00.000Z";
  f.capture({ prompt: "latest", captured_at: later, metadata: '{"repo_name":"Other"}', conversation_title: "latest title" });
  f.capture({ prompt: secret, captured_at: "2025-12-01T00:00:00.000Z", metadata: '{"repo_name":"/work/MyRepo"}' });
  f.capture({ metadata: '{"repo_name":"MYREPO"}', distilled_at: "2025-12-31T00:00:00.000Z" });
  const claim = f.claim();
  await runDistillJob(f.db, claim, f.deps);
  const note = rows(f.db, "notes")[0]!;
  expect(note).toMatchObject({
    site: "site", conversation_id: "conversation", conversation_title: "latest title", turn_count: 3,
    topic: f.output().topic, summary: f.output().summary, compacted_text: renderCompactedText(f.output()),
    entity_tags: JSON.stringify(f.output().tags), repo_name: "myrepo", model_used: "fake-model",
    first_captured_at: "2025-12-01T00:00:00.000Z", last_captured_at: later,
    distilled_at: f.clock.now().toISOString(), project_id: null,
  });
  expect(note.id).toMatch(/^[\da-f-]{14}4[\da-f-]{21}$/);
  expect(rows(f.db, "note_vec")).toHaveLength(1);
  expect(rows(f.db, "note_vec")[0]!.note_id).toBe(note.id);
  expect(rows(f.db, "decisions").map((row) => row.content_hash)).toEqual(f.output().decisions.map(hash));
  for (const row of rows(f.db, "decisions")) {
    expect(row).toMatchObject({ note_id: note.id, provenance: "distilled", decided_at: f.clock.now().toISOString(), source_summary: f.output().summary });
    expect(f.db.prepare("SELECT decision_id FROM decision_vec WHERE decision_id = ?").get(row.id)).toEqual({ decision_id: row.id });
  }
  expect(pending(f.db)).toEqual([]);
  expect(rows(f.db, "captures").filter((row) => row.distilled_at === "2025-12-31T00:00:00.000Z")).toHaveLength(1);
  expect(rows(f.db, "jobs").find((row) => row.id === claim.id)?.status).toBe("done");
  expect(rows(f.db, "jobs").filter((row) => row.kind === "link-cluster")).toHaveLength(1);
  const request = f.completeJSON.mock.calls[0]![0];
  expect(request).toEqual({
    prompt: DISTILL_PROMPT + "\n\nUser:\n[REDACTED]\n\nAssistant:\nresponse 2\n\nUser:\nprompt 3\n\nAssistant:\nresponse 3\n\nUser:\nlatest\n\nAssistant:\nresponse 1",
    schema: DISTILL_SCHEMA, timeoutMs: 60_000,
  });
  expect(request.prompt).not.toContain(secret);
  expect(f.embed).toHaveBeenCalledWith([renderCompactedText(f.output()), ...f.output().decisions], "document");
  // Hold the already queued downstream job in the future while draining another distill.
  f.db.transaction(() => f.db.prepare("UPDATE jobs SET run_after = ? WHERE kind = 'link-cluster'").run(later))();
  f.capture();
  await runDistillJob(f.db, f.claim(), f.deps);
  expect(rows(f.db, "jobs").filter((row) => row.kind === "link-cluster" && row.status === "queued")).toHaveLength(1);
  expect(rows(f.db, "notes")[0]!.id).toBe(note.id);
});

it.each([false, true])("completes as a fenced no-op when nothing is pending (history=%s)", async (history) => {
  const f = fixture();
  if (history) f.capture({ distilled_at: f.clock.now().toISOString() });
  const before = businessState(f.db);
  const claim = f.claim();
  await runDistillJob(f.db, claim, f.deps);
  expect(businessState(f.db)).toEqual(before);
  expect(f.completeJSON).not.toHaveBeenCalled();
  expect(f.embed).not.toHaveBeenCalled();
  expect(rows(f.db, "jobs")).toMatchObject([{ id: claim.id, status: "done" }]);
});

it("uses the most recent capture to break repository ties and ignores null metadata", async () => {
  const f = fixture();
  f.capture({ metadata: '{"repo_name":"first"}', captured_at: "2025-01-01T00:00:00.000Z" });
  f.capture({ metadata: '{"repo_name":"second"}' });
  f.capture({ metadata: '{"repo_name":null}' });
  await runDistillJob(f.db, f.claim(), f.deps);
  expect(rows(f.db, "notes")[0]!.repo_name).toBe("second");
});

it("treats corrupt capture metadata as an unknown repository instead of failing the distill", async () => {
  const f = fixture();
  f.capture({ metadata: "bad JSON" });
  f.capture({ metadata: '{"repo_name":"known"}' });
  f.capture({ metadata: "{not json either" });
  const claim = f.claim();
  await runDistillJob(f.db, claim, f.deps);
  expect(rows(f.db, "jobs").find(row => row.id === claim.id)).toMatchObject({ status: "done" });
  expect(rows(f.db, "notes")).toHaveLength(1);
  expect(rows(f.db, "notes")[0]!.repo_name).toBe("known");
  expect(pending(f.db)).toEqual([]);
});

it("persists a note with a null repository when every capture's metadata is corrupt", async () => {
  const f = fixture();
  f.capture({ metadata: "bad JSON" });
  f.capture({ metadata: "[]" });
  const claim = f.claim();
  await runDistillJob(f.db, claim, f.deps);
  expect(rows(f.db, "jobs").find(row => row.id === claim.id)).toMatchObject({ status: "done" });
  expect(rows(f.db, "notes")[0]!.repo_name).toBeNull();
  expect(pending(f.db)).toEqual([]);
});

it("orders timestamp ties by creation time then insertion order and isolates conversations", async () => {
  const f = fixture();
  const captured_at = "2025-01-01T00:00:00.000Z";
  f.capture({ prompt: "second", captured_at, created_at: "2025-01-03T00:00:00.000Z" });
  f.capture({ prompt: "first", captured_at, created_at: "2025-01-02T00:00:00.000Z" });
  f.capture({ prompt: "third", captured_at, created_at: "2025-01-03T00:00:00.000Z" });
  const other = f.capture({ site: "other", prompt: "excluded" });
  await runDistillJob(f.db, f.claim(), f.deps);
  const prompt = f.completeJSON.mock.calls[0]![0].prompt.slice(DISTILL_PROMPT.length);
  expect(prompt.indexOf("first")).toBeLessThan(prompt.indexOf("second"));
  expect(prompt.indexOf("second")).toBeLessThan(prompt.indexOf("third"));
  expect(prompt).not.toContain("excluded");
  expect(pending(f.db)).toEqual([{ id: other }]);
  expect(rows(f.db, "notes")[0]!.repo_name).toBeNull();
});

it("keeps a concurrent capture pending and includes it on the next full-history drain", async () => {
  const f = fixture();
  const hook = f.connect();
  f.capture();
  let arrived = "";
  f.completeJSON.mockImplementationOnce(async () => {
    expect(f.db.inTransaction).toBe(false);
    arrived = f.capture({ prompt: "arrived during inference" }, hook);
    return JSON.stringify(f.output());
  });
  await runDistillJob(f.db, f.claim(), f.deps);
  expect(pending(f.db)).toEqual([{ id: arrived }]);
  expect(rows(f.db, "notes")[0]!.turn_count).toBe(1);
  await runDistillJob(f.db, f.claim(), f.deps);
  expect(pending(f.db)).toEqual([]);
  expect(rows(f.db, "notes")[0]!.turn_count).toBe(2);
  expect(f.completeJSON.mock.calls[1]![0].prompt).toContain("arrived during inference");
  expect(f.completeJSON.mock.calls[1]![0].prompt).toContain("prompt 1");
});

it("fully replaces notes while keeping surviving decision rows and vectors exactly intact", async () => {
  const f = fixture();
  f.capture();
  await runDistillJob(f.db, f.claim(), f.deps);
  const oldNote = rows(f.db, "notes")[0]!;
  const surviving = decisionState(f.db, f.output().decisions[0]!);
  const dropped = decisionState(f.db, f.output().decisions[1]!);
  const oldVector = rows(f.db, "note_vec")[0]!.embedding;
  f.advance(1000);
  f.capture();
  f.setOutput({ topic: "replacement", summary: "changed direction", context: "new problem", tags: ["vec0"],
    key_details: [], derived_conclusions: [], code_implementation: [], preferences_corrections: [], open_threads: [],
    decisions: ["chose   sqlite for LOCAL storage", "Added vectors for retrieval", " added\tVECTORS for retrieval "],
  });
  f.embed.mockImplementationOnce(async (texts) => texts.map(() => new Float32Array([9, 8, 7])));
  await runDistillJob(f.db, f.claim(), f.deps);
  expect(rows(f.db, "notes")[0]).toMatchObject({
    id: oldNote.id, topic: "replacement", summary: "changed direction", turn_count: 2, entity_tags: '["vec0"]',
    compacted_text: "**Topic**: replacement\n\n**One-line summary**: changed direction\n\n**Context**: new problem\n\n**Decisions & Reasoning**:\n- chose   sqlite for LOCAL storage\n- Added vectors for retrieval\n- added\tVECTORS for retrieval",
  });
  expect(rows(f.db, "note_vec")[0]!.embedding).not.toEqual(oldVector);
  expect(decisionState(f.db, "chose sqlite for local storage")).toEqual(surviving);
  expect(f.db.prepare("SELECT * FROM decisions WHERE id = ?").get(dropped.row.id)).toBeUndefined();
  expect(f.db.prepare("SELECT * FROM decision_vec WHERE decision_id = ?").get(dropped.row.id)).toBeUndefined();
  expect(rows(f.db, "decisions")).toHaveLength(2);
  expect(rows(f.db, "decision_vec")).toHaveLength(2);
  expect(decisionState(f.db, "Added vectors for retrieval").row.decided_at).toBe(f.clock.now().toISOString());
});

it.each([false, true])("preserves ratified rows and vectors, including a matching hash (match=%s)", async (matching) => {
  const f = fixture();
  f.capture();
  await runDistillJob(f.db, f.claim(), f.deps);
  const id = randomUUID();
  const text = "Kept a ratified decision";
  f.db.transaction(() => {
    f.db.prepare(`INSERT INTO decisions (id, note_id, decision_text, content_hash, provenance, human_quote, decided_at, created_at)
      VALUES (?, ?, ?, ?, 'ratified', 'approved', ?, ?)`)
      .run(id, rows(f.db, "notes")[0]!.id, text, hash(text), f.clock.now().toISOString(), f.clock.now().toISOString());
    f.db.prepare("INSERT INTO decision_vec (decision_id, embedding) VALUES (?, ?)").run(id, new Float32Array([8, 7, 6]));
  })();
  const before = decisionState(f.db, text);
  f.capture();
  f.setOutput({ decisions: matching ? [text] : [] });
  await runDistillJob(f.db, f.claim(), f.deps);
  expect(decisionState(f.db, text)).toEqual(before);
  expect(rows(f.db, "decisions")).toHaveLength(1);
  expect(rows(f.db, "decision_vec")).toHaveLength(1);
});

it.each([false, true])("rolls back every stale-worker business write (replacement worker persisted=%s)", async (persist) => {
  const f = fixture();
  const workerB = f.connect();
  f.capture();
  const stale = f.claim();
  let expected: ReturnType<typeof businessState> | undefined;
  let expectedJobs: ReturnType<typeof rows> | undefined;
  f.completeJSON.mockImplementationOnce(async () => {
    f.advance(300_001);
    const fresh = claimNext(workerB, f.clock)!;
    expect(fresh).toMatchObject({ id: stale.id, attempts: 2 });
    if (persist) {
      await runDistillJob(workerB, fresh, {
        ...f.deps,
        backend: { modelId: "new-worker", completeJSON: async () => JSON.stringify({ topic: "new worker", decisions: ["kept new decision"] }) },
      });
    } else {
      expect(completeJob(workerB, fresh, undefined, f.clock)).toBe(true);
    }
    expected = businessState(workerB);
    expectedJobs = rows(workerB, "jobs");
    return JSON.stringify(f.output());
  });
  await runDistillJob(f.db, stale, f.deps);
  expect(businessState(f.db)).toEqual(expected);
  expect(rows(f.db, "jobs")).toEqual(expectedJobs);
});

it("scrubs before chunking and unions every chunk in order", async () => {
  const f = fixture();
  const secret = "sk-abcdefghijklmnopqrstuvwxyz";
  f.capture({ prompt: "a".repeat(DISTILL_CONTENT_BUDGET - 11) + " " + secret + "\n" + "b".repeat(1000) });
  let chunkIndex = 0;
  f.completeJSON.mockImplementation(async ({ prompt }) => {
    expect(prompt).not.toContain(secret);
    expect(prompt.slice(DISTILL_PROMPT.length + 2).length).toBeLessThanOrEqual(DISTILL_CONTENT_BUDGET);
    return JSON.stringify({ topic: `topic ${++chunkIndex}`, summary: `summary ${chunkIndex}`, decisions: ["shared", `decision ${chunkIndex}`] });
  });
  await runDistillJob(f.db, f.claim(), f.deps);
  expect(chunkIndex).toBeGreaterThan(1);
  const joined = f.completeJSON.mock.calls.map(([req]) => req.prompt.slice(DISTILL_PROMPT.length + 2)).join("");
  expect(joined).toContain("[REDACTED]");
  expect(joined).not.toContain(secret);
  expect(rows(f.db, "notes")[0]).toMatchObject({ topic: "topic 1", summary: Array.from({ length: chunkIndex }, (_, i) => `summary ${i + 1}`).join("; ") });
  expect(rows(f.db, "decisions")).toHaveLength(chunkIndex + 1);
  expect(f.embed).toHaveBeenCalledTimes(1);
});

describe("retryable failures leave no partial business writes", () => {
  it.each(["backend", "parse", "embed", "dimension", "count", "nan", "db-dimension", "write", "later-chunk"])(
    "requeues with backoff for %s failure", async (failure) => {
      const f = fixture();
      f.capture(failure === "later-chunk" ? { prompt: "x".repeat(100_100) } : {});
      if (failure === "backend") f.completeJSON.mockRejectedValueOnce(new Error("backend unavailable"));
      if (failure === "parse") f.completeJSON.mockResolvedValueOnce("invalid JSON");
      if (failure === "embed") f.embed.mockRejectedValueOnce(new Error("embed unavailable"));
      if (failure === "dimension") f.embed.mockResolvedValueOnce([new Float32Array(2), new Float32Array(3), new Float32Array(3)]);
      if (failure === "count") f.embed.mockResolvedValueOnce([]);
      if (failure === "nan") f.embed.mockResolvedValueOnce([new Float32Array([NaN, 1, 2]), new Float32Array(3), new Float32Array(3)]);
      if (failure === "db-dimension") f.db.transaction(() => {
        f.db.exec("DROP TABLE decision_vec; DROP TABLE note_vec");
        createVecTables(f.db, 4);
      })();
      if (failure === "write") f.db.exec(`CREATE TRIGGER reject_stamp BEFORE UPDATE OF distilled_at ON captures BEGIN SELECT RAISE(ABORT, 'stamp failed'); END`);
      if (failure === "later-chunk") f.completeJSON.mockResolvedValueOnce(JSON.stringify(f.output())).mockRejectedValueOnce(new Error("later chunk failed"));
      const claim = f.claim();
      const before = businessState(f.db);
      await runDistillJob(f.db, claim, f.deps);
      expect(businessState(f.db)).toEqual(before);
      expect(rows(f.db, "jobs")).toHaveLength(1);
      expect(rows(f.db, "jobs")[0]).toMatchObject({
        status: "queued", attempts: 1, lease_until: null,
        run_after: new Date(f.clock.now().getTime() + 30_000).toISOString(),
      });
      expect(rows(f.db, "jobs")[0]!.last_error).toEqual(expect.any(String));
      expect(claimNext(f.db, f.clock)).toBeNull();
      f.advance(30_000);
      expect(claimNext(f.db, f.clock)).toMatchObject({ id: claim.id, attempts: 2 });
    },
  );

  it("records a backend timeout as retryable", async () => {
    const f = fixture();
    f.capture();
    vi.useFakeTimers();
    f.completeJSON.mockImplementation(({ timeoutMs }) => new Promise((_, reject) => {
      setTimeout(() => reject(new Error("backend timed out")), timeoutMs);
    }));
    const claim = f.claim();
    const run = runDistillJob(f.db, claim, f.deps);
    await vi.advanceTimersByTimeAsync(60_000);
    await run;
    expect(rows(f.db, "jobs")[0]).toMatchObject({ status: "queued", last_error: "backend timed out" });
    expect(rows(f.db, "notes")).toEqual([]);
    expect(pending(f.db)).toHaveLength(1);
  });
});

it("stamps every snapshot id across parameter batches without touching a late arrival", async () => {
  const f = fixture();
  f.db.transaction(() => {
    for (let index = 0; index < 503; index++) f.capture();
  })();
  let late = "";
  f.embed.mockImplementationOnce(async (texts) => {
    late = f.capture({ prompt: "late arrival during embedding" }, f.connect());
    return texts.map(() => new Float32Array([1, 2, 3]));
  });
  await runDistillJob(f.db, f.claim(), f.deps);
  expect(rows(f.db, "notes")[0]!.turn_count).toBe(503);
  expect(pending(f.db)).toEqual([{ id: late }]);
  expect(rows(f.db, "captures").filter((row) => row.distilled_at === f.clock.now().toISOString())).toHaveLength(503);
});

it("rolls back downstream enqueue and all business writes if the final job-status update fails", async () => {
  const f = fixture();
  f.capture();
  const claim = f.claim();
  f.db.exec(`CREATE TRIGGER reject_completion BEFORE UPDATE OF status ON jobs
    WHEN NEW.status = 'done' BEGIN SELECT RAISE(ABORT, 'completion failed'); END`);
  const before = businessState(f.db);
  await runDistillJob(f.db, claim, f.deps);
  expect(businessState(f.db)).toEqual(before);
  expect(rows(f.db, "jobs")).toHaveLength(1);
  expect(rows(f.db, "jobs")[0]).toMatchObject({ id: claim.id, status: "queued", last_error: "completion failed" });
});
