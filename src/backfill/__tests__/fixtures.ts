import fs from "node:fs";
import path from "node:path";
import type { Db } from "../../db/open.js";
import { claimNext, type JobClaim } from "../../jobs/queue.js";
import type { BackfillSnapshot } from "../scan.js";

export const now = () => new Date("2026-01-03T00:00:00Z");
export const later = () => new Date("2026-01-03T01:00:00Z");
export function pair(sessionId = "s1", uuid = "a1", cwd: string | null = null): string {
  return [
    { type: "user", message: { content: "question" } },
    { type: "assistant", uuid, timestamp: "2026-01-01T00:00:00Z", message: { content: "response", model: "model" } },
  ].map(record => JSON.stringify({ ...record, sessionId, cwd })).join("\n") + "\n";
}
export function session(dir: string, name: string, text = pair()): string {
  const file = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(file, text);
  return file;
}
export function snapshot(selected: string[], omitted: string[] = []): BackfillSnapshot {
  return { selected, omitted, omittedAgeRange: omitted.length ? { oldestMtimeMs: 1000, newestMtimeMs: 2000 } : null,
    scannedAt: now().toISOString() };
}
export function next(db: Db, clock = now, leaseMs = 1000): JobClaim {
  const claim = claimNext(db, { now: clock, leaseMs });
  if (!claim) throw new Error("Expected a queued claim");
  return claim;
}
export function count(db: Db, table: "jobs" | "captures", where = "1 = 1"): number {
  return (db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;
}
