import type { ChatBackend } from "../backend.js";
import { ENDPOINT_TIMEOUT_MS } from "../defaults.js";

export interface EndpointOptions {
  baseUrl: string;
  model: string;
  apiKeyEnv?: string;
  fetchImpl?: typeof fetch;
}

/** Redact before truncation so a cut through a credential cannot expose a prefix. */
export function safeExcerpt(text: string, secrets: string[] = []): string {
  let safe = text;
  for (const secret of secrets) {
    if (secret) {
      safe = safe.split(secret).join("[redacted]");
      const escaped = JSON.stringify(secret).slice(1, -1);
      if (escaped !== secret) safe = safe.split(escaped).join("[redacted]");
    }
  }
  return safe.replace(/authorization[^\r\n]*/gi, "[redacted header]")
    .replace(/bearer\s+[^\s"']+/gi, "[redacted credential]")
    .replace(/[\r\n]+/g, " ").slice(0, 512);
}

/** Internal plain-text path also used by the one-request init probe. */
export async function requestEndpoint(opts: {
  baseUrl: string;
  model: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  prompt: string;
  schema?: Record<string, unknown>;
  timeoutMs: number;
}): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
  // Share a deadline with the format fallback, including response-body reads.
  const signal = AbortSignal.timeout(opts.timeoutMs);
  let schema = opts.schema;
  for (let attempt = 0; attempt < 2; attempt++) {
    let response: Response;
    let body: string;
    try {
      response = await fetchImpl(`${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers,
        signal,
        body: JSON.stringify({
          model: opts.model,
          messages: [{ role: "user", content: opts.prompt }],
          ...(schema === undefined ? {} : {
            response_format: { type: "json_schema", json_schema: { name: "distill", strict: true, schema } },
          }),
        }),
      });
      body = await response.text();
    } catch {
      throw new Error(signal.aborted ? "Endpoint request timed out" : "Endpoint request failed (transport or response body)");
    }
    if (!response.ok) {
      if (attempt === 0 && schema !== undefined && response.status === 400 && /response_format|json_schema/i.test(body)) {
        schema = undefined;
        continue;
      }
      throw new Error(`Endpoint HTTP ${response.status}: ${safeExcerpt(body, [opts.apiKey ?? ""])}`);
    }
    let result: { choices?: { message?: { content?: unknown } }[] } | null;
    try {
      result = JSON.parse(body) as typeof result;
    } catch {
      throw new Error("Endpoint returned invalid JSON");
    }
    const content = result?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new Error("Endpoint returned missing or empty message content");
    return content;
  }
  throw new Error("Endpoint schema fallback exhausted");
}

export function createEndpointBackend(opts: EndpointOptions): ChatBackend {
  return {
    modelId: opts.model,
    completeJSON({ prompt, schema, timeoutMs }) {
      // Resolve at call time: rotation and removal take effect on an existing backend.
      const apiKey = opts.apiKeyEnv === undefined ? undefined : process.env[opts.apiKeyEnv];
      if (opts.apiKeyEnv !== undefined && !apiKey?.trim()) {
        return Promise.reject(new Error(`Missing API key environment variable: ${opts.apiKeyEnv}`));
      }
      return requestEndpoint({ ...opts, apiKey, prompt, schema, timeoutMs: timeoutMs ?? ENDPOINT_TIMEOUT_MS });
    },
  };
}
