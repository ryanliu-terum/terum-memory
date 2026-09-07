import { runGetStandingDecisions } from "../../decisions/check.js";
import type { Embedder } from "../../engine/embedder-types.js";
import { command, parse, runtime, type CommandDeps } from "./shared.js";
export interface DecisionsDeps extends CommandDeps { standing?: typeof runGetStandingDecisions }
export async function run(args: string[], deps: DecisionsDeps = {}): Promise<number> {
  return command(deps, "decisions [--topic T] [--unpublished]", async (db, out) => {
    const { values } = parse(args, { "--topic": "value", "--unpublished": "boolean" });
    const topic = values["--topic"] as string | undefined;
    // The unfiltered engine path never embeds. Do not require calibrated models to list rows.
    const embedder: Embedder = { id: "unavailable", dim: 0, embed: async () => { throw new Error("Embedding unavailable"); } };
    const result = await (deps.standing ?? runGetStandingDecisions)(db, { topic }, topic ? await runtime(db, deps) : { embedder });
    if (result.error) throw new Error(result.error);
    if (values["--unpublished"]) out("All decisions are unpublished in v0.1.");
    // M7 caps its standing view at 50; the explicit all/unpublished view must not silently truncate.
    const rows = values["--unpublished"] && topic === undefined ? db.prepare(`SELECT id AS decision_id,
      decision_text, topic, provenance, decided_at FROM decisions ORDER BY decided_at DESC, id`).all() as typeof result.decisions : result.decisions;
    out(rows.length ? "ID\tTOPIC\tPROVENANCE\tDECISION\n" + rows.map(row => `${row.decision_id}\t${row.topic ?? ""}\t${row.provenance}\t${row.decision_text}`).join("\n") : "No standing decisions found.");
    return 0;
  });
}
