import path from "node:path";
import { openDb, type Db } from "../../db/open.js";
import { defaultDbPath } from "../../db/paths.js";
import type { ClaudeCodeConfigOptions } from "../../connect/config-edit.js";
import type { TerumConfig } from "../../llm/config.js";
import type { RuntimeSource, DrainOptions, DrainResult } from "../../worker/loop.js";

export interface CommandDeps extends ClaudeCodeConfigOptions {
  db?: Db;
  dbPath?: string;
  projectsDir?: string;
  out?: (text: string) => void;
  err?: (text: string) => void;
  loadConfig?: () => TerumConfig;
  runtime?: RuntimeSource;
  drainOptions?: DrainOptions;
  spawn?: () => boolean | Promise<boolean>;
  opportunistic?: boolean;
  env?: NodeJS.ProcessEnv;
  confirm?: (question: string) => Promise<boolean>;
}
export class UsageError extends Error {}
export function parse(args: string[], flags: Record<string, "boolean" | "value">, positionalCount = 0): {
  values: Record<string, string | true>; positional: string[];
} {
  const values: Record<string, string | true> = Object.create(null) as Record<string, string | true>;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("-")) {
      if (!Object.hasOwn(flags, arg) || Object.hasOwn(values, arg)) throw new UsageError(`Unknown or repeated flag: ${arg}`);
      if (flags[arg] === "boolean") values[arg] = true;
      else {
        const value = args[++i];
        if (value === undefined || value.startsWith("--") || !value.trim()) throw new UsageError(`Missing value for ${arg}`);
        values[arg] = value;
      }
    } else positional.push(arg);
  }
  if (positional.length !== positionalCount || positional.some(text => !text.trim())) throw new UsageError("Invalid arguments");
  return { values, positional };
}
export async function config(deps: CommandDeps): Promise<TerumConfig> {
  return (deps.loadConfig ?? (await import("../../llm/config.js")).loadConfig)();
}
export async function runtime(db: Db, deps: CommandDeps) {
  const source = deps.runtime;
  if (source) return typeof source === "function" ? source() : source;
  return (await import("../../worker/runtime.js")).buildRuntime(db, { loadConfig: deps.loadConfig });
}
export async function spawn(deps: CommandDeps): Promise<boolean> {
  if (deps.spawn) return deps.spawn();
  const dbPath = deps.dbPath ?? deps.db?.name ?? defaultDbPath();
  return (await import("../../worker/spawn.js")).spawnDetachedWorker({ home: path.dirname(dbPath), dbPath });
}
export function reportDrain(result: DrainResult, out: (text: string) => void): void {
  out(`${result.processed} jobs completed`);
  if (result.runtimeUnavailable) out(`Jobs queued, waiting on ${result.reason}`);
  if (result.unsupported.length) out(`Skipped unsupported jobs: ${result.unsupported.join(", ")}`);
  for (const item of result.results) {
    for (const warning of item.warnings ?? []) out(`${item.id}: partial work: ${warning}`);
    if (item.status !== "done") out(`${item.id}: ${item.status}${item.error ? `: ${item.error}` : ""}`);
  }
}
export async function bounded(db: Db, deps: CommandDeps): Promise<DrainResult> {
  return (await import("../../worker/loop.js")).drainBounded(db, () => runtime(db, deps), 5,
    { ...deps.drainOptions, spawn: () => spawn(deps) });
}
export async function command(
  deps: CommandDeps, usage: string, action: (db: Db, out: (text: string) => void) => Promise<number>,
  opportunistic = true,
): Promise<number> {
  const out = deps.out ?? console.log;
  let db: Db | undefined;
  try {
    db = deps.db ?? openDb({ dbPath: deps.dbPath });
    const code = await action(db, out);
    if (code === 0 && opportunistic && deps.opportunistic !== false) {
      const result = await bounded(db, deps);
      if (result.results.length || result.skipped) reportDrain(result, out);
    }
    return code;
  } catch (error) {
    return usageFailure(deps, usage, error);
  } finally { if (db && !deps.db) db.close(); }
}
/** Report a usage error with exit code 1; anything else propagates untouched. */
export function usageFailure(deps: CommandDeps, usage: string, error: unknown): number {
  if (!(error instanceof UsageError)) throw error;
  (deps.err ?? console.error)(`${error.message}\nUsage: terum-memory ${usage}`);
  return 1;
}
