import fs from "node:fs";
import path from "node:path";
import type { ChatBackend } from "./backend.js";
import type { ChatConfig } from "./config.js";
import { createAgentCliBackend, type AgentBinary } from "./adapters/agent-cli.js";
import { createEndpointBackend, requestEndpoint, safeExcerpt } from "./adapters/openai-compatible.js";
import { ENDPOINT_TIMEOUT_MS, OLLAMA_BASE_URL, OLLAMA_MODEL_PREFERENCE, OPENAI_DEFAULT_BASE_URL, OPENAI_DEFAULT_MODEL } from "./defaults.js";

export interface ProbeOptions {
  fetchImpl?: typeof fetch;
  /** Entire availability check: false = absent, true = no-op succeeded, throw = failed. */
  binaryProbe?: (binary: AgentBinary) => boolean | Promise<boolean>;
  env?: NodeJS.ProcessEnv;
}

function findBinary(binary: AgentBinary, env: NodeJS.ProcessEnv): string | undefined {
  const extensions = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = path.resolve(dir, `${binary}${extension}`);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "EACCES") {
          throw new Error(`Could not inspect PATH for ${binary}`);
        }
      }
    }
  }
  return undefined;
}

export async function probeChatBackends(opts: ProbeOptions = {}): Promise<{
  config: ChatConfig | null;
  transcript: string[];
}> {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const transcript: string[] = [];
  const reason = (error: unknown): string => safeExcerpt(error instanceof Error ? error.message : "unknown failure", [env.OPENAI_API_KEY ?? ""]);
  const probeEndpoint = (baseUrl: string, model: string, apiKey?: string) => requestEndpoint({
    baseUrl, model, apiKey, fetchImpl, prompt: "Reply: OK", timeoutMs: ENDPOINT_TIMEOUT_MS,
  });
  if (env.OPENAI_API_KEY?.trim()) {
    try {
      await probeEndpoint(OPENAI_DEFAULT_BASE_URL, OPENAI_DEFAULT_MODEL, env.OPENAI_API_KEY);
      transcript.push("OpenAI: found (completion succeeded)");
      return { config: { backend: "openai-compatible", base_url: OPENAI_DEFAULT_BASE_URL, model: OPENAI_DEFAULT_MODEL, api_key_env: "OPENAI_API_KEY" }, transcript };
    } catch (error) {
      transcript.push(`OpenAI: failed: ${reason(error)}`);
    }
  } else transcript.push("OpenAI: not found (OPENAI_API_KEY is not set)");

  try {
    const response = await fetchImpl(`${OLLAMA_BASE_URL.replace(/\/v1$/, "")}/api/tags`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`model listing HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !("models" in body) || !Array.isArray(body.models)) {
      throw new Error("invalid model listing");
    }
    const models = body.models.map((model: unknown) => {
      if (typeof model !== "object" || model === null || !("name" in model) || typeof model.name !== "string" || !model.name.trim()) {
        throw new Error("invalid model name in listing");
      }
      return model.name;
    });
    const model = OLLAMA_MODEL_PREFERENCE.map((prefix) => models.find((name) => name.startsWith(prefix))).find(Boolean) ?? models[0];
    if (!model) transcript.push("Ollama: not found (no installed models)");
    else {
      await probeEndpoint(OLLAMA_BASE_URL, model);
      transcript.push(`Ollama: found (${safeExcerpt(model, [env.OPENAI_API_KEY ?? ""])})`);
      return { config: { backend: "ollama", base_url: OLLAMA_BASE_URL, model }, transcript };
    }
  } catch (error) {
    transcript.push(`Ollama: failed: ${reason(error)}`);
  }

  const binaryProbe = opts.binaryProbe ?? (async (binary: AgentBinary): Promise<boolean> => {
    const binaryPath = findBinary(binary, env);
    if (!binaryPath) return false;
    await createAgentCliBackend({ binary, binaryPath }).completeJSON({ prompt: "Reply: OK", schema: {}, timeoutMs: 30_000 });
    return true;
  });
  for (const binary of ["claude", "codex", "gemini"] as const) {
    try {
      if (await binaryProbe(binary)) {
        transcript.push(`${binary}: found (no-op succeeded)`);
        return { config: { backend: binary }, transcript };
      }
      transcript.push(`${binary}: not found on PATH`);
    } catch (error) {
      transcript.push(`${binary}: failed: ${reason(error)}`);
    }
  }
  return { config: null, transcript };
}

export function backendFromConfig(config: ChatConfig, opts: { fetchImpl?: typeof fetch; binaryPath?: string; killGraceMs?: number; outputCapBytes?: number } = {}): ChatBackend {
  switch (config.backend) {
    case "openai-compatible":
      return createEndpointBackend({ baseUrl: config.base_url ?? OPENAI_DEFAULT_BASE_URL, model: config.model ?? OPENAI_DEFAULT_MODEL, apiKeyEnv: config.api_key_env, fetchImpl: opts.fetchImpl });
    case "ollama":
      // A model requires discovery or explicit configuration; never guess an installed model.
      if (!config.model?.trim()) throw new Error("Ollama config requires a model");
      return createEndpointBackend({ baseUrl: config.base_url ?? OLLAMA_BASE_URL, model: config.model, apiKeyEnv: config.api_key_env, fetchImpl: opts.fetchImpl });
    case "claude":
    case "codex":
    case "gemini":
      return createAgentCliBackend({ ...opts, binary: config.backend });
    default:
      throw new Error("Unsupported chat backend in config");
  }
}
