import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../../db/open.js";
import {
  backoffMs, claimNext, completeJob, enqueueDistill, enqueueJob,
  failJob, queueCounts, renewLease, rescheduleJob, retryFailed,
} from "../queue.js";
import { JOB_KINDS, type JobClaim } from "../types.js";

const cleanup: Array<() => void> = [];

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "terum-queue-"));
  const dbPath = path.join(dir, "terum.db");
  const connections: Db[] = [];
  cleanup.push(() => {
    for (const connection of connections) connection.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const connect = () => {
    const db = openDb({ dbPath });
    connections.push(db);
    return db;
  };
  let time = Date.parse("2026-01-01T00:00:00.000Z");
  const clock = { now: () => new Date(time) };
  return {
    db: connect(), connect, clock,
    advance: (ms: number) => { time += ms; },
  };
}

afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

interface Row {
  id: string;
  kind: string;
  payload: string;
  status: string;
  attempts: number;
  last_error: string | null;
  run_after: string | null;
  lease_until: string | null;
  created_at: string;
  updated_at: string;
}

function row(db: Db, id: string): Row {
  return db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Row;
}

function claim(db: Db, clock: { now: () => Date }, leaseMs?: number): JobClaim {
  const result = claimNext(db, { ...clock, leaseMs });
  expect(result).not.toBeNull();
  return result!;
}

describe("enqueue and claim", () => {
  it("returns null and zero counts for an empty queue", () => {
    const { db, clock } = fixture();
    expect(claimNext(db, clock)).toBeNull();
    expect(queueCounts(db)).toEqual({ queued: 0, running: 0, done: 0, failed: 0 });
  });

  it("round-trips JSON, creates UUIDv4 ids, and stamps a five-minute first lease", () => {
    const { db, clock, advance } = fixture();
    const payload = { nested: [null, true, 0, "雪\"'"], object: { value: 42 } };
    const id = enqueueJob(db, "backfill-page", payload, clock);
    expect(id).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
    expect(row(db, id)).toMatchObject({ status: "queued", attempts: 0, created_at: clock.now().toISOString() });
    advance(1_000);
    expect(claim(db, clock)).toEqual({ id, kind: "backfill-page", payload, attempts: 1, epoch: 0 });
    expect(row(db, id)).toMatchObject({
      status: "running", attempts: 1, updated_at: clock.now().toISOString(),
      lease_until: new Date(clock.now().getTime() + 300_000).toISOString(),
    });
    expect(claimNext(db, clock)).toBeNull();
  });

  it.each(JOB_KINDS)("accepts the supported kind %s", (kind) => {
    const { db, clock } = fixture();
    const id = enqueueJob(db, kind, {}, clock);
    expect(claim(db, clock)).toMatchObject({ id, kind });
  });

  it.each(["", "DISTILL", " distill", "constructor", "toString", "unknown"])(
    "rejects unknown kind %j without inserting", (kind) => {
      const { db, clock } = fixture();
      expect(() => enqueueJob(db, kind, {}, clock)).toThrow(/Unknown job kind/);
      expect(queueCounts(db).queued).toBe(0);
    },
  );

  it("rejects unencodable payloads without inserting", () => {
    const { db, clock } = fixture();
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    for (const payload of [undefined, 1n, cyclic]) {
      expect(() => enqueueJob(db, "backfill", payload, clock)).toThrow();
    }
    expect(queueCounts(db).queued).toBe(0);
  });

  it("selects oldest runnable rows and admits run_after at exact equality", () => {
    const { db, clock, advance } = fixture();
    const scheduled = enqueueJob(db, "backfill", {}, {
      ...clock, runAfter: new Date(clock.now().getTime() + 10_000),
    });
    advance(1);
    const older = enqueueJob(db, "link-cluster", {}, clock);
    advance(1);
    const newer = enqueueJob(db, "backfill-page", {}, clock);
    expect(claim(db, clock).id).toBe(older);
    expect(claim(db, clock).id).toBe(newer);
    advance(9_997);
    expect(claimNext(db, clock)).toBeNull();
    advance(1);
    expect(claim(db, clock).id).toBe(scheduled);
  });

  it("rolls back claiming a malformed stored payload and surfaces the error", () => {
    const { db, clock } = fixture();
    const id = enqueueJob(db, "backfill", {}, clock);
    db.prepare("UPDATE jobs SET payload = 'invalid json' WHERE id = ?").run(id);
    const before = row(db, id);
    expect(() => claimNext(db, clock)).toThrow();
    expect(row(db, id)).toEqual(before);
  });
});

describe("leases and fencing across independent database connections", () => {
  it("renews a live lease and reclaims only strictly after its expiry", () => {
    const { db, connect, clock, advance } = fixture();
    const workerB = connect();
    enqueueJob(db, "backfill", {}, clock);
    const a = claim(db, clock, 1_000);
    advance(500);
    expect(renewLease(db, a, { ...clock, leaseMs: 2_000 })).toBe(true);
    expect(row(db, a.id).lease_until).toBe(new Date(clock.now().getTime() + 2_000).toISOString());
    advance(2_000);
    expect(claimNext(workerB, clock)).toBeNull();
    advance(1);
    expect(claim(workerB, clock)).toMatchObject({ id: a.id, attempts: 2 });
  });

  it("rescheduleJob is attempts-neutral, epoch-bumped, and fenced", () => {
    const { db, connect, clock, advance } = fixture();
    const workerB = connect();
    enqueueJob(db, "backfill", {}, clock);
    const a = claim(db, clock, 1_000);
    expect(a.attempts).toBe(1);
    // Reschedule: back to queued, attempts reset to 0, epoch bumped, run_after set.
    expect(rescheduleJob(db, a, 30_000, clock)).toBe(true);
    const after = row(db, a.id);
    expect(after.status).toBe("queued");
    expect(after.attempts).toBe(0);
    expect(after.run_after).toBe(new Date(clock.now().getTime() + 30_000).toISOString());
    // Not claimable until run_after passes.
    advance(29_999);
    expect(claimNext(workerB, clock)).toBeNull();
    advance(1);
    const b = claim(workerB, clock);
    // attempts climbed only from the fresh claim, never accumulated across polls.
    expect(b.attempts).toBe(1);
    expect(b.epoch).toBe(a.epoch + 1);
    // The original claim's token is now stale: its own reschedule writes nothing.
    expect(rescheduleJob(db, a, 30_000, clock)).toBe(false);
  });

  it("rejects every stale worker write and rolls back its business writes", () => {
    const { db, connect, clock, advance } = fixture();
    const workerB = connect();
    db.exec("CREATE TABLE probe (value TEXT)");
    enqueueJob(db, "backfill", {}, clock);
    const a = claim(db, clock, 1_000);
    advance(1_001);
    const b = claim(workerB, clock);
    expect(b).toMatchObject({ id: a.id, attempts: 2 });
    const before = row(workerB, b.id);
    advance(1);
    expect(renewLease(db, a, clock)).toBe(false);
    expect(row(db, a.id)).toEqual(before);
    expect(failJob(db, a, "stale failure", clock)).toBe("stale");
    expect(failJob(db, a, "stale fatal", { ...clock, fatal: true })).toBe("stale");
    expect(row(db, a.id)).toEqual(before);
    let callbackRan = false;
    expect(completeJob(db, a, (connection) => {
      callbackRan = true;
      connection.prepare("INSERT INTO probe VALUES (?)").run("stale");
    }, clock)).toBe(false);
    expect(callbackRan).toBe(true);
    expect(db.prepare("SELECT * FROM probe").all()).toEqual([]);
    expect(row(workerB, b.id)).toEqual(before);
  });

  it("keeps B's committed result exactly intact when stale A finishes last", () => {
    const { db, connect, clock, advance } = fixture();
    const workerB = connect();
    db.exec("CREATE TABLE probe (value TEXT)");
    enqueueJob(db, "link-cluster", {}, clock);
    const a = claim(db, clock, 1);
    advance(2);
    const b = claim(workerB, clock);
    expect(completeJob(workerB, b, (connection) => {
      connection.prepare("INSERT INTO probe VALUES (?)").run("B");
    }, clock)).toBe(true);
    const completed = row(workerB, b.id);
    expect(completed).toMatchObject({ status: "done", lease_until: null });
    advance(10);
    expect(completeJob(db, a, (connection) => {
      connection.exec("DELETE FROM probe");
      connection.prepare("INSERT INTO probe VALUES (?)").run("A");
    }, clock)).toBe(false);
    expect(row(db, a.id)).toEqual(completed);
    expect(db.prepare("SELECT * FROM probe").all()).toEqual([{ value: "B" }]);
  });

  it("propagates callback errors and rolls back both business and status writes", () => {
    const { db, clock } = fixture();
    db.exec("CREATE TABLE probe (value TEXT)");
    enqueueJob(db, "backfill", {}, clock);
    const current = claim(db, clock);
    const before = row(db, current.id);
    const error = new Error("business write failed");
    expect(() => completeJob(db, current, (connection) => {
      connection.exec("INSERT INTO probe VALUES ('partial')");
      throw error;
    }, clock)).toThrow(error);
    expect(row(db, current.id)).toEqual(before);
    expect(db.prepare("SELECT * FROM probe").all()).toEqual([]);
  });

  it.each([0, -1, NaN, Infinity])("rejects invalid lease duration %s", (leaseMs) => {
    const { db, clock } = fixture();
    const id = enqueueJob(db, "backfill", {}, clock);
    expect(() => claimNext(db, { ...clock, leaseMs })).toThrow(/leaseMs/);
    expect(row(db, id).attempts).toBe(0);
  });
});

describe("failure and introspection", () => {
  it("retries at 30/60/120/240 seconds then dead-letters the fifth failure", () => {
    const { db, clock, advance } = fixture();
    const id = enqueueJob(db, "backfill", {}, clock);
    for (const [index, delay] of [30_000, 60_000, 120_000, 240_000].entries()) {
      const current = claim(db, clock);
      expect(current.attempts).toBe(index + 1);
      expect(failJob(db, current, new Error(`failure ${index + 1}`), clock)).toBe("requeued");
      expect(row(db, id)).toMatchObject({
        status: "queued", lease_until: null, last_error: `failure ${index + 1}`,
        run_after: new Date(clock.now().getTime() + delay).toISOString(),
      });
      const before = row(db, id);
      expect(renewLease(db, current, clock)).toBe(false);
      expect(failJob(db, current, "duplicate", clock)).toBe("stale");
      expect(completeJob(db, current, undefined, clock)).toBe(false);
      expect(row(db, id)).toEqual(before);
      advance(delay - 1);
      expect(claimNext(db, clock)).toBeNull();
      advance(1);
    }
    const fifth = claim(db, clock);
    expect(fifth.attempts).toBe(5);
    expect(failJob(db, fifth, "poison", clock)).toBe("dead-letter");
    expect(row(db, id)).toMatchObject({ status: "failed", last_error: "poison", run_after: null, lease_until: null });
    expect(claimNext(db, clock)).toBeNull();
  });

  it("caps exponential backoff at thirty minutes, including very large attempts", () => {
    expect([5, 6, 7, 8, 100, 1025].map(backoffMs)).toEqual([
      480_000, 960_000, 1_800_000, 1_800_000, 1_800_000, 1_800_000,
    ]);
  });

  it("dead-letters immediately on fatal and retries all failed rows without changing others", () => {
    const { db, clock, advance } = fixture();
    const done = enqueueJob(db, "backfill", {}, clock);
    expect(completeJob(db, claim(db, clock), undefined, clock)).toBe(true);
    const failed: string[] = [];
    for (let i = 0; i < 2; i++) {
      advance(1);
      failed.push(enqueueJob(db, "backfill", {}, clock));
      const current = claim(db, clock);
      expect(current.attempts).toBe(1);
      expect(failJob(db, current, "fatal", { ...clock, fatal: true })).toBe("dead-letter");
    }
    const running = enqueueJob(db, "backfill", {}, clock);
    claim(db, clock);
    const queued = enqueueJob(db, "backfill", {}, clock);
    expect(queueCounts(db)).toEqual({ queued: 1, running: 1, done: 1, failed: 2 });
    const unaffected = [done, running, queued].map((id) => row(db, id));
    advance(1);
    expect(retryFailed(db, clock)).toBe(2);
    expect(retryFailed(db, clock)).toBe(0);
    expect([done, running, queued].map((id) => row(db, id))).toEqual(unaffected);
    for (const id of failed) {
      expect(row(db, id)).toMatchObject({
        status: "queued", attempts: 0, last_error: null, run_after: null,
        lease_until: null, updated_at: clock.now().toISOString(),
      });
    }
    expect(claim(db, clock)).toMatchObject({ id: failed[0], attempts: 1 });
  });
});

describe("distill coalescing and single-flight", () => {
  it("coalesces queued jobs across connections but permits the next drain during a run", () => {
    const { db, connect, clock, advance } = fixture();
    const workerB = connect();
    const first = enqueueDistill(db, "site", "conversation", clock);
    expect(enqueueDistill(workerB, "site", "conversation", clock)).toBe(first);
    expect(queueCounts(db).queued).toBe(1);
    const current = claim(db, clock);
    expect(current.payload).toEqual({ site: "site", conversation_id: "conversation" });
    advance(1);
    const next = enqueueDistill(workerB, "site", "conversation", clock);
    expect(next).not.toBe(first);
    expect(enqueueDistill(db, "site", "conversation", clock)).toBe(next);
    expect(claimNext(workerB, clock)).toBeNull();
    const unrelated = enqueueJob(db, "link-cluster", {}, clock);
    expect(claim(workerB, clock).id).toBe(unrelated);
    expect(completeJob(db, current, undefined, clock)).toBe(true);
    expect(claim(workerB, clock).id).toBe(next);
  });

  it("matches both keys exactly, including quotes, unicode, and delimiter collisions", () => {
    const { db, clock } = fixture();
    const pairs = [["a:b", "c"], ["a", "b:c"], ["a:b", "other"], ["other", "c"], ["雪'", "\""], ["", ""]];
    const ids = pairs.map(([site, conversation]) => enqueueDistill(db, site!, conversation!, clock));
    expect(new Set(ids).size).toBe(pairs.length);
    for (const [index, [site, conversation]] of pairs.entries()) {
      expect(enqueueDistill(db, site!, conversation!, clock)).toBe(ids[index]);
      expect(claim(db, clock).id).toBe(ids[index]);
    }
  });

  it("reclaims the older expired distill first and fences its old worker", () => {
    const { db, connect, clock, advance } = fixture();
    const workerB = connect();
    enqueueDistill(db, "site", "c", clock);
    const a = claim(db, clock, 10);
    advance(1);
    enqueueDistill(db, "site", "c", clock);
    advance(10);
    expect(claim(workerB, clock)).toMatchObject({ id: a.id, attempts: 2 });
    expect(claimNext(db, clock)).toBeNull();
    expect(completeJob(db, a, undefined, clock)).toBe(false);
  });

  it("allows an older scheduled queued distill once the other distill lease expires", () => {
    const { db, clock, advance } = fixture();
    const payload = { site: "site", conversation_id: "c" };
    const queued = enqueueJob(db, "distill", payload, {
      ...clock, runAfter: new Date(clock.now().getTime() + 10),
    });
    advance(1);
    const prior = enqueueJob(db, "distill", payload, clock);
    expect(claim(db, clock, 10).id).toBe(prior);
    advance(10);
    expect(claimNext(db, clock)).toBeNull();
    advance(1);
    expect(claim(db, clock).id).toBe(queued);
  });
});

describe("reembed exclusivity", () => {
  it("blocks every other kind even when the queued reembed is scheduled for later", () => {
    const { db, clock, advance } = fixture();
    for (const kind of JOB_KINDS.filter((kind) => kind !== "reembed")) {
      enqueueJob(db, kind, { site: "site", conversation_id: "c" }, clock);
    }
    const id = enqueueJob(db, "reembed", {}, {
      ...clock, runAfter: new Date(clock.now().getTime() + 100),
    });
    expect(claimNext(db, clock)).toBeNull();
    advance(100);
    const reembed = claim(db, clock);
    expect(reembed.id).toBe(id);
    expect(claimNext(db, clock)).toBeNull();
    expect(completeJob(db, reembed, undefined, clock)).toBe(true);
    expect(claim(db, clock).kind).toBe("distill");
  });

  it("waits for all live writers to complete before claiming reembed", () => {
    const { db, connect, clock } = fixture();
    const workerB = connect();
    enqueueJob(db, "backfill", {}, clock);
    const first = claim(db, clock);
    enqueueJob(db, "link-cluster", {}, clock);
    const second = claim(workerB, clock);
    const id = enqueueJob(db, "reembed", {}, clock);
    expect(claimNext(workerB, clock)).toBeNull();
    completeJob(db, first, undefined, clock);
    expect(claimNext(workerB, clock)).toBeNull();
    completeJob(db, second, undefined, clock);
    expect(claim(workerB, clock).id).toBe(id);
  });

  it("admits reembed after a writer lease expires and blocks reclaim of that writer", () => {
    const { db, connect, clock, advance } = fixture();
    const workerB = connect();
    enqueueJob(db, "backfill", {}, clock);
    claim(db, clock, 10);
    const id = enqueueJob(db, "reembed", {}, clock);
    advance(10);
    expect(claimNext(workerB, clock)).toBeNull();
    advance(1);
    expect(claim(workerB, clock).id).toBe(id);
    expect(claimNext(db, clock)).toBeNull();
  });

  it("serializes multiple reembeds and can reclaim an expired reembed", () => {
    const { db, connect, clock, advance } = fixture();
    const workerB = connect();
    const first = enqueueJob(db, "reembed", {}, clock);
    claim(db, clock, 10);
    advance(1);
    const second = enqueueJob(db, "reembed", {}, clock);
    expect(claimNext(workerB, clock)).toBeNull();
    advance(10);
    const reclaimed = claim(workerB, clock);
    expect(reclaimed).toMatchObject({ id: first, attempts: 2 });
    expect(claimNext(db, clock)).toBeNull();
    completeJob(workerB, reclaimed, undefined, clock);
    expect(claim(db, clock).id).toBe(second);
  });

  it("releases the barrier when a reembed is dead-lettered", () => {
    const { db, clock } = fixture();
    enqueueJob(db, "reembed", {}, clock);
    const reembed = claim(db, clock);
    const other = enqueueJob(db, "backfill", {}, clock);
    expect(failJob(db, reembed, "fatal", { ...clock, fatal: true })).toBe("dead-letter");
    expect(claim(db, clock).id).toBe(other);
  });
});
