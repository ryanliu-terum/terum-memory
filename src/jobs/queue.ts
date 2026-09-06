import { randomUUID } from "node:crypto";
import type { Db } from "../db/open.js";
import {
  JOB_KINDS,
  type ClockOptions,
  type EnqueueOptions,
  type FailOptions,
  type JobClaim,
  type JobKind,
  type LeaseOptions,
  type QueueCounts,
} from "./types.js";

export type { JobClaim, JobKind } from "./types.js";

const DEFAULT_LEASE_MS = 5 * 60_000;

function timestamp(opts: ClockOptions): Date {
  return (opts.now ?? (() => new Date()))();
}

function leaseUntil(now: Date, opts: LeaseOptions): string {
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
    throw new Error("leaseMs must be finite and positive");
  }
  return new Date(now.getTime() + leaseMs).toISOString();
}

export function enqueueJob(
  db: Db,
  kind: string,
  payload: unknown,
  opts: EnqueueOptions = {},
): string {
  if (!JOB_KINDS.includes(kind as JobKind)) {
    throw new Error(`Unknown job kind: ${kind}`);
  }
  const serialized = JSON.stringify(payload);
  if (serialized === undefined) throw new Error("Job payload must be JSON serializable");
  return db.transaction(() => {
    const id = randomUUID();
    const now = timestamp(opts).toISOString();
    db.prepare(`
      INSERT INTO jobs (id, kind, payload, run_after, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, kind, serialized, opts.runAfter?.toISOString() ?? null, now, now);
    return id;
  }).immediate();
}

/** Coalesce only queued jobs with exactly the same serialized payload. */
export function enqueueCoalesced(
  db: Db,
  kind: string,
  payload: unknown,
  opts: EnqueueOptions = {},
): string {
  if (!JOB_KINDS.includes(kind as JobKind)) {
    throw new Error(`Unknown job kind: ${kind}`);
  }
  const serialized = JSON.stringify(payload);
  if (serialized === undefined) throw new Error("Job payload must be JSON serializable");
  return db.transaction(() => {
    const existing = db.prepare(`
      SELECT id FROM jobs WHERE kind = ? AND status = 'queued' AND payload = ?
      ORDER BY created_at, rowid LIMIT 1
    `).get(kind, serialized) as { id: string } | undefined;
    if (existing) return existing.id;
    const id = randomUUID();
    const now = timestamp(opts).toISOString();
    db.prepare(`
      INSERT INTO jobs (id, kind, payload, run_after, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, kind, serialized, opts.runAfter?.toISOString() ?? null, now, now);
    return id;
  }).immediate();
}

export function enqueueDistill(
  db: Db,
  site: string,
  conversationId: string,
  opts: ClockOptions = {},
): string {
  // The write lock must cover both the lookup and insert across connections.
  return db.transaction(() => {
    const existing = db.prepare(`
      SELECT id FROM jobs
      WHERE kind = 'distill' AND status = 'queued'
        AND json_extract(payload, '$.site') = ?
        AND json_extract(payload, '$.conversation_id') = ?
      ORDER BY created_at, rowid LIMIT 1
    `).get(site, conversationId) as { id: string } | undefined;
    return existing?.id ?? enqueueJob(
      db, "distill", { site, conversation_id: conversationId }, opts,
    );
  }).immediate();
}

export function claimNext(db: Db, opts: LeaseOptions = {}): JobClaim | null {
  return db.transaction(() => {
    const date = timestamp(opts);
    const now = date.toISOString();
    // Selection is part of the UPDATE: no predicate can race another writer.
    // Equality is still live because reclaim uses a strict less-than bound.
    const row = db.prepare(`
      UPDATE jobs
      SET status = 'running', lease_until = @leaseUntil,
          attempts = attempts + 1, updated_at = @now
      WHERE id = (
        SELECT candidate.id FROM jobs AS candidate
        WHERE (candidate.status = 'queued'
          OR (candidate.status = 'running' AND candidate.lease_until < @now))
          AND (candidate.run_after IS NULL OR candidate.run_after <= @now)
          AND (candidate.kind = 'reembed' OR NOT EXISTS (
            SELECT 1 FROM jobs AS barrier
            WHERE barrier.kind = 'reembed' AND barrier.status IN ('queued', 'running')
          ))
          AND (candidate.kind != 'reembed' OR NOT EXISTS (
            SELECT 1 FROM jobs AS writer
            WHERE writer.status = 'running' AND writer.lease_until >= @now
          ))
          AND (candidate.kind != 'distill' OR NOT EXISTS (
            SELECT 1 FROM jobs AS prior
            WHERE prior.id != candidate.id AND prior.kind = 'distill'
              AND prior.status = 'running' AND prior.lease_until >= @now
              AND json_extract(prior.payload, '$.site') = json_extract(candidate.payload, '$.site')
              AND json_extract(prior.payload, '$.conversation_id') = json_extract(candidate.payload, '$.conversation_id')
          ))
        ORDER BY candidate.created_at, candidate.rowid LIMIT 1
      )
      RETURNING id, kind, payload, attempts, epoch
    `).get({ now, leaseUntil: leaseUntil(date, opts) }) as
      | { id: string; kind: JobKind; payload: string; attempts: number; epoch: number }
      | undefined;
    // Parse before committing, so malformed stored JSON cannot strand a claim.
    return row ? { ...row, payload: JSON.parse(row.payload) as unknown } : null;
  }).immediate();
}

export function renewLease(db: Db, claim: JobClaim, opts: LeaseOptions = {}): boolean {
  return db.transaction(() => {
    const now = timestamp(opts);
    return db.prepare(`
      UPDATE jobs SET lease_until = ?, updated_at = ?
      WHERE id = ? AND attempts = ? AND epoch = ? AND status = 'running'
    `).run(leaseUntil(now, opts), now.toISOString(), claim.id, claim.attempts, claim.epoch)
      .changes === 1;
  }).immediate();
}

class LostFence extends Error {}

/** businessWrites must be synchronous and use the supplied transaction connection. */
export function completeJob(
  db: Db,
  claim: JobClaim,
  businessWrites?: (db: Db) => void,
  opts: ClockOptions = {},
): boolean {
  const lostFence = new LostFence();
  try {
    return db.transaction(() => {
      businessWrites?.(db);
      const result = db.prepare(`
        UPDATE jobs SET status = 'done', lease_until = NULL, updated_at = ?
        WHERE id = ? AND attempts = ? AND epoch = ? AND status = 'running'
      `).run(timestamp(opts).toISOString(), claim.id, claim.attempts, claim.epoch);
      if (result.changes === 0) throw lostFence;
      return true;
    }).immediate();
  } catch (error) {
    if (error === lostFence) return false;
    throw error;
  }
}

export function backoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** (attempts - 1), 1_800_000);
}

export function failJob(
  db: Db,
  claim: JobClaim,
  error: unknown,
  opts: FailOptions = {},
): "requeued" | "dead-letter" | "stale" {
  return db.transaction(() => {
    const now = timestamp(opts);
    const deadLetter = opts.fatal === true || claim.attempts >= 5;
    const runAfter = deadLetter ? null : new Date(now.getTime() + backoffMs(claim.attempts)).toISOString();
    const result = db.prepare(`
      UPDATE jobs SET status = ?, last_error = ?, run_after = ?, lease_until = NULL, updated_at = ?
      WHERE id = ? AND attempts = ? AND epoch = ? AND status = 'running'
    `).run(
      deadLetter ? "failed" : "queued", error instanceof Error ? error.message : String(error),
      runAfter, now.toISOString(), claim.id, claim.attempts, claim.epoch,
    );
    if (result.changes === 0) return "stale";
    return deadLetter ? "dead-letter" : "requeued";
  }).immediate();
}

/**
 * Reschedule a claimed job to run again after a delay WITHOUT consuming its
 * retry budget — a deliberate "not done yet, check back later," not a failure.
 * Resets attempts to 0 and bumps epoch (same fencing discipline as retryFailed:
 * the (epoch, attempts) token minted before this reschedule can never match one
 * minted after), so a self-polling job (e.g. a backfill run waiting on its
 * pages) can poll indefinitely without dead-lettering at attempt 5. Fenced:
 * returns false if the lease was reclaimed, writing nothing.
 */
export function rescheduleJob(
  db: Db,
  claim: JobClaim,
  delayMs: number,
  opts: ClockOptions = {},
): boolean {
  return db.transaction(() => {
    const now = timestamp(opts);
    const runAfter = new Date(now.getTime() + Math.max(0, delayMs)).toISOString();
    const result = db.prepare(`
      UPDATE jobs SET status = 'queued', attempts = 0, epoch = epoch + 1,
        run_after = ?, lease_until = NULL, updated_at = ?
      WHERE id = ? AND attempts = ? AND epoch = ? AND status = 'running'
    `).run(runAfter, now.toISOString(), claim.id, claim.attempts, claim.epoch);
    return result.changes === 1;
  }).immediate();
}

export function retryFailed(db: Db, opts: ClockOptions = {}): number {
  // epoch is bumped in the same UPDATE that resets attempts: the fencing token
  // is (epoch, attempts), so a claim minted before this requeue can never
  // match a claim minted after it, even at the same attempts value.
  return db.transaction(() => db.prepare(`
    UPDATE jobs SET status = 'queued', attempts = 0, epoch = epoch + 1, last_error = NULL,
      run_after = NULL, lease_until = NULL, updated_at = ?
    WHERE status = 'failed'
  `).run(timestamp(opts).toISOString()).changes).immediate();
}

export function queueCounts(db: Db): QueueCounts {
  const counts: QueueCounts = { queued: 0, running: 0, done: 0, failed: 0 };
  const rows = db.prepare("SELECT status, count(*) AS count FROM jobs GROUP BY status").all() as
    Array<{ status: keyof QueueCounts; count: number }>;
  for (const row of rows) counts[row.status] = row.count;
  return counts;
}
