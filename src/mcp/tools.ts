import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Db } from "../db/open.js";
import { runCheckDecision, runGetStandingDecisions } from "../decisions/check.js";
import { ratifyDecision } from "../decisions/ratify.js";
import type { Embedder } from "../engine/embedder-types.js";
import type { ChatBackend } from "../llm/backend.js";
import { runSearch } from "../search/engine.js";

export interface McpDeps { db: Db; embedder: Embedder; backend: ChatBackend }

export const TOOL_DESCRIPTIONS = {
  check_decision: 'Check whether a statement or action you are about to take conflicts with a decision you have already recorded. Call with {"statement":"…"}. Returns candidate decisions ranked by similarity for YOU to judge — it does not decide for you. An empty list means no candidate cleared the bar, not that the topic is settled. Silent when clear: if nothing genuinely conflicts, do not mention the check.',
  search_knowledge: "Search your distilled notes and decisions for content relevant to a query. Returns ranked structured results (topic, summary, text, kind, similarity) for you to read and synthesize — it does not answer for you.",
  get_standing_decisions: "List your recent decisions, most recent first, optionally filtered by topic. Each carries the decision text, topic, provenance, and date.",
  ratify_decision: "Record a decision the human made explicitly in THIS session, so future sessions see it via check_decision / get_standing_decisions. Call ONLY after the human clearly made the call ('let's go with X', 'do it that way'): phrase the decision in one plain sentence, supply the reason, and pass their verbatim confirming words as human_confirmation_quote with human_confirmed:true. Never call this on your own initiative, and never record speculation or options still under discussion.",
} as const;

const limit = z.number().int().min(1).max(50).optional();
export const TOOL_INPUT_SCHEMAS = {
  check_decision: {
    statement: z.string().optional(),
    action: z.string().optional().describe("Deprecated alias for statement"),
    decision: z.string().optional().describe("Deprecated alias for statement"),
  },
  search_knowledge: { query: z.string(), limit },
  get_standing_decisions: { topic: z.string().optional(), limit },
  ratify_decision: {
    decision_text: z.string().refine(text => text.trim().length > 0, "decision_text must be non-blank"),
    reason: z.string().optional(),
    topic: z.string().optional(),
    human_confirmed: z.boolean().optional(),
    human_confirmation_quote: z.string().optional(),
  },
} as const;

type Args<K extends keyof typeof TOOL_INPUT_SCHEMAS> = z.infer<z.ZodObject<typeof TOOL_INPUT_SCHEMAS[K]>>;

function result(payload: object): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    ...("error" in payload ? { isError: true } : {}),
  };
}

// Preserve thrown infrastructure/placeholder errors as visible tool failures too.
async function invoke(work: () => Promise<object>): Promise<CallToolResult> {
  try {
    return result(await work());
  } catch (error) {
    return result({ error: error instanceof Error ? error.message : String(error) });
  }
}

export const TOOL_HANDLERS = {
  async check_decision(args: Args<"check_decision">, deps: McpDeps): Promise<CallToolResult> {
    const statement = [args.statement, args.action, args.decision]
      .find(value => typeof value === "string" && value.trim().length > 0);
    if (statement === undefined) {
      return result({ error: "check_decision did NOT run. Retry with a non-blank statement parameter." });
    }
    return invoke(() => runCheckDecision(deps.db, statement, deps));
  },
  async search_knowledge(args: Args<"search_knowledge">, deps: McpDeps): Promise<CallToolResult> {
    return invoke(() => runSearch(deps.db, args.query, deps, { limit: args.limit }));
  },
  async get_standing_decisions(args: Args<"get_standing_decisions">, deps: McpDeps): Promise<CallToolResult> {
    return invoke(() => runGetStandingDecisions(deps.db, args, deps));
  },
  async ratify_decision(args: Args<"ratify_decision">, deps: McpDeps): Promise<CallToolResult> {
    const parsed = z.object(TOOL_INPUT_SCHEMAS.ratify_decision).safeParse(args);
    if (!parsed.success) return result({ error: parsed.error.message });
    return invoke(() => ratifyDecision(deps.db, parsed.data, deps));
  },
};
