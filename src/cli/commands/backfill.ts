import { createInterface } from "node:readline/promises";
import { scanTranscripts, buildBackfillSnapshot, type BackfillSnapshot } from "../../backfill/scan.js";
import { planBackfill, backfillHoneurReport, SUBSCRIPTION_CAP } from "../../backfill/report.js";
import { enqueueJob } from "../../jobs/queue.js";
import type { Db } from "../../db/open.js";
import { bounded, command, config, parse, reportDrain, UsageError, type CommandDeps } from "./shared.js";

// Operational pacing only, not a calibrated model/throughput constant.
export const SLOW_INTERVAL_MS = 5 * 60_000;
export interface BackfillDeps extends CommandDeps { slowIntervalMs?: number; now?: () => Date }
async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^(y|yes)$/i.test((await input.question(`${question} [y/N] `)).trim()); }
  finally { input.close(); }
}
export async function prepareBackfill(
  db: Db, args: string[], deps: BackfillDeps, out: (text: string) => void, enqueue = true,
): Promise<BackfillSnapshot | null> {
  const { values } = parse(args, { "--limit": "value", "--all": "boolean", "--slow": "boolean" });
  if (Object.keys(values).length > 1) throw new UsageError("--limit, --all and --slow are mutually exclusive");
  const raw = values["--limit"] as string | undefined;
  if (raw !== undefined && !/^\d+$/.test(raw)) throw new UsageError("--limit must be a nonnegative integer");
  if (raw !== undefined && !Number.isSafeInteger(Number(raw))) throw new UsageError("--limit is too large");
  const scan = scanTranscripts({ projectsDir: deps.projectsDir });
  const chat = (await config(deps)).chat;
  const env = deps.env ?? process.env;
  const lane = chat?.backend === "ollama" ? "ollama" : chat?.backend === "openai-compatible" &&
    Boolean(env[chat.api_key_env ?? "OPENAI_API_KEY"]?.trim()) ? "api-key" : "subscription";
  const plan = planBackfill(scan, { lane, all: values["--all"] === true,
    limit: values["--slow"] ? scan.transcripts.length : raw === undefined ? undefined : Number(raw) });
  const snapshot = buildBackfillSnapshot(scan, plan.limit);
  out(`Backfill plan: ${snapshot.selected.length} selected, ${snapshot.omitted.length} omitted. ${plan.estimate}`);
  if (values["--slow"]) out(`Slow mode: at most ${SUBSCRIPTION_CAP} sessions per batch, ${(deps.slowIntervalMs ?? SLOW_INTERVAL_MS) / 60_000} minutes apart.`);
  if (!enqueue || !snapshot.selected.length) { out(backfillHoneurReport(db, snapshot).message); return null; }
  if ((plan.needsCostConfirm || (values["--all"] && snapshot.selected.length > 200)) &&
      !await (deps.confirm ?? confirm)(`Import and distill ${snapshot.selected.length} sessions?`)) {
    out("Backfill not enqueued: confirmation required (run interactively).");
    return null;
  }
  const now = (deps.now ?? (() => new Date()))();
  const interval = deps.slowIntervalMs ?? SLOW_INTERVAL_MS;
  if (!Number.isSafeInteger(interval) || interval <= 0) throw new UsageError("Slow interval must be positive");
  const ids = db.transaction(() => {
    const enqueued: string[] = [];
    const batches = values["--slow"] ? Math.ceil(snapshot.selected.length / SUBSCRIPTION_CAP) : 1;
    for (let i = 0; i < batches; i++) {
      const selected = values["--slow"] ? snapshot.selected.slice(i * SUBSCRIPTION_CAP, (i + 1) * SUBSCRIPTION_CAP) : snapshot.selected;
      const id = enqueueJob(db, "backfill", { snapshot: { ...snapshot, selected }, pageSize: SUBSCRIPTION_CAP, pageCursor: 0 },
        { now: () => now, runAfter: new Date(now.getTime() + i * interval) });
      enqueued.push(id);
    }
    return enqueued;
  }).immediate();
  for (const id of ids) out(`Enqueued backfill ${id}`);
  return snapshot;
}
export async function run(args: string[], deps: BackfillDeps = {}): Promise<number> {
  return command(deps, "backfill [--limit N | --all | --slow]", async (db, out) => {
    const snapshot = await prepareBackfill(db, args, deps, out);
    reportDrain(await bounded(db, deps), out);
    if (snapshot) out(backfillHoneurReport(db, snapshot).message);
    return 0;
  }, false);
}
