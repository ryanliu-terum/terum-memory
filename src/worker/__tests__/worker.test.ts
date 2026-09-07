import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess, spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb, setMeta, type Db } from "../../db/open.js";
import { enqueueJob, completeJob, claimNext, queueCounts, retryFailed, failJob } from "../../jobs/queue.js";
import { dispatchClaim, UnsupportedJobKind, type Runtime } from "../dispatch.js";
import { drainOnce, drainBounded, buildRuntime, RuntimeUnavailable } from "../loop.js";
import { spawnDetachedWorker, readWorkerLock, releaseWorkerLock, LOCK_STALE_MS } from "../spawn.js";
import { runWorker } from "../../cli/worker-entry.js";
import { pair } from "../../backfill/__tests__/fixtures.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "worker-test-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  const db = openDb({ dbPath: path.join(home, "test.db"), warn: () => undefined });
  cleanups.push(() => db.close());
  return { db, home };
}
const runtime: Runtime = {
  backend: { modelId: "fake", completeJSON: async () => "{}" },
  embedder: { id: "fake", dim: 3, embed: async texts => texts.map(() => new Float32Array([1, 0, 0])) },
};
const done: typeof dispatchClaim = async (db, claim) => ({ status: completeJob(db, claim) ? "done" : "stale" });
function queued(db: Db, kinds = ["distill", "link-cluster", "backfill"]) { return kinds.map(kind => enqueueJob(db, kind, {})); }
function fakeSpawn(fail = false) {
  const child = Object.assign(new EventEmitter(), { pid: 123456, unref: vi.fn() });
  const fn = vi.fn(() => {
    queueMicrotask(() => child.emit(fail ? "error" : "spawn", ...(fail ? [new Error("spawn failed")] : [])));
    return child as unknown as ChildProcess;
  });
  return { fn: fn as unknown as typeof spawn, spy: fn, child };
}

describe("dispatch", () => {
  it("routes distill with both dependencies and derives durable completion", async () => {
    const { db } = fixture(); queued(db, ["distill"]); const claim = claimNext(db)!;
    const handler = vi.fn(async () => { completeJob(db, claim); });
    expect(await dispatchClaim(db, claim, runtime, { distill: handler })).toEqual({ status: "done" });
    expect(handler).toHaveBeenCalledWith(db, claim, runtime);
  });
  it("does not count a distill's internally caught failure as done", async () => {
    const { db } = fixture(); queued(db, ["distill"]); const claim = claimNext(db)!;
    const result = await dispatchClaim(db, claim, runtime, { distill: async () => { failJob(db, claim, "bad"); } });
    expect(result).toEqual({ status: "requeued", error: "bad" });
  });
  it("routes link-cluster with only the backend", async () => {
    const { db } = fixture(); queued(db, ["link-cluster"]); const claim = claimNext(db)!;
    const handler = vi.fn(async () => ({ status: "stale" as const, naming: { names: [], fallbackCount: 0, warnings: [] } }));
    await dispatchClaim(db, claim, runtime, { linkCluster: handler });
    expect(handler).toHaveBeenCalledWith(db, claim, { backend: runtime.backend });
  });
  it.each(["backfill", "backfill-page"])("routes %s without runtime", async kind => {
    const { db } = fixture(); queued(db, [kind]); const claim = claimNext(db)!;
    const handler = vi.fn(() => ({ status: "done" as const }));
    await dispatchClaim(db, claim, undefined, { backfill: handler });
    expect(handler).toHaveBeenCalledWith(db, claim, {});
  });
  it("throws UnsupportedJobKind for a genuinely unknown kind without failing it", async () => {
    // reembed is now a handled kind (its own dispatch case); only an
    // unrecognized kind hits the default throw.
    const { db } = fixture(); queued(db, ["reembed"]); const claim = claimNext(db)!;
    await expect(dispatchClaim(db, { ...claim, kind: "surprise" as typeof claim.kind }, runtime)).rejects.toBeInstanceOf(UnsupportedJobKind);
    expect(queueCounts(db).failed).toBe(0);
  });
});

describe("draining", () => {
  it("drains all queued claims and reports completed jobs", async () => {
    const { db } = fixture(); queued(db);
    expect(await drainOnce(db, runtime, { dispatch: done })).toMatchObject({ processed: 3, runtimeUnavailable: false });
    expect(queueCounts(db).done).toBe(3);
  });
  it("a thrown job error is fenced and requeued while other jobs finish", async () => {
    const { db } = fixture(); const [bad] = queued(db);
    const result = await drainOnce(db, runtime, { dispatch: async (conn, claim) => {
      if (claim.id === bad) throw new Error("handler exploded");
      return done(conn, claim);
    } });
    expect(result.processed).toBe(2);
    expect(result.results.find(row => row.id === bad)).toMatchObject({ status: "requeued", error: "handler exploded" });
    expect(queueCounts(db)).toEqual({ queued: 1, done: 2, running: 0, failed: 0 });
  });
  it("does not count fabricated success", async () => {
    const { db } = fixture(); queued(db, ["backfill"]);
    expect((await drainOnce(db, runtime, { dispatch: async () => ({ status: "done" }) })).processed).toBe(0);
  });
  it("does not let an obsolete worker fail a newer claim", async () => {
    const { db } = fixture(); queued(db, ["backfill"]);
    const result = await drainOnce(db, runtime, { maxJobs: 1, dispatch: async (conn, claim) => {
      failJob(conn, claim, "fatal", { fatal: true }); retryFailed(conn);
      const current = claimNext(conn)!; completeJob(conn, current);
      throw new Error("old worker");
    } });
    expect(result.results[0]?.status).toBe("stale");
    expect(queueCounts(db).done).toBe(1);
  });
  it("bounds dispatch attempts even if none completes, then requests one spawn", async () => {
    const { db } = fixture(); queued(db);
    const spawn = vi.fn(() => true);
    const result = await drainBounded(db, runtime, 2, { dispatch: async () => { throw new Error("bad"); }, spawn });
    expect(result.results).toHaveLength(2); expect(result.processed).toBe(0); expect(spawn).toHaveBeenCalledOnce();
  });
  it("default opportunistic bound is five; empty remainder does not spawn", async () => {
    const { db } = fixture(); queued(db, Array.from({ length: 6 }, () => "backfill"));
    const spawn = vi.fn(() => true);
    expect((await drainBounded(db, runtime, undefined, { dispatch: done, spawn })).processed).toBe(5);
    expect(spawn).toHaveBeenCalledOnce();
    spawn.mockClear(); await drainBounded(db, runtime, 5, { dispatch: done, spawn });
    expect(spawn).not.toHaveBeenCalled();
  });
  it.each([-1, 1.2, NaN])("rejects invalid bound %s", async maxJobs => {
    const { db } = fixture(); await expect(drainOnce(db, runtime, { maxJobs })).rejects.toThrow("maxJobs");
  });
  it("unavailable runtime leaves model jobs queued and drains real backfill imports", async () => {
    const { db, home } = fixture(); const ids = queued(db, ["distill", "link-cluster"]);
    const file = path.join(home, "transcript.jsonl"); fs.writeFileSync(file, pair());
    enqueueJob(db, "backfill", { snapshot: { selected: [file], omitted: [], omittedAgeRange: null,
      scannedAt: new Date().toISOString() }, pageSize: 50, pageCursor: 0 });
    const result = await drainOnce(db, () => { throw new Error("unpinned model"); });
    expect(result).toMatchObject({ processed: 1, runtimeUnavailable: true, reason: "unpinned model", skipped: 2 });
    for (const id of ids) expect(db.prepare("SELECT status, attempts FROM jobs WHERE id = ?").get(id)).toEqual({ status: "queued", attempts: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM captures").get()).toEqual({ n: 1 });
  });
  it("without a runtime, reembed stays queued (runtime-gated) and its exclusivity barrier blocks other work", async () => {
    // reembed needs the new embedder, so with no runtime it is left queued like
    // distill/link-cluster — and M2's reembed exclusivity means the queued
    // reembed also blocks the backfill job from being claimed. Nothing is
    // processed, nothing fails, both jobs remain queued.
    const { db } = fixture(); queued(db, ["reembed", "backfill"]);
    const result = await drainOnce(db, undefined, { dispatch: done });
    expect(result).toMatchObject({ processed: 0 });
    expect(result.unsupported).toEqual([]); // skipped for runtime, not as unsupported
    expect(queueCounts(db)).toEqual({ queued: 2, running: 0, done: 0, failed: 0 });
  });
});

describe("runtime", () => {
  it("wraps missing initialization as a typed error", async () => {
    const { db } = fixture(); await expect(buildRuntime(db)).rejects.toBeInstanceOf(RuntimeUnavailable);
  });
  it("reports capture-only config and unpinned manifests without inference", async () => {
    const { db } = fixture(); db.transaction(() => setMeta(db, "embedder_id", "nomic-embed-text-v1"))();
    await expect(buildRuntime(db, { loadConfig: () => ({}) })).rejects.toThrow("capture-only");
    const other = fixture(); other.db.transaction(() => setMeta(other.db, "embedder_id", "nomic-embed-text-v1"))();
    await expect(buildRuntime(other.db, { loadConfig: () => ({ chat: { backend: "claude" } }) })).rejects.toThrow("unmeasured placeholder");
  });
  it("builds only once and passes the locked manifest", async () => {
    const { db } = fixture(); db.transaction(() => setMeta(db, "embedder_id", "fake"))();
    const manifest = { id: "fake", dim: 3, hfRepo: "fake", revision: "pin", sha256: "x", onnxFile: "model.onnx",
      pooling: "mean" as const, l2Normalize: true, maxTokens: 10, truncation: "tail" as const, prefixes: null };
    const createEmbedder = vi.fn(async () => runtime.embedder);
    const opts = { loadConfig: () => ({ chat: { backend: "claude" as const } }), manifestFor: vi.fn(() => manifest),
      createEmbedder, backendFromConfig: vi.fn(() => runtime.backend) };
    expect(await buildRuntime(db, opts)).toEqual(runtime); await buildRuntime(db, opts);
    expect(createEmbedder).toHaveBeenCalledExactlyOnceWith(manifest);
  });
});

describe("detached lock", () => {
  it("concurrent requests spawn once, use a detached child, and enforce modes", async () => {
    const { home } = fixture(); const fake = fakeSpawn();
    expect(await Promise.all([spawnDetachedWorker({ home, spawn: fake.fn }), spawnDetachedWorker({ home, spawn: fake.fn })])).toEqual([true, false]);
    expect(fake.spy).toHaveBeenCalledOnce(); expect(fake.child.unref).toHaveBeenCalledOnce();
    expect(fake.spy.mock.calls[0]).toBeDefined();
    const call = (fake.spy.mock.calls as unknown as Array<[string, string[], Record<string, unknown>]>)[0]!;
    expect(call[0]).toBe(process.execPath); expect(call[1][0]).toMatch(/cli\/worker-entry.js$/);
    expect(call[2]).toMatchObject({ detached: true, stdio: "ignore" });
    expect(fs.statSync(path.join(home, "worker.lock")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(home).mode & 0o777).toBe(0o700);
  });
  it("reclaims a stale dead owner but never an old live worker", async () => {
    const { home } = fixture(); const file = path.join(home, "worker.lock");
    fs.writeFileSync(file, JSON.stringify({ pid: 42, token: "old" }), { mode: 0o600 });
    const past = new Date(Date.now() - LOCK_STALE_MS - 1000); fs.utimesSync(file, past, past);
    const fake = fakeSpawn();
    expect(await spawnDetachedWorker({ home, spawn: fake.fn, isAlive: () => true })).toBe(false);
    expect(await spawnDetachedWorker({ home, spawn: fake.fn, isAlive: () => false })).toBe(true);
    expect(readWorkerLock(file)?.token).not.toBe("old");
    releaseWorkerLock(file, "old"); expect(fs.existsSync(file)).toBe(true);
  });
  it("cleans up a failed spawn and reports the error", async () => {
    const { home } = fixture(); const fake = fakeSpawn(true);
    await expect(spawnDetachedWorker({ home, spawn: fake.fn })).rejects.toThrow("spawn failed");
    expect(fs.existsSync(path.join(home, "worker.lock"))).toBe(false);
  });
  it("reclaims malformed stale locks", async () => {
    const { home } = fixture(); const file = path.join(home, "worker.lock"); fs.writeFileSync(file, "broken", { mode: 0o600 });
    fs.utimesSync(file, new Date(0), new Date(0));
    expect(await spawnDetachedWorker({ home, spawn: fakeSpawn().fn })).toBe(true);
  });
});

it("entrypoint waits for delayed work through a seam, then releases its lock", async () => {
  const { db, home } = fixture(); let now = new Date("2026-01-01T00:00:00Z");
  enqueueJob(db, "backfill", {}, { now: () => now, runAfter: new Date(now.getTime() + 30_000) });
  const file = path.join(home, "worker.lock"); fs.writeFileSync(file, JSON.stringify({ pid: 42, token: "test" }), { mode: 0o600 });
  const wait = vi.fn(async (ms: number) => { now = new Date(now.getTime() + ms); });
  expect(await runWorker({ db, home, token: "test", runtime, wait, drainOptions: { dispatch: done, now: () => now } })).toBe(0);
  expect(wait).toHaveBeenCalledOnce(); expect(queueCounts(db).done).toBe(1); expect(fs.existsSync(file)).toBe(false);
});

it("skipping unavailable work preserves its prior retry budget and invalidates old claims", async () => {
  const { db } = fixture(); const now = () => new Date("2026-01-01T00:00:00Z");
  enqueueJob(db, "distill", {}, { now });
  const prior = claimNext(db, { now })!; failJob(db, prior, "failed once", { now });
  await drainOnce(db, () => { throw new Error("no runtime"); }, { now: () => new Date("2026-01-01T01:00:00Z") });
  expect(db.prepare("SELECT status, attempts, epoch FROM jobs").get()).toEqual({ status: "queued", attempts: 1, epoch: 1 });
  expect(completeJob(db, prior)).toBe(false);
});

it("dispatch surfaces partial imports even when the page completes", async () => {
  const { db } = fixture(); queued(db, ["backfill-page"]); const claim = claimNext(db)!;
  const outcome = await dispatchClaim(db, claim, undefined, { backfill: () => ({ status: "done", result: {
    inserted: 1, conversationsTouched: ["session"], failures: [{ path: "bad.jsonl", error: "invalid record" }],
  } }) });
  expect(outcome.warnings).toEqual(["bad.jsonl: invalid record"]);
});
