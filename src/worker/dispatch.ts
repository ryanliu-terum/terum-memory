import type { Db } from "../db/open.js";
import type { JobClaim } from "../jobs/types.js";
import type { Embedder } from "../engine/embedder-types.js";
import type { ChatBackend } from "../llm/backend.js";
import { getMeta } from "../db/open.js";
import { reembedTarget, runReembedJob, type ReembedDeps } from "../engine/reembed.js";

export interface Runtime {
  backend: ChatBackend;
  embedder: Embedder;
  embedderFor?: ReembedDeps["embedderFor"];
  now?: () => Date;
}
export interface JobOutcome {
  status: "done" | "stale" | "requeued" | "dead-letter" | "rescheduled";
  error?: string;
  warnings?: string[];
}
export class UnsupportedJobKind extends Error {
  constructor(kind: string) { super(`Unsupported job kind: ${kind}`); }
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
    case "reembed": {
      const target = reembedTarget(claim);
      let embedder: Embedder | undefined;
      if (getMeta(db, "embedder_id") !== target) {
        try {
          if (!deps) throw new Error("Reembed requires a runtime");
          embedder = await (deps.embedderFor ?? (async id => {
            const { manifestFor } = await import("../engine/models.js");
            const { createLocalEmbedder } = await import("../engine/embedder.js");
            // createLocalEmbedder installs/verifies the pinned artifact before local inference.
            return createLocalEmbedder(manifestFor(id));
          }))(target);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          const now = (deps?.now ?? (() => new Date()))();
          // Runtime unavailability does not spend retries. Delay avoids a hot drain loop.
          const returned = db.transaction(() => db.prepare(`UPDATE jobs SET status = 'queued',
            attempts = attempts - 1, epoch = epoch + 1, lease_until = NULL,
            run_after = ?, updated_at = ?, last_error = ?
            WHERE id = ? AND attempts = ? AND epoch = ? AND status = 'running'`)
            .run(new Date(now.getTime() + 30_000).toISOString(), now.toISOString(), reason,
              claim.id, claim.attempts, claim.epoch).changes === 1).immediate();
          return { status: returned ? "requeued" : "stale", error: reason };
        }
      }
      const result = await runReembedJob(db, claim, {
        embedderFor: async () => {
          if (!embedder) throw new Error("Target embedder was not loaded");
          return embedder;
        },
        now: deps?.now,
      });
      // The loop caches this runtime. Subsequent distills must use the new space.
      if (result.status === "done" && deps && embedder) deps.embedder = embedder;
      return result;
    }
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
