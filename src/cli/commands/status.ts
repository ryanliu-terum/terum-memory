import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getMeta } from "../../db/open.js";
import { queueCounts } from "../../jobs/queue.js";
import { command, config, parse, runtime, type CommandDeps } from "./shared.js";

export function hookInstalled(file: string): boolean {
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  const object = (item: unknown): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item);
  if (!object(value) || !object(value.hooks) || !Array.isArray(value.hooks.Stop)) return false;
  return value.hooks.Stop.some(entry => object(entry) && Array.isArray(entry.hooks) &&
    entry.hooks.some((hook: unknown) => object(hook) && hook.type === "command" && hook.command === "terum-memory hook stop"));
}
export async function run(args: string[], deps: CommandDeps = {}): Promise<number> {
  return command(deps, "status", async (db, out) => {
    parse(args, {});
    const counts = queueCounts(db);
    out(`Database: ${db.name} (${fs.statSync(db.name).size} bytes)`);
    out(`Queue: ${JSON.stringify(counts)}`);
    const pending = db.prepare("SELECT count(*) AS n FROM captures WHERE distilled_at IS NULL").get() as { n: number };
    out(`Undistilled captures: ${pending.n}`);
    out(`Embedder: ${getMeta(db, "embedder_id") ?? "not initialized"}`);
    out(`Backend: ${(await config(deps)).chat?.backend ?? "off (capture-only mode)"}`);
    out(`Stop hook: ${hookInstalled(deps.settingsPath ?? path.join(os.homedir(), ".claude", "settings.json")) ? "installed" : "not installed"}`);
    out(`Parse errors: ${getMeta(db, "parse_errors") ?? "none"}`);
    try { await runtime(db, deps); }
    catch (error) { out(`${counts.queued} jobs queued, waiting on ${error instanceof Error ? error.message : String(error)}`); }
    return 0;
  });
}
