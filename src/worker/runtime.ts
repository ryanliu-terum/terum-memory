import { getMeta, type Db } from "../db/open.js";
import type { Runtime } from "./dispatch.js";

export class RuntimeUnavailable extends Error {
  constructor(reason: string, cause?: unknown) { super(reason, { cause }); }
}
export interface RuntimeOptions {
  loadConfig?: typeof import("../llm/config.js").loadConfig;
  manifestFor?: typeof import("../engine/models.js").manifestFor;
  createEmbedder?: typeof import("../engine/embedder.js").createLocalEmbedder;
  backendFromConfig?: typeof import("../llm/probe.js").backendFromConfig;
}
const runtimes = new WeakMap<Db, Promise<Runtime>>();

/** Local inference initialization is asynchronous; share one build per connection. */
export function buildRuntime(db: Db, opts: RuntimeOptions = {}): Promise<Runtime> {
  const cached = runtimes.get(db);
  if (cached) return cached;
  const building = (async (): Promise<Runtime> => {
    try {
      const id = getMeta(db, "embedder_id");
      if (!id?.trim()) throw new Error("database not initialized: no embedder_id; run terum-memory init");
      const chat = (opts.loadConfig ?? (await import("../llm/config.js")).loadConfig)().chat;
      if (!chat) throw new Error("capture-only mode: no chat backend configured");
      const manifest = (opts.manifestFor ?? (await import("../engine/models.js")).manifestFor)(id);
      const backend = (opts.backendFromConfig ?? (await import("../llm/probe.js")).backendFromConfig)(chat);
      const embedder = await (opts.createEmbedder ?? (await import("../engine/embedder.js")).createLocalEmbedder)(manifest);
      return { backend, embedder };
    } catch (error) {
      throw new RuntimeUnavailable(error instanceof Error ? error.message : String(error), error);
    }
  })();
  runtimes.set(db, building);
  return building;
}
