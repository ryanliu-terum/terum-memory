import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { scanTranscripts } from "../../backfill/scan.js";
import { isMissing } from "../../connect/atomic-write.js";
import { uninstallClaudeCodeConfig } from "../../connect/config-edit.js";
import type { Db } from "../../db/open.js";
import { defaultDbPath, modelsDir, terumHome } from "../../db/paths.js";
import { enforceFileModes } from "../../db/permissions.js";
import { command, parse, usageFailure, type CommandDeps } from "./shared.js";

const USAGE = "uninstall [--purge]";
const PURGE = "terum-memory uninstall --purge";

export async function run(args: string[], deps: CommandDeps = {}): Promise<number> {
  let purging: boolean;
  try { purging = parse(args, { "--purge": "boolean" }).values["--purge"] === true; }
  catch (error) { return usageFailure(deps, USAGE, error); }
  if (!purging) {
    return command(deps, USAGE, async (_db, out) => {
      uninstallClaudeCodeConfig(deps);
      out(`Claude Code integration removed. Data remains under ${terumHome()}; \`${PURGE}\` wipes it.`);
      return 0;
    });
  }
  // The purge owns its connection: the checkpoint must precede the close, and
  // the close must precede the unlink, so `command()`'s open/close bracket and
  // its post-action drain (which needs the database) cannot wrap this path.
  return purge(deps);
}

function liveLeases(db: Db, now: string): number {
  const row = db.prepare(
    "SELECT count(*) AS n FROM jobs WHERE status = 'running' AND lease_until >= ?",
  ).get(now) as { n: number };
  return row.n;
}

/** Unlink one owned file; a missing file is a completed step, not an error. */
function unlink(file: string): boolean {
  try { fs.unlinkSync(file); return true; }
  catch (error) { if (isMissing(error)) return false; throw error; }
}

function removeIfEmpty(dir: string): { removed: boolean; remaining: string[] } {
  let remaining: string[];
  try { remaining = fs.readdirSync(dir); }
  catch (error) { if (isMissing(error)) return { removed: false, remaining: [] }; throw error; }
  if (remaining.length) return { removed: false, remaining };
  fs.rmdirSync(dir);
  return { removed: true, remaining };
}

/** Model directories we installed carry our marker; anything else under models/ is not ours. */
function installedModelDirs(models: string): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(models, { withFileTypes: true }); }
  catch (error) { if (isMissing(error)) return []; throw error; }
  return entries
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(models, entry.name, ".installed.json")))
    .map(entry => path.join(models, entry.name));
}

/**
 * The only sanctioned data wipe. Order matters: Claude Code stops invoking us
 * first, a live worker lease refuses the wipe, the WAL is folded into the main
 * file and the connection closed, and only then is the owned set unlinked.
 * Every step tolerates having already happened, so a rerun after a partial
 * failure finishes the job.
 */
async function purge(deps: CommandDeps): Promise<number> {
  const out = deps.out ?? console.log;
  const warn = deps.err ?? console.warn;
  const home = terumHome();
  const models = modelsDir();
  const dbPath = deps.dbPath ?? deps.db?.name ?? defaultDbPath();
  const sidecars = [`${dbPath}-wal`, `${dbPath}-shm`];

  uninstallClaudeCodeConfig(deps);
  out("Claude Code integration removed.");

  // A missing database means a previous purge got this far; there is nothing to check or checkpoint.
  let db: Db | undefined = deps.db;
  if (!db && fs.existsSync(dbPath)) {
    db = new Database(dbPath, { fileMustExist: true });
    enforceFileModes([dbPath, ...sidecars], warn);
  }
  if (db) {
    let checkpointed = false;
    try {
      const live = liveLeases(db, new Date().toISOString());
      if (live > 0) {
        out(`Refusing to purge: ${live} job(s) hold a live lease, so a worker is still running. ` +
          `Wait for it to finish (see \`terum-memory status\`), then rerun \`${PURGE}\`. No data was deleted.`);
        return 1;
      }
      db.pragma("wal_checkpoint(TRUNCATE)");
      checkpointed = true;
    } finally {
      // The files cannot go while a handle is open, so a caller-provided
      // connection closes too once the wipe is committed to; on refusal it stays theirs.
      if (checkpointed || !deps.db) db.close();
    }
  }

  const removed: string[] = [];
  const owned = [
    dbPath, ...sidecars,
    path.join(home, "config.json"),
    path.join(home, "worker.lock"),
    ...scanTranscripts({ projectsDir: deps.projectsDir }).transcripts.map(item => `${item.path}.terum-offset`),
  ];
  for (const file of owned) if (unlink(file)) removed.push(file);
  for (const dir of installedModelDirs(models)) {
    fs.rmSync(dir, { recursive: true });
    removed.push(dir);
  }
  const modelsLeft = removeIfEmpty(models);
  if (modelsLeft.removed) removed.push(models);
  const homeLeft = removeIfEmpty(home);
  if (homeLeft.removed) removed.push(home);
  const kept = homeLeft.remaining.flatMap(name => name === path.basename(models) && modelsLeft.remaining.length
    ? modelsLeft.remaining.map(child => path.join(models, child))
    : [path.join(home, name)]);

  if (removed.length === 0) out("Nothing to remove: no terum-memory data found.");
  else for (const item of removed) out(`Removed ${item}`);
  if (kept.length) {
    out(`Kept ${home}: it still holds entries terum-memory does not own:`);
    for (const item of kept) out(`  ${item}`);
  }
  return 0;
}
