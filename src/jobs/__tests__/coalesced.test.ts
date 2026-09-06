import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDb, type Db } from "../../db/open.js";
import { claimNext, completeJob, enqueueCoalesced, enqueueDistill, enqueueJob, failJob } from "../queue.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "terum-coalesced-"));
  const dbPath = path.join(dir, "terum.db");
  const db = openDb({ dbPath });
  const other = openDb({ dbPath });
  cleanup.push(() => { other.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  const now = () => new Date("2026-01-01T00:00:00.000Z");
  return { db, other, clock: { now } };
}

it("deduplicates queued byte-identical payloads across connections and preserves the original schedule", () => {
  const { db, other, clock } = fixture();
  const runAfter = new Date("2026-01-02T00:00:00.000Z");
  const id = enqueueCoalesced(db, "link-cluster", { value: "雪'" }, { ...clock, runAfter });
  const before = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
  expect(enqueueCoalesced(other, "link-cluster", { value: "雪'" }, clock)).toBe(id);
  expect(db.prepare("SELECT * FROM jobs WHERE id = ?").get(id)).toEqual(before);
  expect(claimNext(db, clock)).toBeNull();
});

it("keeps distinct serialized bytes and kinds separate, without changing enqueueJob or enqueueDistill", () => {
  const { db, clock } = fixture();
  const a = enqueueCoalesced(db, "link-cluster", { a: 1, b: 2 }, clock);
  const b = enqueueCoalesced(db, "link-cluster", { b: 2, a: 1 }, clock);
  const c = enqueueCoalesced(db, "link-cluster", { a: 2, b: 2 }, clock);
  const d = enqueueCoalesced(db, "backfill", { a: 1, b: 2 }, clock);
  const e = enqueueJob(db, "link-cluster", { a: 1, b: 2 }, clock);
  expect(new Set([a, b, c, d, e]).size).toBe(5);
  expect(enqueueCoalesced(db, "link-cluster", { a: 1, b: 2 }, clock)).toBe(a);
  const semantic = enqueueJob(db, "distill", { conversation_id: "c", site: "s", extra: true }, clock);
  expect(enqueueDistill(db, "s", "c", clock)).toBe(semantic);
  expect(enqueueCoalesced(db, "distill", { site: "s", conversation_id: "c" }, clock)).not.toBe(semantic);
});

it("does not coalesce running, done, or failed jobs", () => {
  const { db, clock } = fixture();
  const a = enqueueCoalesced(db, "backfill", {}, clock);
  const running = claimNext(db, clock)!;
  const b = enqueueCoalesced(db, "backfill", {}, clock);
  expect(b).not.toBe(a);
  completeJob(db, running, undefined, clock);
  const next = claimNext(db, clock)!;
  failJob(db, next, "failed", { ...clock, fatal: true });
  const c = enqueueCoalesced(db, "backfill", {}, clock);
  expect(new Set([a, b, c]).size).toBe(3);
});

it("serializes once even for stateful toJSON payloads", () => {
  const { db, clock } = fixture();
  let calls = 0;
  const id = enqueueCoalesced(db, "link-cluster", { toJSON: () => ({ call: ++calls }) }, clock);
  expect(calls).toBe(1);
  expect(db.prepare("SELECT payload FROM jobs WHERE id = ?").get(id)).toEqual({ payload: '{"call":1}' });
});

it("rejects unsupported kinds and nonserializable payloads without writes", () => {
  const { db, clock } = fixture();
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  expect(() => enqueueCoalesced(db, "constructor", {}, clock)).toThrow(/Unknown job kind/);
  for (const payload of [undefined, 1n, cyclic]) {
    expect(() => enqueueCoalesced(db, "link-cluster", payload, clock)).toThrow();
  }
  expect(db.prepare("SELECT * FROM jobs").all()).toEqual([]);
});

it("rolls back coalesced inserts with an enclosing business transaction", () => {
  const { db, clock } = fixture();
  expect(() => db.transaction(() => {
    enqueueCoalesced(db, "link-cluster", {}, clock);
    throw new Error("rollback");
  })()).toThrow("rollback");
  expect(db.prepare("SELECT * FROM jobs").all()).toEqual([]);
});
