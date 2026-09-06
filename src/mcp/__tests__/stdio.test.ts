import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openDb, setMeta, type Db } from "../../db/open.js";
import { createLocalEmbedder } from "../../engine/embedder.js";
import { manifestFor } from "../../engine/models.js";
import { loadConfig } from "../../llm/config.js";
import { backendFromConfig } from "../../llm/probe.js";

vi.mock("../../db/open.js", async importOriginal => {
  const original = await importOriginal<typeof import("../../db/open.js")>();
  return { ...original, openDb: vi.fn(original.openDb) };
});
vi.mock("../../engine/embedder.js", () => ({ createLocalEmbedder: vi.fn() }));
vi.mock("../../engine/models.js", () => ({ manifestFor: vi.fn() }));
vi.mock("../../llm/config.js", () => ({ loadConfig: vi.fn() }));
vi.mock("../../llm/probe.js", () => ({ backendFromConfig: vi.fn() }));

let db: Db;
let dir: string;
let previousExitCode: typeof process.exitCode;
beforeEach(async () => {
  previousExitCode = process.exitCode;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-stdio-"));
  const original = await vi.importActual<typeof import("../../db/open.js")>("../../db/open.js");
  db = original.openDb({ dbPath: path.join(dir, "memory.db"), warn: () => undefined });
  vi.mocked(openDb).mockReturnValue(db);
  vi.mocked(loadConfig).mockReturnValue({ chat: { backend: "claude" } });
  vi.mocked(backendFromConfig).mockReturnValue({ modelId: "fake", completeJSON: vi.fn() });
  vi.mocked(createLocalEmbedder).mockResolvedValue({ id: "fake", dim: 3, embed: vi.fn() });
  vi.mocked(manifestFor).mockReturnValue({ id: "fake", dim: 3, hfRepo: "test/fake",
    revision: "test", sha256: "test", onnxFile: "model.onnx", pooling: "mean",
    l2Normalize: true, maxTokens: 10, truncation: "tail", prefixes: null });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  process.exitCode = previousExitCode;
  vi.restoreAllMocks();
  vi.mocked(openDb).mockReset();
  if (db.open) db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

it("smoke-imports without opening a database, building models, connecting, or writing stdout", async () => {
  vi.clearAllMocks();
  const connect = vi.spyOn(McpServer.prototype, "connect");
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const module = await import("../stdio.js");
  const writes = stdout.mock.calls.length;
  stdout.mockRestore();
  expect(typeof module.runStdioServer).toBe("function");
  expect(openDb).not.toHaveBeenCalled();
  expect(loadConfig).not.toHaveBeenCalled();
  expect(createLocalEmbedder).not.toHaveBeenCalled();
  expect(connect).not.toHaveBeenCalled();
  expect(writes).toBe(0);
});

it.each(["embedder", "config"])("fails with an init diagnostic for missing %s and closes the db", async missing => {
  if (missing === "config") {
    db.transaction(() => setMeta(db, "embedder_id", "fake"))();
    vi.mocked(loadConfig).mockReturnValue({});
  }
  const connect = vi.spyOn(McpServer.prototype, "connect");
  const { runStdioServer } = await import("../stdio.js");
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  await runStdioServer();
  const writes = stdout.mock.calls.length;
  stdout.mockRestore();
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining("run `terum-memory init` first"));
  expect(process.exitCode).toBe(1);
  expect(db.open).toBe(false);
  expect(connect).not.toHaveBeenCalled();
  expect(writes).toBe(0);
});

it("builds dependencies from persisted settings and connects only when invoked", async () => {
  db.transaction(() => setMeta(db, "embedder_id", "fake"))();
  const connect = vi.spyOn(McpServer.prototype, "connect").mockResolvedValue();
  const { runStdioServer } = await import("../stdio.js");
  await runStdioServer();
  expect(manifestFor).toHaveBeenLastCalledWith("fake");
  expect(createLocalEmbedder).toHaveBeenLastCalledWith(vi.mocked(manifestFor).mock.results.at(-1)!.value);
  expect(backendFromConfig).toHaveBeenLastCalledWith({ backend: "claude" });
  expect(connect).toHaveBeenCalledExactlyOnceWith(expect.any(StdioServerTransport));
  expect(db.open).toBe(true);
  const server = connect.mock.contexts[0] as McpServer;
  server.server.onclose?.();
  expect(db.open).toBe(false);
});

it("reports connection failures on stderr and closes the database", async () => {
  db.transaction(() => setMeta(db, "embedder_id", "fake"))();
  vi.spyOn(McpServer.prototype, "connect").mockRejectedValue(new Error("transport unavailable"));
  const { runStdioServer } = await import("../stdio.js");
  await runStdioServer();
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining("transport unavailable"));
  expect(process.exitCode).toBe(1);
  expect(db.open).toBe(false);
});
