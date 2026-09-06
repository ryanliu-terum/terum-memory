export const JOB_KINDS = [
  "distill",
  "link-cluster",
  "backfill",
  "backfill-page",
  "reembed",
] as const;

export type JobKind = (typeof JOB_KINDS)[number];

export interface JobClaim {
  id: string;
  kind: JobKind;
  payload: unknown;
  /**
   * Fencing token, first half: use the values returned by claimNext for all
   * worker writes. `attempts` alone is not sufficient — retryFailed resets it,
   * so `epoch` (bumped on every reset) makes the pair monotonic for the life
   * of the job.
   */
  attempts: number;
  /** Fencing token, second half — see `attempts`. */
  epoch: number;
}

export interface ClockOptions {
  now?: () => Date;
}

export interface EnqueueOptions extends ClockOptions {
  runAfter?: Date;
}

export interface LeaseOptions extends ClockOptions {
  leaseMs?: number;
}

export interface FailOptions extends ClockOptions {
  fatal?: boolean;
}

export interface QueueCounts {
  queued: number;
  running: number;
  done: number;
  failed: number;
}
