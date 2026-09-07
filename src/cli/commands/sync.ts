import { queueCounts, retryFailed } from "../../jobs/queue.js";
import { drainOnce } from "../../worker/loop.js";
import { command, parse, reportDrain, runtime, type CommandDeps } from "./shared.js";
export async function run(args: string[], deps: CommandDeps = {}): Promise<number> {
  return command(deps, "sync [--retry-failed]", async (db, out) => {
    const { values } = parse(args, { "--retry-failed": "boolean" });
    out(`Before: ${JSON.stringify(queueCounts(db))}`);
    if (values["--retry-failed"]) out(`Requeued ${retryFailed(db)} failed jobs`);
    const result = await drainOnce(db, () => runtime(db, deps), deps.drainOptions);
    reportDrain(result, out);
    const counts = queueCounts(db);
    out(`After: ${JSON.stringify(counts)}`);
    if (result.runtimeUnavailable) out(`${counts.queued} jobs queued, waiting on ${result.reason}`);
    return 0;
  }, false);
}
