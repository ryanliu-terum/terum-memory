import { installClaudeCodeConfig } from "../../connect/config-edit.js";
import { prepareBackfill, type BackfillDeps } from "./backfill.js";
import { command, parse, spawn } from "./shared.js";
export async function run(args: string[], deps: BackfillDeps = {}): Promise<number> {
  return command(deps, "connect claude-code [--no-backfill]", async (db, out) => {
    const { values } = parse(args, { "--no-backfill": "boolean" });
    installClaudeCodeConfig(deps);
    out("Claude Code Stop hook and MCP integration installed.");
    const snapshot = await prepareBackfill(db, [], deps, out, !values["--no-backfill"]);
    if (snapshot) await spawn(deps);
    return 0;
  });
}
