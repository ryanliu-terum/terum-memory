import { z } from "zod";
import type { Db } from "../db/open.js";
import { completeJob, enqueueCoalesced, enqueueDistill, failJob, rescheduleJob, type JobClaim } from "../jobs/queue.js";
import { importSession } from "./import.js";
import type { BackfillSnapshot } from "./scan.js";

// The run job polls by rescheduling itself while its pages finish — this is not
// a failure, so it uses rescheduleJob (attempts-neutral) rather than failJob,
// which would dead-letter at attempt 5. Termination is guaranteed by the pages'
// own retry ceilings; POLL_CAP is a defensive absolute bound against a
// pathological stuck page, beyond which the run reports partial.
const RUN_POLL_DELAY_MS = 30_000;
const RUN_POLL_CAP = 2_000;

export interface BackfillRunPayload {
  snapshot: BackfillSnapshot;
  pageSize: number;
  pageCursor: number;
  polls?: number;
  result?: BackfillRunResult;
}
export interface BackfillPagePayload {
  runJobId: string;
  sliceStart: number;
  sliceEnd: number;
  result?: BackfillPageResult;
}
export interface SessionFailure { path: string; error: string; parseErrors?: number }
export interface BackfillPageResult {
  inserted: number;
  conversationsTouched: string[];
  failures: SessionFailure[];
}
export interface BackfillRunResult extends BackfillPageResult {
  status: "complete" | "partial";
  failedPages: Array<{ jobId: string; error: string }>;
}
export interface BackfillDeps { now?: () => Date }
export interface BackfillJobResult {
  status: "done" | "stale" | "requeued" | "dead-letter" | "rescheduled";
  result?: BackfillPageResult | BackfillRunResult;
}

const index = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const snapshotSchema = z.object({
  selected: z.array(z.string().min(1)), omitted: z.array(z.string().min(1)),
  omittedAgeRange: z.object({ newestMtimeMs: z.number().finite(), oldestMtimeMs: z.number().finite() }).nullable(),
  scannedAt: z.string().datetime(),
});
const runSchema = z.object({ snapshot: snapshotSchema, pageSize: index.min(1), pageCursor: index, polls: index.optional() });
const pageSchema = z.object({ runJobId: z.string().min(1), sliceStart: index, sliceEnd: index });
const pageResultSchema = z.object({
  inserted: index, conversationsTouched: z.array(z.string()),
  failures: z.array(z.object({ path: z.string(), error: z.string(), parseErrors: index.optional() })),
});

class LostFence extends Error {}
interface JobRow { id: string; kind: string; payload: string; status: string; last_error: string | null }

function ownedJob(db: Db, claim: JobClaim): JobRow {
  const row = db.prepare(`SELECT id, kind, payload, status, last_error FROM jobs
    WHERE id = ? AND attempts = ? AND epoch = ? AND status = 'running'`)
    .get(claim.id, claim.attempts, claim.epoch) as JobRow | undefined;
  if (!row) throw new LostFence();
  if (row.kind !== claim.kind) throw new Error("Claim kind does not match stored job");
  return row;
}

function savePayload(db: Db, claim: JobClaim, payload: unknown, deps: BackfillDeps): void {
  const updated = db.prepare(`UPDATE jobs SET payload = ?, updated_at = ?
    WHERE id = ? AND attempts = ? AND epoch = ? AND status = 'running'`)
    .run(JSON.stringify(payload), (deps.now ?? (() => new Date()))().toISOString(),
      claim.id, claim.attempts, claim.epoch);
  if (updated.changes !== 1) throw new LostFence();
}

function readRun(payload: string): BackfillRunPayload {
  const run = runSchema.parse(JSON.parse(payload));
  if (run.pageCursor > run.snapshot.selected.length ||
      (run.pageCursor !== run.snapshot.selected.length && run.pageCursor % run.pageSize !== 0)) {
    throw new Error("Invalid backfill pageCursor");
  }
  return run;
}

function pages(db: Db, runJobId: string, sliceStart: number): JobRow[] {
  return db.prepare(`SELECT id, kind, payload, status, last_error FROM jobs
    WHERE kind = 'backfill-page' AND json_extract(payload, '$.runJobId') = ?
      AND json_extract(payload, '$.sliceStart') = ? ORDER BY rowid`)
    .all(runJobId, sliceStart) as JobRow[];
}

function failure(db: Db, claim: JobClaim, error: unknown, deps: BackfillDeps): BackfillJobResult {
  return { status: error instanceof LostFence ? "stale" : failJob(db, claim, error, deps) };
}

/** Persist each dispatch with its cursor, then poll under the same M2 fence. */
export function runBackfillRunJob(db: Db, claim: JobClaim, deps: BackfillDeps = {}): BackfillJobResult {
  try {
    if (claim.kind !== "backfill") throw new Error("Expected a backfill claim");
    const run = readRun(ownedJob(db, claim).payload);
    // Inspect all slices, including those before the cursor: queued-only coalescing
    // cannot by itself protect a replay against already running or terminal pages.
    for (let start = 0; start < run.snapshot.selected.length; start += run.pageSize) {
      const end = Math.min(start + run.pageSize, run.snapshot.selected.length);
      db.transaction(() => {
        ownedJob(db, claim);
        const existing = pages(db, claim.id, start);
        for (const page of existing) {
          if (pageSchema.parse(JSON.parse(page.payload)).sliceEnd !== end) throw new Error("Conflicting backfill slice");
        }
        if (existing.length === 0) enqueueCoalesced(db, "backfill-page", {
          runJobId: claim.id, sliceStart: start, sliceEnd: end,
        }, deps);
        run.pageCursor = Math.max(run.pageCursor, end);
        savePayload(db, claim, run, deps);
      }).immediate();
    }
    return db.transaction((): BackfillJobResult => {
      ownedJob(db, claim);
      const allPages: JobRow[] = [];
      for (let start = 0; start < run.snapshot.selected.length; start += run.pageSize) {
        const slice = pages(db, claim.id, start);
        if (slice.length === 0) throw new Error("Missing backfill page");
        allPages.push(...slice);
      }
      if (allPages.some(page => page.status !== "done" && page.status !== "failed")) {
        // Pages are still running — poll again later. Rescheduling is attempts-
        // neutral (NOT failJob, which dead-letters at attempt 5): a run with more
        // than five poll cycles must not kill itself. Pages have their own retry
        // ceilings, so this loop terminates; POLL_CAP is a defensive absolute
        // bound beyond which we stop waiting and report what imported so far.
        const polls = (run.polls ?? 0) + 1;
        if (polls <= RUN_POLL_CAP) {
          savePayload(db, claim, { ...run, polls }, deps);
          const rescheduled = rescheduleJob(db, claim, RUN_POLL_DELAY_MS, deps);
          return { status: rescheduled ? "rescheduled" : "stale" };
        }
        // Cap hit: fall through and complete with whatever imported, marking the
        // still-unterminated pages as failures so the report is honestly partial.
      }
      const result: BackfillRunResult = {
        status: "complete", inserted: 0, conversationsTouched: [], failures: [], failedPages: [],
      };
      const conversations = new Set<string>();
      for (const page of allPages) {
        // A non-'done' page here is either dead-lettered or (only on the POLL_CAP
        // fall-through) still unterminated; both are honest failures for the report.
        if (page.status !== "done") {
          result.failedPages.push({
            jobId: page.id,
            error: page.status === "failed"
              ? (page.last_error ?? "Page dead-lettered without an error")
              : `Page did not terminate within the backfill poll budget (status ${page.status})`,
          });
          continue;
        }
        const payload = JSON.parse(page.payload) as { result?: unknown };
        const imported = pageResultSchema.parse(payload.result);
        result.inserted += imported.inserted;
        result.failures.push(...imported.failures);
        for (const conversation of imported.conversationsTouched) conversations.add(conversation);
      }
      result.conversationsTouched = [...conversations].sort();
      if (result.failedPages.length > 0 || result.failures.length > 0) result.status = "partial";
      const completed = completeJob(db, claim, tx => {
        for (const conversation of result.conversationsTouched) enqueueDistill(tx, "claude-code", conversation, deps);
        savePayload(tx, claim, { ...run, result }, deps);
      }, deps);
      return completed ? { status: "done", result } : { status: "stale" };
    }).immediate();
  } catch (error) {
    return failure(db, claim, error, deps);
  }
}

/** Page captures and durable results commit together with fenced completion. */
export function runBackfillPageJob(db: Db, claim: JobClaim, deps: BackfillDeps = {}): BackfillJobResult {
  try {
    if (claim.kind !== "backfill-page") throw new Error("Expected a backfill-page claim");
    const result: BackfillPageResult = { inserted: 0, conversationsTouched: [], failures: [] };
    const completed = completeJob(db, claim, tx => {
      const page = pageSchema.parse(JSON.parse(ownedJob(tx, claim).payload));
      const parent = tx.prepare("SELECT payload FROM jobs WHERE id = ? AND kind = 'backfill'")
        .get(page.runJobId) as { payload: string } | undefined;
      if (!parent) throw new Error("Backfill parent does not exist");
      const run = readRun(parent.payload);
      if (page.sliceStart >= run.snapshot.selected.length || page.sliceStart % run.pageSize !== 0 ||
          page.sliceEnd !== Math.min(page.sliceStart + run.pageSize, run.snapshot.selected.length)) {
        throw new Error("Invalid backfill page slice");
      }
      const conversations = new Set<string>();
      for (const file of run.snapshot.selected.slice(page.sliceStart, page.sliceEnd)) {
        try {
          const imported = importSession(tx, file, deps);
          result.inserted += imported.inserted;
          for (const conversation of imported.conversationsTouched) conversations.add(conversation);
          if (imported.parseErrors > 0) result.failures.push({
            path: file, error: `${imported.parseErrors} malformed transcript records`, parseErrors: imported.parseErrors,
          });
        } catch (error) {
          result.failures.push({ path: file, error: error instanceof Error ? error.message : String(error) });
        }
      }
      result.conversationsTouched = [...conversations].sort();
      savePayload(tx, claim, { ...page, result }, deps);
    }, deps);
    return completed ? { status: "done", result } : { status: "stale" };
  } catch (error) {
    return failure(db, claim, error, deps);
  }
}

/** M12 supplies execution for distill/link-cluster and the worker drain. */
export function dispatchJob(db: Db, claim: JobClaim, deps: BackfillDeps = {}): BackfillJobResult {
  switch (claim.kind) {
    case "backfill": return runBackfillRunJob(db, claim, deps);
    case "backfill-page": return runBackfillPageJob(db, claim, deps);
    default: throw new Error(`Unsupported backfill dispatch kind: ${claim.kind}`);
  }
}
