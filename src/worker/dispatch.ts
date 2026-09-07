import type { Db } from "../db/open.js";
import type { JobClaim } from "../jobs/types.js";
import type { Embedder } from "../engine/embedder-types.js";
import type { ChatBackend } from "../llm/backend.js";

export interface Runtime { backend: ChatBackend; embedder: Embedder }
export interface JobOutcome {
  status: "done" | "stale" | "requeued" | "dead-letter" | "rescheduled";
  error?: string;
  warnings?: string[];
}
export class UnsupportedJobKind extends Error {
  constructor(kind: string) { super(`Unsupported job kind: ${kind} (reembed is reserved for M12b)`); }
}
export interface DispatchHandlers {
  distill?: (db: Db, claim: JobClaim, deps: Runtime) => Promise<void>;
  linkCluster?: typeof import("../engine/link-cluster-job.js").runLinkClusterJob;
  backfill?: typeof import("../backfill/jobs.js").dispatchJob;
}

/** Distill returns void; read the fenced terminal state instead of assuming success. */
export function claimOutcome(db: Db, claim: JobClaim): JobOutcome {
  const row = db.prepare("SELECT status, attempts, epoch, last_error FROM jobs WHERE id = ?")
    .get(claim.id) as { status: string; attempts: number; epoch: number; last_error: string | null } | undefined;
  if (!row || row.attempts !== claim.attempts || row.epoch !== claim.epoch) return { status: "stale" };
  const error = row.last_error ?? undefined;
  switch (row.status) {
    case "done": return { status: "done" };
    case "failed": return { status: "dead-letter", error };
    case "queued": return { status: "requeued", error };
    default: throw new Error("Handler returned without settling its claim");
  }
}

export async function dispatchClaim(
  db: Db, claim: JobClaim, deps?: Runtime, handlers: DispatchHandlers = {},
): Promise<JobOutcome> {
  switch (claim.kind) {
    case "distill": {
      if (!deps) throw new Error("Distill requires a runtime");
      await (handlers.distill ?? (await import("../engine/compactor.js")).runDistillJob)(db, claim, deps);
      return claimOutcome(db, claim);
    }
    case "link-cluster": {
      if (!deps) throw new Error("Link-cluster requires a runtime");
      const result = await (handlers.linkCluster ?? (await import("../engine/link-cluster-job.js")).runLinkClusterJob)(db, claim, { backend: deps.backend });
      return { ...result, warnings: result.naming.warnings };
    }
    case "backfill":
    case "backfill-page": {
      const outcome = (handlers.backfill ?? (await import("../backfill/jobs.js")).dispatchJob)(db, claim, {});
      const warnings = outcome.result?.failures.map(item => `${item.path}: ${item.error}`) ?? [];
      if (outcome.result && "failedPages" in outcome.result) {
        warnings.push(...outcome.result.failedPages.map(item => `${item.jobId}: ${item.error}`));
      }
      return { ...outcome, warnings };
    }
    default: throw new UnsupportedJobKind(claim.kind);
  }
}
