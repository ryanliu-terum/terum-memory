import { command, parse, type CommandDeps } from "./shared.js";
export async function run(args: string[], deps: CommandDeps = {}): Promise<number> {
  return command(deps, "show <id>", async (db, out) => {
    const { positional: [id] } = parse(args, {}, 1);
    const row = db.prepare("SELECT * FROM decisions WHERE id = ?").get(id) ?? db.prepare("SELECT * FROM notes WHERE id = ?").get(id);
    out(row ? JSON.stringify(row, null, 2) : "No decision or note found.");
    return 0;
  });
}
