import { createVecTables, getMeta, setMeta } from "../../db/open.js";
import { command, config, parse, UsageError, type CommandDeps } from "./shared.js";
export interface InitDeps extends CommandDeps {
  manifestFor?: typeof import("../../engine/models.js").manifestFor;
  ensureModelInstalled?: typeof import("../../engine/model-install.js").ensureModelInstalled;
  probeChatBackends?: typeof import("../../llm/probe.js").probeChatBackends;
  saveConfig?: typeof import("../../llm/config.js").saveConfig;
}
export async function run(args: string[], deps: InitDeps = {}): Promise<number> {
  return command(deps, "init [--model ID | --low-resource]", async (db, out) => {
    const { values } = parse(args, { "--model": "value", "--low-resource": "boolean" });
    if (values["--model"] !== undefined && values["--low-resource"] !== undefined) {
      throw new UsageError("--model and --low-resource are mutually exclusive");
    }
    // --low-resource selects the ~25 MB fallback embedder for constrained machines.
    const requested = values["--low-resource"] ? "all-MiniLM-L6-v2" : values["--model"] as string | undefined;
    const locked = getMeta(db, "embedder_id");
    if (locked) {
      out(`Embedder locked: ${locked}; backend: ${(await config(deps)).chat?.backend ?? "off (capture-only mode)"}`);
      return 0;
    }
    let manifest;
    try { manifest = (deps.manifestFor ?? (await import("../../engine/models.js")).manifestFor)(requested ?? "nomic-embed-text-v1"); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("unmeasured placeholder")) throw error;
      out(`No calibrated embedder pinned yet: ${message}. Database created; capture remains available.`);
      return 1;
    }
    await (deps.ensureModelInstalled ?? (await import("../../engine/model-install.js")).ensureModelInstalled)(manifest);
    db.transaction(() => {
      // Installation is outside the write transaction; another init may finish first.
      if (getMeta(db, "embedder_id")) return;
      createVecTables(db, manifest.dim);
      setMeta(db, "embedder_id", manifest.id);
      setMeta(db, "embedder_dim", String(manifest.dim));
      setMeta(db, "embedder_locked_at", new Date().toISOString());
    }).immediate();
    const probed = await (deps.probeChatBackends ?? (await import("../../llm/probe.js")).probeChatBackends)();
    (deps.saveConfig ?? (await import("../../llm/config.js")).saveConfig)(probed.config ? { chat: probed.config } : {});
    for (const line of probed.transcript) out(line);
    out(`Embedder locked: ${getMeta(db, "embedder_id")}; backend: ${probed.config?.backend ?? "off (capture-only mode)"}`);
    return 0;
  });
}
