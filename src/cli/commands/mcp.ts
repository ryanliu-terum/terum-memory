import { bounded, command, parse, reportDrain, type CommandDeps } from "./shared.js";
export interface McpCommandDeps extends CommandDeps { serve?: () => Promise<void> }
export async function run(args: string[], deps: McpCommandDeps = {}): Promise<number> {
  const code = await command({ ...deps, out: deps.err ?? console.error }, "mcp", async db => {
    parse(args, {});
    if (deps.opportunistic !== false) reportDrain(await bounded(db, deps), deps.err ?? console.error);
    return 0;
  }, false);
  if (code !== 0) return code;
  await (deps.serve ?? (await import("../../mcp/stdio.js")).runStdioServer)();
  return process.exitCode === undefined ? 0 : Number(process.exitCode);
}
