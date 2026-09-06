import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { openDb, type Db } from "../../db/open.js";
import { completeJob, enqueueJob } from "../../jobs/queue.js";
import { importSession } from "../import.js";
import { backfillHoneurReport, planBackfill } from "../report.js";
import { next, now, session, snapshot } from "./fixtures.js";

let dir: string;
let db: Db;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "backfill-report-"));
  db = openDb({ dbPath: path.join(dir, "memory.db") });
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function scan(n: number) {
  return { transcripts: Array.from({ length: n }, (_, i) => ({ path: `${i}.jsonl`, mtimeMs: n - i, sizeBytes: 100 })) };
}

it("derives pending captures from the database even when a run job is done", () => {
  const file = session(dir, "one");
  importSession(db, file);
  const snap = snapshot([file]);
  enqueueJob(db, "backfill", { snapshot: snap, pageSize: 1, pageCursor: 1 }, { now });
  completeJob(db, next(db), undefined, { now });
  const report = backfillHoneurReport(db, snap);
  expect(report).toMatchObject({ status: "partial", undistilledCount: 1, omittedCount: 0, omittedAgeRange: null });
  expect(report.message).toContain("0 omitted sessions");
  expect(report.message).toContain("age range: none");
  expect(report.message).toContain("backfill --all");
  expect(report.message).toContain("backfill --slow");
  db.transaction(() => db.prepare("UPDATE captures SET distilled_at = ?").run(now().toISOString()))();
  expect(backfillHoneurReport(db, snap).status).toBe("complete");
});

it("remains partial for omitted sessions with no pending captures and formats both age bounds", () => {
  const report = backfillHoneurReport(db, snapshot([], ["old", "new"]));
  expect(report).toMatchObject({ status: "partial", undistilledCount: 0, omittedCount: 2,
    omittedAgeRange: { oldest: "1970-01-01T00:00:01.000Z", newest: "1970-01-01T00:00:02.000Z" } });
  expect(report.message).toContain("2 omitted sessions");
  expect(report.message).toContain(report.omittedAgeRange!.oldest);
  expect(report.message).toContain(report.omittedAgeRange!.newest);
  expect(report.message).toContain("backfill --all");
  expect(report.message).toContain("backfill --slow");
});

it("counts pending captures outside the snapshot, and ignores queue status entirely", () => {
  expect(backfillHoneurReport(db, snapshot([])).status).toBe("complete");
  enqueueJob(db, "backfill", {}, { now });
  expect(backfillHoneurReport(db, snapshot([])).status).toBe("complete");
  importSession(db, session(dir, "unrelated"));
  expect(backfillHoneurReport(db, snapshot([]))).toMatchObject({ status: "partial", undistilledCount: 1 });
});

it("defaults to a cap of 50 and accepts an explicit subscription limit", () => {
  expect(planBackfill(scan(300))).toMatchObject({ limit: 50, needsCostConfirm: false });
  expect(planBackfill(scan(300), { limit: 73 })).toMatchObject({ limit: 73, needsCostConfirm: false });
  expect(planBackfill(scan(300), { limit: 0 }).limit).toBe(0);
});

it.each([0, 200, 201, 300])("plans uncapped API work with confirmation only above 200 (%s sessions)", n => {
  const plan = planBackfill(scan(n), { all: true, lane: "api-key" });
  expect(plan).toMatchObject({ limit: n, needsCostConfirm: n > 200 });
  expect(plan.estimate).toContain("API cost estimate");
  expect(plan.estimate).toContain(`${n} sessions`);
});

it("plans uncapped Ollama work with a time estimate and no cost confirmation", () => {
  const plan = planBackfill(scan(301), { all: true, lane: "ollama" });
  expect(plan).toMatchObject({ limit: 301, needsCostConfirm: false });
  expect(plan.estimate).toContain("Local time estimate: 301 sessions");
});

it.each([-1, 0.5, NaN, Infinity])("rejects invalid plan limit %s", limit => {
  expect(() => planBackfill(scan(3), { limit })).toThrow(/limit/);
});

it("refuses ambiguous flags and all without an eligible backend", () => {
  expect(() => planBackfill(scan(3), { all: true })).toThrow(/API key or Ollama/);
  expect(() => planBackfill(scan(3), { all: true, lane: "api-key", limit: 2 })).toThrow(/mutually exclusive/);
});
