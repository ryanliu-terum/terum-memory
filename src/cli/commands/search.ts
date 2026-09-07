import { runSearch } from "../../search/engine.js";
import { command, parse, runtime, type CommandDeps } from "./shared.js";
export interface SearchDeps extends CommandDeps { search?: typeof runSearch }
export async function run(args: string[], deps: SearchDeps = {}): Promise<number> {
  return command(deps, 'search "<query>"', async (db, out) => {
    const { positional } = parse(args, {}, 1);
    const result = await (deps.search ?? runSearch)(db, positional[0]!, await runtime(db, deps));
    if (result.error) throw new Error(result.error);
    out(result.results.length ? result.results.map((row, i) => `${i + 1}. ${row.id}\t${row.similarity.toFixed(3)}\t${row.text}`).join("\n") : "No results found.");
    return 0;
  });
}
