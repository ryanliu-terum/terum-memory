import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { expect, it, vi } from "vitest";
// The shipped local embedders are measured; an unmeasured id is simulated through the
// module seam so the "no fallback constants" contract stays under test.
vi.mock("../../engine/thresholds.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../engine/thresholds.js")>();
  return { ...actual, thresholdsFor: (id: string) => {
    if (id === "unmeasured-fixture") throw new Error('no measured thresholds for embedder "unmeasured-fixture" (fixture)');
    return actual.thresholdsFor(id);
  } };
});
import { z } from "zod";
import { setMeta, type Db } from "../../db/open.js";
import { axis, fixture, NOW, rows, seed } from "../../decisions/__tests__/helpers.js";
import { TERUM_MCP_INSTRUCTIONS } from "../instructions.js";
import { createMcpServer } from "../server.js";
import { TOOL_HANDLERS as handlers, TOOL_INPUT_SCHEMAS as schemas } from "../tools.js";

const names = ["check_decision", "search_knowledge", "get_standing_decisions", "ratify_decision"];
function setup() {
  const f = fixture();
  return { ...f, deps: { ...f.deps, db: f.db } };
}
function text(result: CallToolResult): string {
  expect(result.content).toHaveLength(1);
  const content = result.content[0]!;
  if (content.type !== "text") throw new Error("Expected text result");
  return content.text;
}
function note(db: Db, id: string): void {
  db.transaction(() => {
    db.prepare(`INSERT INTO notes (id, site, conversation_id, turn_count, topic, summary,
      compacted_text, model_used, first_captured_at, last_captured_at, distilled_at)
      VALUES (?, 'test', ?, 1, 'storage', ?, ?, 'fake', ?, ?, ?)`)
      .run(id, id, `Summary ${id}`, `Note ${id}`, NOW, NOW, NOW);
    db.prepare("INSERT INTO note_vec (note_id, embedding) VALUES (?, ?)").run(id, axis);
  })();
}

it("provides local, trigger-led instructions naming all four tools within budget", () => {
  for (const name of names) expect(TERUM_MCP_INSTRUCTIONS).toContain(name);
  expect(TERUM_MCP_INSTRUCTIONS).toContain("did I");
  expect(TERUM_MCP_INSTRUCTIONS).toContain("check_decision BEFORE");
  expect(TERUM_MCP_INSTRUCTIONS).toContain("local");
  expect(TERUM_MCP_INSTRUCTIONS).not.toMatch(/team/i);
  expect(TERUM_MCP_INSTRUCTIONS.length).toBeLessThan(2000);
});

it("registers exactly the four tools and supplies package identity and handshake instructions", async () => {
  const f = setup();
  const register = vi.spyOn(McpServer.prototype, "registerTool");
  const server = createMcpServer(f.deps);
  expect(server).toBeInstanceOf(McpServer);
  expect(register.mock.calls.map(call => call[0])).toEqual(names);
  expect(Object.keys(handlers)).toEqual(names);
  expect(register.mock.calls.map(call => call[0])).not.toContain("record_override");
  expect(register.mock.calls.map(call => call[0])).not.toContain("record_decision");
  // SDK has no public identity getter; inspect stored handshake metadata only.
  const underlying = server.server as unknown as { _serverInfo: unknown; _instructions: string };
  const pkg = createRequire(import.meta.url)("../../../package.json") as { version: string };
  expect(underlying._serverInfo).toEqual({ name: "terum-memory", version: pkg.version });
  expect(underlying._instructions).toBe(TERUM_MCP_INSTRUCTIONS);
  expect(server.isConnected()).toBe(false);
  await server.close();
});

it.each([
  [{ statement: "Keep SQLite local" }, "Keep SQLite local"],
  [{ action: "Use local SQLite" }, "Use local SQLite"],
  [{ decision: "Choose SQLite" }, "Choose SQLite"],
  [{ statement: "  \n", action: "\t", decision: "Fallback decision" }, "Fallback decision"],
  [{ statement: "Primary", action: "Secondary", decision: "Third" }, "Primary"],
  [{ action: "Secondary", decision: "Third" }, "Secondary"],
])("normalizes check aliases and returns candidates: %j", async (args, expected) => {
  const f = setup();
  const id = seed(f.db, { text: "Keep SQLite storage local" });
  const result = await handlers.check_decision(args, f.deps);
  expect(result.isError).not.toBe(true);
  expect(JSON.parse(text(result)).candidates).toEqual([
    expect.objectContaining({ decision_id: id, decision_text: "Keep SQLite storage local", similarity: 1 }),
  ]);
  expect(f.embed).toHaveBeenCalledExactlyOnceWith([expected], "query");
  expect(rows(f.db, "receipts")).toMatchObject([{ statement: expected }]);
});

it.each([{}, { statement: " \n", action: "\t", decision: "" }, { query: "unrecognized" }])(
  "reports that a check with no recognized nonblank input did not run: %j", async args => {
    const f = setup();
    const parsed = z.object(schemas.check_decision).parse(args);
    const result = await handlers.check_decision(parsed, f.deps);
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/did NOT run.*Retry.*statement/);
    expect(f.embed).not.toHaveBeenCalled();
    expect(rows(f.db, "receipts")).toEqual([]);
  },
);

it("surfaces check embedding failure without recording a successful check", async () => {
  const f = setup();
  seed(f.db);
  f.embed.mockRejectedValueOnce(new Error("offline"));
  const result = await handlers.check_decision({ statement: "Use SQLite" }, f.deps);
  expect(result.isError).toBe(true);
  expect(JSON.parse(text(result))).toEqual({ candidates: [], error: "embedding failed" });
  expect(rows(f.db, "receipts")).toEqual([]);
});

it("surfaces unmeasured thresholds without substituting constants", async () => {
  const f = setup();
  f.db.transaction(() => setMeta(f.db, "embedder_id", "unmeasured-fixture"))();
  const result = await handlers.check_decision({ statement: "Use SQLite" }, f.deps);
  expect(result.isError).toBe(true);
  expect(text(result)).toContain("no measured thresholds");
  expect(rows(f.db, "receipts")).toEqual([]);
});

it.each([[undefined, 20], [1, 1], [50, 50], [100, 50]])(
  "returns structured notes and preserves engine limit clamping (%s -> %s)", async (limit, count) => {
    const f = setup();
    for (let i = 0; i < 55; i++) note(f.db, `n${String(i).padStart(2, "0")}`);
    const result = await handlers.search_knowledge({ query: "storage", limit }, f.deps);
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(text(result));
    expect(payload.results).toHaveLength(count!);
    expect(payload.results[0]).toMatchObject({ id: "n00", kind: "note", topic: "storage",
      summary: "Summary n00", text: "Note n00", similarity: 1 });
  },
);

it.each([0, 51, -1, 1.5, NaN, Infinity, "2", null])("rejects invalid MCP limits: %s", limit => {
  expect(z.object(schemas.search_knowledge).safeParse({ query: "storage", limit }).success).toBe(false);
  expect(z.object(schemas.get_standing_decisions).safeParse({ limit }).success).toBe(false);
});

it("renders an empty search as a non-error empty result", async () => {
  const f = setup();
  const result = await handlers.search_knowledge({ query: "nothing yet" }, f.deps);
  expect(result.isError).not.toBe(true);
  expect(JSON.parse(text(result))).toEqual({ results: [] });
});

it("renders search and standing embedding errors explicitly", async () => {
  const f = setup();
  f.embed.mockRejectedValue(new Error("offline"));
  const search = await handlers.search_knowledge({ query: "storage" }, f.deps);
  const standing = await handlers.get_standing_decisions({ topic: "storage" }, f.deps);
  for (const result of [search, standing]) {
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("embedding failed");
  }
});

it("lists recent decisions first and uses semantic topic filtering before limiting", async () => {
  const f = setup();
  const old = seed(f.db, { decidedAt: "2025-01-01", text: "Keep storage local" });
  const recent = seed(f.db, { decidedAt: "2026-01-01", text: "Use SQLite" });
  const unrelated = seed(f.db, { decidedAt: "2026-02-01", embedding: new Float32Array([-1, 0, 0]) });
  const all = await handlers.get_standing_decisions({}, f.deps);
  expect(JSON.parse(text(all)).decisions.map((row: { decision_id: string }) => row.decision_id))
    .toEqual([unrelated, recent, old]);
  expect(f.embed).not.toHaveBeenCalled();
  const filtered = await handlers.get_standing_decisions({ topic: "storage", limit: 1 }, f.deps);
  expect(filtered.isError).not.toBe(true);
  expect(JSON.parse(text(filtered)).decisions).toEqual([expect.objectContaining({ decision_id: recent,
    decision_text: "Use SQLite", topic: "storage", provenance: "ratified", decided_at: "2026-01-01" })]);
  expect(f.embed).toHaveBeenCalledExactlyOnceWith(["storage"], "query");
});

it.each([{}, { human_confirmed: false, human_confirmation_quote: "yes" },
  { human_confirmed: true }, { human_confirmed: true, human_confirmation_quote: " \n" }])(
  "preserves the authoritative ratification gate and writes nothing: %j", async confirmation => {
    const f = setup();
    const result = await handlers.ratify_decision({ decision_text: "Use SQLite", ...confirmation }, f.deps);
    expect(result.isError).toBe(true);
    expect(JSON.parse(text(result))).toEqual({ ok: false,
      error: "ratify_decision requires an explicit human confirmation and non-blank verbatim quote" });
    expect(rows(f.db, "decisions")).toEqual([]);
    expect(rows(f.db, "decision_vec")).toEqual([]);
    expect(f.embed).not.toHaveBeenCalled();
    expect(f.completeJSON).not.toHaveBeenCalled();
  },
);

it("writes a confirmed ratified decision and returns its database id", async () => {
  const f = setup();
  const result = await handlers.ratify_decision({ decision_text: "Use SQLite", reason: "Local storage",
    topic: "storage", human_confirmed: true, human_confirmation_quote: "Yes, let's use SQLite." }, f.deps);
  expect(result.isError).not.toBe(true);
  const payload = JSON.parse(text(result));
  expect(payload).toEqual({ ok: true, decisionId: expect.any(String), merged: false });
  expect(rows(f.db, "decisions")).toMatchObject([{ id: payload.decisionId, decision_text: "Use SQLite",
    reason: "Local storage", topic: "storage", provenance: "ratified", human_quote: "Yes, let's use SQLite." }]);
  expect(rows(f.db, "decision_vec")).toHaveLength(1);
});

it.each(["", " \t\n", "\u2003"])("rejects blank ratification text: %j", async decision_text => {
  const f = setup();
  const args = { decision_text, human_confirmed: true, human_confirmation_quote: "yes" };
  expect(z.object(schemas.ratify_decision).safeParse(args).success).toBe(false);
  expect((await handlers.ratify_decision(args, f.deps)).isError).toBe(true);
  expect(rows(f.db, "decisions")).toEqual([]);
});

it("does not write stdout during construction or a registered handler call", async () => {
  const f = setup();
  seed(f.db);
  const register = vi.spyOn(McpServer.prototype, "registerTool");
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const server = createMcpServer(f.deps);
  // Invoke the actual registered callback without attaching any transport.
  const callback = register.mock.calls[0]![2] as (args: { statement: string }) => Promise<CallToolResult>;
  const result = await callback({ statement: "Use SQLite" });
  const writes = stdout.mock.calls.length;
  stdout.mockRestore();
  expect(result.isError).not.toBe(true);
  expect(writes).toBe(0);
  await server.close();
});
