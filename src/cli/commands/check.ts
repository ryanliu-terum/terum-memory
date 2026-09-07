import { runCheckDecision } from "../../decisions/check.js";
import { command, parse, runtime, type CommandDeps } from "./shared.js";
export interface CheckDeps extends CommandDeps { check?: typeof runCheckDecision }
export async function run(args: string[], deps: CheckDeps = {}): Promise<number> {
  return command(deps, 'check "<statement>"', async (db, out) => {
    const { positional } = parse(args, {}, 1);
    const result = await (deps.check ?? runCheckDecision)(db, positional[0]!, await runtime(db, deps));
    if (result.error) throw new Error(result.error);
    out(result.candidates.length ? result.candidates.map(row => `${row.decision_id}\t${row.similarity.toFixed(3)}\t${row.decision_text}\t${row.reason ?? ""}`).join("\n") : "No conflicting decision found.");
    return 0;
  });
}
