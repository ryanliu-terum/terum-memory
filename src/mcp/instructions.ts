export const TERUM_MCP_INSTRUCTIONS = `Terum is your local memory of your own work. It captures your coding sessions, distills them, and serves them back through these tools. Delivery is pull-only: nothing arrives unless you call a tool.

Call search_knowledge BEFORE answering a question about what you have worked on, decided, tried, or figured out before — trigger phrases: "did I…", "have I…", "what's the status of…", "how did I do X", "why did I choose…". Your past work routinely is not in the current repo or context; a file search that comes up empty is NOT evidence it never happened — check here first.

Call check_decision BEFORE any consequential or hard-to-reverse step — an architecture, library, schema, or API choice, a destructive command, scaffolding a new module — passing a plain-language statement of what you are about to do. Judge the returned candidates yourself: surface a genuine conflict to the human; if none genuinely conflicts, say nothing about the check.

At the start of substantive work on a topic, one get_standing_decisions call is a cheap way to reload your own recent rulings.

ratify_decision WRITES to your decision record and requires the human's explicit in-session confirmation quoted verbatim — never call it on your own initiative.

Treat an empty result or a tool error as "unknown" — never as "no record" or "no conflict". If a call fails, say so rather than answering as if it succeeded.`;
