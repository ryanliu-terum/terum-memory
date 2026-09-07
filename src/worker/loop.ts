import path from "node:path";
import type { Db } from "../db/open.js";
import { claimNext, failJob, queueCounts, type JobClaim } from "../jobs/queue.js";
import { dispatchClaim, UnsupportedJobKind, type JobOutcome, type Runtime } from "./dispatch.js";
import { buildRuntime } from "./runtime.js";
import { spawnDetachedWorker } from "./spawn.js";
export { buildRuntime, RuntimeUnavailable } from "./runtime.js";
export { spawnDetachedWorker } from "./spawn.js";
export type { Runtime } from "./dispatch.js";

export type RuntimeSource = Runtime | (() => Runtime | Promise<Runtime>);
export interface DrainOptions {
  maxJobs?: number;
  dispatch?: typeof dispatchClaim;
  now?: () => Date;
  spawn?: () => Promise<boolean> | boolean;
}
export interface DrainResult {
  processed: number;
  results: Array<{ id: string; kind: string } & JobOutcome>;
  skipped: number;
  unsupported: string[];
  runtimeUnavailable: boolean;
  reason?: string;
}

/** Give back an unexecuted claim without spending or resetting its retry budget.
 * Bump epoch when undoing the claim attempt so its old token cannot be reused.
 */
function returnSkipped(db: Db, claim: JobClaim, opts: DrainOptions): boolean {
  return db.transaction(() => db.prepare(`UPDATE jobs SET status = 'queued',
    attempts = attempts - 1, epoch = epoch + 1, lease_until = NULL, updated_at = ?
    WHERE id = ? AND attempts = ? AND epoch = ? AND status = 'running'`)
    .run((opts.now ?? (() => new Date()))().toISOString(), claim.id, claim.attempts, claim.epoch).changes === 1).immediate();
}

/** Hold skipped claims only inside this transaction, then return them queued.
 * This preserves claimNext's reembed barrier and fencing without changing M2.
 */
function nextAvailable(db: Db, runtime: boolean, skipped: Map<string, string>, opts: DrainOptions): JobClaim | null {
  return db.transaction(() => {
    const held: JobClaim[] = [];
    let selected: JobClaim | null = null;
    try {
      for (;;) {
        const claim = claimNext(db, { now: opts.now });
        if (!claim) break;
        const supported = ["distill", "link-cluster", "backfill", "backfill-page"].includes(claim.kind);
        if (!supported || (!runtime && ["distill", "link-cluster"].includes(claim.kind))) {
          held.push(claim);
          skipped.set(claim.id, supported ? "runtime" : claim.kind);
        } else { selected = claim; break; }
      }
    } finally {
      for (const claim of held) {
        if (!returnSkipped(db, claim, opts)) throw new Error("Lost fence while returning skipped claim");
      }
    }
    return selected;
  }).immediate();
}

export async function drainOnce(db: Db, source: RuntimeSource = () => buildRuntime(db), opts: DrainOptions = {}): Promise<DrainResult> {
  const max = opts.maxJobs ?? Infinity;
  if (max !== Infinity && (!Number.isSafeInteger(max) || max < 0)) throw new Error("maxJobs must be a nonnegative safe integer");
  const result: DrainResult = { processed: 0, results: [], skipped: 0, unsupported: [], runtimeUnavailable: false };
  let runtime: Runtime | undefined;
  try { runtime = typeof source === "function" ? await source() : source; }
  catch (error) {
    result.runtimeUnavailable = true;
    result.reason = error instanceof Error ? error.message : String(error);
  }
  const skipped = new Map<string, string>();
  for (let attempted = 0; attempted < max; attempted++) {
    const claim = nextAvailable(db, runtime !== undefined, skipped, opts);
    if (!claim) break;
    let outcome: JobOutcome;
    try { outcome = await (opts.dispatch ?? dispatchClaim)(db, claim, runtime); }
    catch (error) {
      if (error instanceof UnsupportedJobKind) {
        skipped.set(claim.id, claim.kind);
        returnSkipped(db, claim, opts);
        break;
      }
      outcome = { status: failJob(db, claim, error, { now: opts.now }), error: error instanceof Error ? error.message : String(error) };
    }
    result.results.push({ id: claim.id, kind: claim.kind, ...outcome });
    // Count durable completions, even if a handler mistakenly reports success.
    const row = db.prepare("SELECT status, attempts, epoch FROM jobs WHERE id = ?").get(claim.id) as
      { status: string; attempts: number; epoch: number } | undefined;
    if (outcome.status === "done" && row?.status === "done" && row.attempts === claim.attempts && row.epoch === claim.epoch) result.processed++;
  }
  result.skipped = skipped.size;
  result.unsupported = [...new Set([...skipped.values()].filter(kind => kind !== "runtime"))];
  return result;
}
export async function drainBounded(db: Db, runtime: RuntimeSource = () => buildRuntime(db), maxJobs = 5, opts: DrainOptions = {}): Promise<DrainResult> {
  const result = await drainOnce(db, runtime, { ...opts, maxJobs });
  if (queueCounts(db).queued > 0) await (opts.spawn ?? (() => spawnDetachedWorker({ home: path.dirname(db.name), dbPath: db.name })))();
  return result;
}
