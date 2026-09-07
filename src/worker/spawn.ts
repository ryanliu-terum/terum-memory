import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { atomicWrite } from "../connect/atomic-write.js";
import { openDb } from "../db/open.js";
import { terumHome } from "../db/paths.js";
import { ensureTerumDir, enforceFileModes } from "../db/permissions.js";

export const LOCK_STALE_MS = 5 * 60_000;
export interface SpawnOptions {
  home?: string;
  dbPath?: string;
  spawn?: typeof nodeSpawn;
  now?: () => number;
  staleMs?: number;
  isAlive?: (pid: number) => boolean;
}
interface Lock { pid: number; token: string }
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    throw error;
  }
}
export function readWorkerLock(file: string): Lock | undefined {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof value !== "object" || value === null || !("pid" in value) || !("token" in value) ||
        !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0 || typeof value.token !== "string") return undefined;
    return value as Lock;
  } catch (error) {
    if (missing(error) || error instanceof SyntaxError) return undefined;
    throw error;
  }
}
export function releaseWorkerLock(file: string, token: string): void {
  if (readWorkerLock(file)?.token !== token) return;
  try { fs.unlinkSync(file); } catch (error) { if (!missing(error)) throw error; }
}

/** Lightweight module: the Stop hook must never load the worker's engines. */
export async function spawnDetachedWorker(opts: SpawnOptions = {}): Promise<boolean> {
  const home = opts.home ?? terumHome();
  const file = path.join(home, "worker.lock");
  ensureTerumDir(home);
  enforceFileModes([file]);
  const token = randomUUID();
  // Serialize stale recovery with the existing database's cross-process write
  // lock. Exclusive file creation alone does not serialize two stale unlinkers.
  const db = openDb({ dbPath: opts.dbPath ?? path.join(home, "terum.db") });
  let acquired: boolean;
  try {
    acquired = db.transaction(() => {
      for (;;) {
        let fd: number;
        try { fd = fs.openSync(file, "wx", 0o600); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const owner = readWorkerLock(file);
          let age: number;
          try { age = (opts.now ?? Date.now)() - fs.statSync(file).mtimeMs; }
          catch (statError) { if (missing(statError)) continue; throw statError; }
          if (age < (opts.staleMs ?? LOCK_STALE_MS) || (owner && (opts.isAlive ?? alive)(owner.pid))) return false;
          try { fs.unlinkSync(file); } catch (unlinkError) { if (!missing(unlinkError)) throw unlinkError; }
          continue;
        }
        try {
          enforceFileModes([file]);
          fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
          fs.fsyncSync(fd);
        } finally { fs.closeSync(fd); }
        return true;
      }
    }).immediate();
  } finally { db.close(); }
  if (!acquired) return false;
  try {
    await new Promise<void>((resolve, reject) => {
      const child = (opts.spawn ?? nodeSpawn)(process.execPath,
        [fileURLToPath(new URL("../cli/worker-entry.js", import.meta.url))], {
          detached: true, stdio: "ignore",
          env: { ...process.env, TERUM_HOME: home, TERUM_WORKER_TOKEN: token,
            TERUM_WORKER_DB: opts.dbPath ?? path.join(home, "terum.db") },
        });
      child.once("error", reject);
      child.once("spawn", () => {
        try {
          if (!child.pid) throw new Error("Detached worker did not receive a pid");
          if (readWorkerLock(file)?.token !== token) throw new Error("Detached worker lock ownership lost");
          atomicWrite(file, JSON.stringify({ pid: child.pid, token }));
          enforceFileModes([file]);
          child.unref();
          resolve();
        } catch (error) { reject(error); }
      });
    });
    return true;
  } catch (error) {
    releaseWorkerLock(file, token);
    throw error;
  }
}
