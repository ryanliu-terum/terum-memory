import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TERUM_MCP_INSTRUCTIONS } from "./instructions.js";
import { TOOL_DESCRIPTIONS, TOOL_HANDLERS, TOOL_INPUT_SCHEMAS, type McpDeps } from "./tools.js";

// Works from both src/mcp and dist/mcp without JSON import-attribute requirements.
const { version } = createRequire(import.meta.url)("../../package.json") as { version: string };

export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: "terum-memory", version }, { instructions: TERUM_MCP_INSTRUCTIONS });
  server.registerTool("check_decision", {
    description: TOOL_DESCRIPTIONS.check_decision, inputSchema: TOOL_INPUT_SCHEMAS.check_decision,
  }, args => TOOL_HANDLERS.check_decision(args, deps));
  server.registerTool("search_knowledge", {
    description: TOOL_DESCRIPTIONS.search_knowledge, inputSchema: TOOL_INPUT_SCHEMAS.search_knowledge,
  }, args => TOOL_HANDLERS.search_knowledge(args, deps));
  server.registerTool("get_standing_decisions", {
    description: TOOL_DESCRIPTIONS.get_standing_decisions, inputSchema: TOOL_INPUT_SCHEMAS.get_standing_decisions,
  }, args => TOOL_HANDLERS.get_standing_decisions(args, deps));
  server.registerTool("ratify_decision", {
    description: TOOL_DESCRIPTIONS.ratify_decision, inputSchema: TOOL_INPUT_SCHEMAS.ratify_decision,
  }, args => TOOL_HANDLERS.ratify_decision(args, deps));
  return server;
}
