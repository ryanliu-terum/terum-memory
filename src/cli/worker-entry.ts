#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { openDb, type Db } from "../db/open.js";
import { terumHome } from "../db/paths.js";
import { drainOnce, type DrainOptions, type RuntimeSource } from "../worker/loop.js";
import { readWorkerLock, releaseWorkerLock } from "../worker/spawn.js";
export interface WorkerEntryDeps {
  db?: Db;
  dbPath?: string;
  home?: string;
  token?: string;
  runtime?: RuntimeSource;
  drainOptions?: DrainOptions;
  wait?: (ms: number) => Promise<unknown>;
  err?: (message: string) => void;
}
/** Stay alive for delayed pages/retries; stop when only unavailable work remains. */
export async function runWorker(deps: WorkerEntryDeps = {}): Promise<number> {
  const home = deps.home ?? terumHome();
  const file = path.join(home, "worker.lock");
  const token = deps.token ?? process.env.TERUM_WORKER_TOKEN;
  let db: Db | undefined;
  try {
    db = deps.db ?? openDb({ dbPath: deps.dbPath ?? process.env.TERUM_WORKER_DB });
    for (;;) {
      if (token) {
        if (readWorkerLock(file)?.token !== token) throw new Error("Worker lock ownership lost");
        const now = new Date();
        fs.utimesSync(file, now, now);
      }
      const result = await drainOnce(db, deps.runtime, { ...deps.drainOptions, maxJobs: 5 });
      const err = deps.err ?? console.error;
      if (result.runtimeUnavailable) err(`Worker waiting on ${result.reason}`);
      for (const item of result.results) {
        if (item.status !== "done") err(`${item.id}: ${item.status}${item.error ? `: ${item.error}` : ""}`);
        for (const warning of item.warnings ?? []) err(`${item.id}: partial work: ${warning}`);
      }
      if (result.unsupported.length) { err(`Unsupported queued jobs: ${result.unsupported.join(", ")}`); return 0; }
      const pending = db.prepare(`SELECT run_after, lease_until, status FROM jobs
        WHERE status IN ('queued', 'running') AND kind IN (${result.runtimeUnavailable ? "'backfill','backfill-page'" : "'distill','link-cluster','backfill','backfill-page'"})`)
        .all() as Array<{ run_after: string | null; lease_until: string | null; status: string }>;
      if (!pending.length) return 0;
      const now = (deps.drainOptions?.now ?? (() => new Date()))().getTime();
      const next = Math.min(...pending.map(row => Math.max(row.run_after ? Date.parse(row.run_after) : now,
        row.status === "running" && row.lease_until ? Date.parse(row.lease_until) + 1 : now)));
      await (deps.wait ?? delay)(Math.max(10, Math.min(30_000, next - now)));
    }
  } catch (error) {
    (deps.err ?? console.error)(`terum-memory worker: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    if (db && !deps.db) db.close();
    if (token) releaseWorkerLock(file, token);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runWorker();
