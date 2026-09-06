import type { Db } from "../db/open.js";
import type { BackfillSnapshot, TranscriptScan } from "./scan.js";

export const SUBSCRIPTION_CAP = 50;
export const COST_CONFIRM_THRESHOLD = 200;

export interface BackfillReport {
  undistilledCount: number;
  omittedCount: number;
  omittedAgeRange: { oldest: string; newest: string } | null;
  status: "complete" | "partial";
  message: string;
}

export function backfillHoneurReport(db: Db, snapshot: BackfillSnapshot): BackfillReport {
  const { count: undistilledCount } = db.prepare(
    "SELECT count(*) AS count FROM captures WHERE distilled_at IS NULL",
  ).get() as { count: number };
  const omittedCount = snapshot.omitted.length;
  const omittedAgeRange = snapshot.omittedAgeRange === null ? null : {
    oldest: new Date(snapshot.omittedAgeRange.oldestMtimeMs).toISOString(),
    newest: new Date(snapshot.omittedAgeRange.newestMtimeMs).toISOString(),
  };
  const status = omittedCount === 0 && undistilledCount === 0 ? "complete" : "partial";
  const age = omittedAgeRange === null ? "age range: none" :
    `oldest ${omittedAgeRange.oldest}, newest ${omittedAgeRange.newest}`;
  return {
    undistilledCount, omittedCount, omittedAgeRange, status,
    message: status === "complete" ? "Backfill complete: 0 omitted sessions, 0 undistilled captures." :
      `Backfill partial: ${omittedCount} omitted sessions (${age}); ${undistilledCount} undistilled captures. ` +
      "Use backfill --all (uses an API key or Ollama to distill everything) or " +
      "backfill --slow (opt-in subscription trickle).",
  };
}

export interface BackfillPlanOptions {
  all?: boolean;
  limit?: number;
  /** Backend availability, not a secret or credential value. */
  lane?: "subscription" | "api-key" | "ollama";
}

export function planBackfill(scan: TranscriptScan, opts: BackfillPlanOptions = {}): {
  limit: number; needsCostConfirm: boolean; estimate: string;
} {
  if (opts.limit !== undefined && (!Number.isSafeInteger(opts.limit) || opts.limit < 0)) {
    throw new Error("limit must be a nonnegative safe integer");
  }
  if (opts.all && opts.limit !== undefined) throw new Error("all and limit are mutually exclusive");
  const lane = opts.lane ?? "subscription";
  if (!["subscription", "api-key", "ollama"].includes(lane)) throw new Error("Unknown backfill lane");
  if (opts.all && lane === "subscription") throw new Error("backfill --all requires an API key or Ollama");
  const limit = opts.all ? scan.transcripts.length : opts.limit ?? SUBSCRIPTION_CAP;
  const selected = Math.min(limit, scan.transcripts.length);
  // No token prices or throughput measurements are available at this layer.
  const estimate = lane === "api-key" ?
    `API cost estimate: ${selected} sessions; monetary cost depends on transcript tokens and model pricing.` :
    lane === "ollama" ?
      `Local time estimate: ${selected} sessions; duration depends on transcript size, model and hardware.` :
      `Subscription workload estimate: ${selected} sessions.`;
  return { limit, needsCostConfirm: Boolean(opts.all && lane === "api-key" && selected > COST_CONFIRM_THRESHOLD), estimate };
}
