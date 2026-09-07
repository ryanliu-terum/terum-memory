import { uninstallClaudeCodeConfig } from "../../connect/config-edit.js";
import { command, parse, type CommandDeps } from "./shared.js";
export async function run(args: string[], deps: CommandDeps = {}): Promise<number> {
  return command(deps, "uninstall", async (db, out) => {
    parse(args, {});
    uninstallClaudeCodeConfig(deps);
    out(`Claude Code integration removed. Database remains: ${db.name} (one deletable database file).`);
    return 0;
  });
}
