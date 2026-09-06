import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../../db/open.js";
import { claimNext, completeJob, enqueueJob, failJob, renewLease, retryFailed } from "../queue.js";

let cleanup: Array<() => void> = [];

function freshDbPath(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "terum-epoch-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "terum.db");
}

function open(dbPath: string): Db {
  const db = openDb({ dbPath, warn: () => {} });
  cleanup.push(() => db.close());
  return db;
}

afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

const at = (ms: number) => ({ now: () => new Date(ms) });

describe("fencing token cannot recur across retryFailed (epoch)", () => {
  it("a claim minted before a dead-letter requeue never matches one minted after", () => {
    const dbPath = freshDbPath();
    const workerA = open(dbPath);
    const workerB = open(dbPath);

    enqueueJob(workerA, "link-cluster", {}, at(0));

    // Worker A claims (epoch 0, attempts 1), then stalls.
    const staleClaim = claimNext(workerA, at(1_000));
    expect(staleClaim).not.toBeNull();
    expect(staleClaim!.attempts).toBe(1);
    expect(staleClaim!.epoch).toBe(0);

    // Lease expires; worker B reclaims (attempts 2) and dead-letters it.
    const reclaim = claimNext(workerB, at(1_000 + 6 * 60_000));
    expect(reclaim).not.toBeNull();
    expect(failJob(workerB, reclaim!, new Error("boom"), { fatal: true, ...at(1_000 + 6 * 60_000) })).toBe(
      "dead-letter",
    );

    // Manual requeue resets attempts to 0 — and bumps epoch to 1.
    expect(retryFailed(workerB, at(1_000 + 7 * 60_000))).toBe(1);

    // Worker B claims again: attempts is 1 once more, the exact value of A's
    // stale token. Without the epoch, every fenced write below would match.
    const freshClaim = claimNext(workerB, at(1_000 + 8 * 60_000));
    expect(freshClaim).not.toBeNull();
    expect(freshClaim!.attempts).toBe(1);
    expect(freshClaim!.epoch).toBe(1);

    // Stale worker A wakes up and tries everything. All of it must bounce.
    expect(renewLease(workerA, staleClaim!, at(1_000 + 9 * 60_000))).toBe(false);
    expect(failJob(workerA, staleClaim!, new Error("stale"), at(1_000 + 9 * 60_000))).toBe("stale");
    let businessWriteRan = false;
    expect(
      completeJob(
        workerA,
        staleClaim!,
        (db) => {
          businessWriteRan = true;
          db.prepare("INSERT INTO meta (key, value) VALUES ('stale-probe', 'x')").run();
        },
        at(1_000 + 9 * 60_000),
      ),
    ).toBe(false);
    expect(businessWriteRan).toBe(true); // the callback ran — and was rolled back
    expect(workerB.prepare("SELECT value FROM meta WHERE key = 'stale-probe'").get()).toBeUndefined();

    // B's fresh claim is untouched and still completes normally.
    expect(completeJob(workerB, freshClaim!, undefined, at(1_000 + 10 * 60_000))).toBe(true);
  });
});
