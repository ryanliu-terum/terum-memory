import { getMeta, type Db } from "../../db/open.js";
import { manifestFor } from "../../engine/models.js";
import { enqueueJob } from "../../jobs/queue.js";
import { bounded, command, parse, reportDrain, UsageError, type CommandDeps } from "./shared.js";

export interface ReembedCommandDeps extends CommandDeps {
  manifestFor?: typeof manifestFor;
  drain?: typeof bounded;
}

/** One pending switch owns the shared shadow tables, even if a later request names another target. */
export function enqueueReembed(db: Db, targetEmbedderId: string): string {
  return db.transaction(() => {
    const pending = db.prepare(`SELECT id FROM jobs WHERE kind = 'reembed' AND status IN ('queued', 'running')
      ORDER BY created_at, rowid LIMIT 1`).get() as { id: string } | undefined;
    return pending?.id ?? enqueueJob(db, "reembed", { targetEmbedderId });
  }).immediate();
}

export async function run(args: string[], deps: ReembedCommandDeps = {}): Promise<number> {
  try {
    return await command(deps, "reembed --model <id>", async (db, out) => {
      const { values } = parse(args, { "--model": "value" });
      const id = values["--model"] as string | undefined;
      if (!id) throw new UsageError("--model is required");
      if (getMeta(db, "embedder_id") === id) {
        out(`Already using ${id}; nothing to reembed.`);
        return 0;
      }
      try {
        const manifest = (deps.manifestFor ?? manifestFor)(id);
        if (manifest.id !== id || !Number.isSafeInteger(manifest.dim) || manifest.dim <= 0) {
          throw new Error(`unknown embedder "${id}"`);
        }
      }
      catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        (deps.err ?? console.error)(reason.includes("placeholder")
          ? `cannot reembed: ${id} is not pinned/calibrated yet`
          : `cannot reembed: ${reason}`);
        return 1;
      }
      const jobId = enqueueReembed(db, id);
      const job = db.prepare("SELECT payload FROM jobs WHERE id = ?").get(jobId) as { payload: string };
      const target = (JSON.parse(job.payload) as { targetEmbedderId: string }).targetEmbedderId;
      const counts = db.prepare(`SELECT (SELECT count(*) FROM notes) AS notes,
        (SELECT count(*) FROM decisions) AS decisions`).get() as { notes: number; decisions: number };
      out(`Reembed ${jobId}: re-embed ${counts.notes} notes + ${counts.decisions} decisions under ${target}; other work pauses until it finishes.`);
      reportDrain(await (deps.drain ?? bounded)(db, deps), out);
      return 0;
    }, false);
  } catch (error) {
    (deps.err ?? console.error)(`cannot reembed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
