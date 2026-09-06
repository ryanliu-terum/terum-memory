import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getMeta, openDb, type Db } from "../db/open.js";
import { createLocalEmbedder } from "../engine/embedder.js";
import { manifestFor } from "../engine/models.js";
import { loadConfig } from "../llm/config.js";
import { backendFromConfig } from "../llm/probe.js";
import { createMcpServer } from "./server.js";

export async function runStdioServer(): Promise<void> {
  let db: Db | undefined;
  let server: ReturnType<typeof createMcpServer> | undefined;
  try {
    db = openDb();
    const id = getMeta(db, "embedder_id");
    const chat = loadConfig().chat;
    if (!id?.trim() || !chat) {
      throw new Error("Local memory is not initialized (missing embedder_id or chat config); run `terum-memory init` first.");
    }
    const backend = backendFromConfig(chat);
    const embedder = await createLocalEmbedder(manifestFor(id));
    server = createMcpServer({ db, embedder, backend });
    const openedDb = db;
    server.server.onclose = () => { if (openedDb.open) openedDb.close(); };
    server.server.onerror = error => console.error(`terum-memory MCP: ${error.message}`);
    await server.connect(new StdioServerTransport());
  } catch (error) {
    console.error(`terum-memory MCP startup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    try {
      if (server) await server.close();
    } finally {
      if (db?.open) db.close();
    }
  }
}
