import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { getMeta, openDb, type Db } from "../../db/open.js";
import { enqueueJob, enqueueCoalesced, failJob, retryFailed, type JobClaim } from "../../jobs/queue.js";
import { dispatchJob, type BackfillRunPayload, type BackfillPagePayload } from "../jobs.js";
import { backfillHoneurReport } from "../report.js";
import { count, later, next, now, pair, session, snapshot } from "./fixtures.js";

let dir: string;
let db: Db;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "backfill-jobs-"));
  db = openDb({ dbPath: path.join(dir, "memory.db") });
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function run(selected: string[], pageSize = 2): string {
  return enqueueJob(db, "backfill", { snapshot: snapshot(selected), pageSize, pageCursor: 0 }, { now });
}
function payload(id: string): BackfillRunPayload & BackfillPagePayload {
  return JSON.parse((db.prepare("SELECT payload FROM jobs WHERE id = ?").get(id) as { payload: string }).payload);
}
function distills(): string[] {
  return (db.prepare("SELECT json_extract(payload, '$.conversation_id') AS conversation FROM jobs WHERE kind = 'distill' ORDER BY conversation")
    .all() as Array<{ conversation: string }>).map(row => row.conversation);
}
function drainPage(): JobClaim {
  const page = next(db);
  expect(page.kind).toBe("backfill-page");
  expect(dispatchJob(db, page, { now }).status).toBe("done");
  return page;
}

it("holds the import-before-distill barrier across every page and coalesces conversations", () => {
  const files = [session(dir, "one", pair("shared", "a1")), session(dir, "two", pair("other", "a2")),
    session(dir, "three", pair("shared", "a3"))];
  const id = run(files);
  const parent = next(db);
  expect(dispatchJob(db, parent, { now }).status).toBe("rescheduled");
  expect(payload(id).pageCursor).toBe(3);
  expect(count(db, "jobs", "kind = 'backfill-page'")).toBe(2);
  expect(count(db, "captures")).toBe(0);
  expect(distills()).toEqual([]);
  drainPage();
  expect(count(db, "captures")).toBe(2);
  expect(distills()).toEqual([]);
  drainPage();
  expect(count(db, "captures")).toBe(3);
  expect(distills()).toEqual([]);
  expect(count(db, "jobs", "kind = 'backfill-page' AND status = 'done'")).toBe(2);
  const resumed = next(db, later);
  expect(resumed.id).toBe(id);
  expect(dispatchJob(db, resumed, { now: later })).toMatchObject({ status: "done", result: {
    status: "complete", inserted: 3, conversationsTouched: ["other", "shared"], failures: [], failedPages: [],
  } });
  expect(distills()).toEqual(["other", "shared"]);
  expect(dispatchJob(db, resumed, { now: later }).status).toBe("stale");
  expect(distills()).toEqual(["other", "shared"]);
  expect(next(db, later).kind).toBe("distill");
});

it.each(["queued", "running", "done", "failed"])("resumes an expired parent without duplicating its %s first page", state => {
  const files = [session(dir, "one", pair("one")), session(dir, "two", pair("two")), session(dir, "three", pair("three"))];
  const id = run(files);
  const abandoned = next(db);
  // Durable state at the crash boundary: one dispatched slice, no cursor update.
  const firstId = enqueueCoalesced(db, "backfill-page", { runJobId: id, sliceStart: 0, sliceEnd: 2 }, { now });
  if (state !== "queued") {
    const first = next(db);
    expect(first.id).toBe(firstId);
    if (state === "done") expect(dispatchJob(db, first, { now }).status).toBe("done");
    if (state === "failed") expect(failJob(db, first, "page lost", { now, fatal: true })).toBe("dead-letter");
  }
  const reclaimed = next(db, later);
  expect(reclaimed.id).toBe(id);
  expect(reclaimed.attempts).toBe(abandoned.attempts + 1);
  expect(dispatchJob(db, abandoned, { now: later }).status).toBe("stale");
  expect(dispatchJob(db, reclaimed, { now: later }).status).toBe("rescheduled");
  expect(count(db, "jobs", "kind = 'backfill-page'")).toBe(2);
  expect(payload(id).pageCursor).toBe(3);
  while (count(db, "jobs", "kind = 'backfill-page' AND status IN ('queued','running')") > 0) {
    const page = next(db, later);
    expect(page.kind).toBe("backfill-page");
    expect(dispatchJob(db, page, { now: later }).status).toBe("done");
    expect(distills()).toEqual([]);
  }
  const afterPoll = () => new Date(later().getTime() + 60_000);
  expect(dispatchJob(db, next(db, afterPoll), { now: afterPoll }).status).toBe("done");
  expect(distills()).toEqual(state === "failed" ? ["three"] : ["one", "three", "two"]);
  expect(payload(id).result?.status).toBe(state === "failed" ? "partial" : "complete");
});

it("commits a dispatched slice and cursor together when the next dispatch fails", () => {
  const id = run([session(dir, "one"), session(dir, "two")], 1);
  db.exec(`CREATE TRIGGER reject_second_page BEFORE INSERT ON jobs
    WHEN NEW.kind = 'backfill-page' AND json_extract(NEW.payload, '$.sliceStart') = 1
    BEGIN SELECT RAISE(ABORT, 'dispatch crash'); END`);
  expect(dispatchJob(db, next(db), { now }).status).toBe("requeued");
  expect(payload(id).pageCursor).toBe(1);
  expect(count(db, "jobs", "kind = 'backfill-page'")).toBe(1);
  db.exec("DROP TRIGGER reject_second_page");
  expect(dispatchJob(db, next(db, later), { now: later }).status).toBe("rescheduled");
  expect(payload(id).pageCursor).toBe(2);
  expect(count(db, "jobs", "kind = 'backfill-page'")).toBe(2);
});

it("persists per-session failures, imports the rest, and reports partial with both escape hatches", () => {
  const good = session(dir, "good", pair("good"));
  const bad = session(dir, "bad", "not json\n{\n");
  const missing = path.join(dir, "missing.jsonl");
  const snap = snapshot([missing, good, bad], ["omitted.jsonl"]);
  const id = enqueueJob(db, "backfill", { snapshot: snap, pageSize: 3, pageCursor: 0 }, { now });
  dispatchJob(db, next(db), { now });
  const page = drainPage();
  expect(payload(page.id).result).toMatchObject({ inserted: 1, conversationsTouched: ["good"],
    failures: [{ path: missing, error: expect.stringContaining("ENOENT") },
      { path: bad, parseErrors: 2, error: "2 malformed transcript records" }] });
  expect(JSON.parse(getMeta(db, "parse_errors")!)[bad].count).toBe(2);
  expect(dispatchJob(db, next(db, later), { now: later })).toMatchObject({ status: "done", result: { status: "partial" } });
  expect(payload(id).result?.failures).toHaveLength(2);
  expect(distills()).toEqual(["good"]);
  const report = backfillHoneurReport(db, snap);
  expect(report).toMatchObject({ status: "partial", omittedCount: 1, undistilledCount: 1 });
  expect(report.message).toContain("backfill --all");
  expect(report.message).toContain("backfill --slow");
});

it("waits for other pages even after a page dead-letters, then records that failure", () => {
  const id = run([session(dir, "one", pair("one")), session(dir, "two", pair("two"))], 1);
  dispatchJob(db, next(db), { now });
  const failed = next(db);
  failJob(db, failed, "unrecoverable page", { now, fatal: true });
  const poll = next(db, later);
  expect(poll.id).toBe(id);
  expect(dispatchJob(db, poll, { now: later }).status).toBe("rescheduled");
  expect(distills()).toEqual([]);
  expect(dispatchJob(db, next(db, later), { now: later }).status).toBe("done");
  const afterPoll = () => new Date(later().getTime() + 60_000);
  expect(dispatchJob(db, next(db, afterPoll), { now: afterPoll })).toMatchObject({ status: "done", result: {
    status: "partial", failedPages: [{ jobId: failed.id, error: "unrecoverable page" }],
  } });
  expect(distills()).toEqual(["two"]);
});

it("rolls back imports and parse accounting if page result persistence fails", () => {
  run([session(dir, "one", pair() + "bad\n")]);
  dispatchJob(db, next(db), { now });
  const page = next(db);
  db.exec(`CREATE TRIGGER reject_result BEFORE UPDATE OF payload ON jobs WHEN NEW.kind = 'backfill-page'
    BEGIN SELECT RAISE(ABORT, 'result crash'); END`);
  expect(dispatchJob(db, page, { now }).status).toBe("requeued");
  expect(count(db, "captures")).toBe(0);
  expect(getMeta(db, "parse_errors")).toBeUndefined();
  expect(payload(page.id).result).toBeUndefined();
  expect(distills()).toEqual([]);
});

it("rolls back all distills and parent completion if final enqueue fails, then resumes", () => {
  const id = run([session(dir, "one", pair("one") + pair("two", "a2"))]);
  dispatchJob(db, next(db), { now });
  drainPage();
  db.exec(`CREATE TRIGGER reject_distill BEFORE INSERT ON jobs
    WHEN NEW.kind = 'distill' AND json_extract(NEW.payload, '$.conversation_id') = 'two'
    BEGIN SELECT RAISE(ABORT, 'distill crash'); END`);
  expect(dispatchJob(db, next(db, later), { now: later }).status).toBe("requeued");
  expect(distills()).toEqual([]);
  expect(payload(id).result).toBeUndefined();
  db.exec("DROP TRIGGER reject_distill");
  const afterPoll = () => new Date(later().getTime() + 60_000);
  expect(dispatchJob(db, next(db, afterPoll), { now: afterPoll }).status).toBe("done");
  expect(distills()).toEqual(["one", "two"]);
});

it("rejects stale page attempts and epochs before importing anything", () => {
  run([session(dir, "one")]);
  dispatchJob(db, next(db), { now });
  const stale = next(db);
  failJob(db, stale, "failed", { now, fatal: true });
  retryFailed(db, { now });
  const current = next(db);
  expect(current.attempts).toBe(stale.attempts);
  expect(current.epoch).toBe(stale.epoch + 1);
  expect(dispatchJob(db, stale, { now }).status).toBe("stale");
  expect(count(db, "captures")).toBe(0);
  expect(dispatchJob(db, current, { now }).status).toBe("done");
});

it("rolls back page writes when its fence is lost at completion", () => {
  run([session(dir, "one", pair() + "bad\n")]);
  dispatchJob(db, next(db), { now });
  const page = next(db);
  // Fault injection between the business writes and completeJob's fence check.
  db.exec(`CREATE TRIGGER lose_page_fence AFTER UPDATE OF payload ON jobs
    WHEN NEW.kind = 'backfill-page'
    BEGIN UPDATE jobs SET attempts = attempts + 1 WHERE id = NEW.id; END`);
  expect(dispatchJob(db, page, { now }).status).toBe("stale");
  expect(count(db, "captures")).toBe(0);
  expect(getMeta(db, "parse_errors")).toBeUndefined();
  expect(payload(page.id).result).toBeUndefined();
  expect(distills()).toEqual([]);
});

it("polls without consuming the retry budget: many cycles never dead-letter the run", () => {
  // Polling is a reschedule, not a failure, so it must NOT dead-letter at
  // attempt 5 the way failJob would. The run stays alive across many poll
  // cycles and never duplicates its page.
  const id = run([session(dir, "one")]);
  for (let attempt = 1; attempt <= 8; attempt++) {
    const clock = () => new Date(now().getTime() + attempt * 3_600_000);
    const parent = next(db, clock);
    expect(parent.id).toBe(id);
    expect(dispatchJob(db, parent, { now: clock }).status).toBe("rescheduled");
    expect(distills()).toEqual([]);
    expect((db.prepare("SELECT status FROM jobs WHERE id = ?").get(id) as { status: string }).status).not.toBe("failed");
  }
  expect(count(db, "jobs", "kind = 'backfill-page'")).toBe(1);
  // Drain the page just before the run's next reschedule fires, then the run completes.
  const drainAt = () => new Date(now().getTime() + 8 * 3_600_000 + 1_000);
  const page = next(db, drainAt);
  expect(page.kind).toBe("backfill-page");
  expect(dispatchJob(db, page, { now: drainAt }).status).toBe("done");
  const finish = () => new Date(now().getTime() + 9 * 3_600_000);
  expect(dispatchJob(db, next(db, finish), { now: finish }).status).toBe("done");
  expect(count(db, "jobs", "kind = 'backfill-page'")).toBe(1);
  expect(distills()).toEqual(["s1"]);
});

it("does not rescan when new transcripts appear after dispatch", () => {
  const id = run([session(dir, "one", pair("one"))]);
  dispatchJob(db, next(db), { now });
  session(dir, "new", pair("new"));
  drainPage();
  dispatchJob(db, next(db, later), { now: later });
  expect(payload(id).snapshot.selected).toHaveLength(1);
  expect(distills()).toEqual(["one"]);
});

it("completes an empty run without pages or distills", () => {
  run([]);
  expect(dispatchJob(db, next(db), { now })).toMatchObject({ status: "done", result: { inserted: 0 } });
  expect(count(db, "jobs")).toBe(1);
});

it.each([0, -1, 1.5, "2"])("reports an invalid page size %s without enqueuing pages", pageSize => {
  enqueueJob(db, "backfill", { snapshot: snapshot(["file.jsonl"]), pageSize, pageCursor: 0 }, { now });
  expect(dispatchJob(db, next(db), { now }).status).toBe("requeued");
  expect(count(db, "jobs")).toBe(1);
});

it("reports invalid slices and missing parents instead of importing arbitrary paths", () => {
  const id = run([session(dir, "one")]);
  const parent = next(db);
  enqueueJob(db, "backfill-page", { runJobId: id, sliceStart: 0, sliceEnd: 999 }, { now });
  expect(dispatchJob(db, next(db), { now }).status).toBe("requeued");
  enqueueJob(db, "backfill-page", { runJobId: "missing", sliceStart: 0, sliceEnd: 1 }, { now });
  expect(dispatchJob(db, next(db), { now }).status).toBe("requeued");
  expect(count(db, "captures")).toBe(0);
  expect(parent.kind).toBe("backfill");
});

it("explicitly rejects job kinds delegated to the M12 dispatcher", () => {
  enqueueJob(db, "distill", { site: "claude-code", conversation_id: "one" }, { now });
  expect(() => dispatchJob(db, next(db), { now })).toThrow(/Unsupported/);
});
