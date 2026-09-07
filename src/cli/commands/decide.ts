import { ratifyDecision } from "../../decisions/ratify.js";
import { command, parse, runtime, type CommandDeps } from "./shared.js";
export interface DecideDeps extends CommandDeps { ratify?: typeof ratifyDecision }
export async function run(args: string[], deps: DecideDeps = {}): Promise<number> {
  return command(deps, 'decide "<text>" [--reason R --topic T]', async (db, out) => {
    const { positional, values } = parse(args, { "--reason": "value", "--topic": "value" }, 1);
    const text = positional[0]!;
    const result = await (deps.ratify ?? ratifyDecision)(db, { decision_text: text,
      reason: values["--reason"] as string | undefined, topic: values["--topic"] as string | undefined,
      human_confirmed: true, human_confirmation_quote: text }, await runtime(db, deps));
    if (!result.ok) throw new Error(result.error);
    out(`${result.decisionId} ${result.merged ? "merged" : "created"}`);
    return 0;
  });
}
