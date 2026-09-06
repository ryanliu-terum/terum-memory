import { afterEach, describe, expect, it, vi } from "vitest";
import { createEndpointBackend } from "../adapters/openai-compatible.js";

const req = { prompt: "Extract this", schema: { type: "object", properties: { answer: { type: "string" } } }, timeoutMs: 1000 };
const completion = (content: unknown = '{"answer":"ok"}') => new Response(JSON.stringify({ choices: [{ message: { content } }] }));
afterEach(() => { vi.unstubAllEnvs(); });

describe("OpenAI-compatible endpoint", () => {
  it("joins URL, resolves auth at call time, supplies schema and timeout", async () => {
    const fake = vi.fn<typeof fetch>().mockResolvedValue(completion());
    const backend = createEndpointBackend({ baseUrl: "https://example.test/v1///", model: "test-model", apiKeyEnv: "TEST_ENDPOINT_KEY", fetchImpl: fake });
    vi.stubEnv("TEST_ENDPOINT_KEY", "a-private-key");
    expect(backend.modelId).toBe("test-model");
    expect(await backend.completeJSON(req)).toBe('{"answer":"ok"}');
    const [url, init] = fake.mock.calls[0]!;
    expect(url).toBe("https://example.test/v1/chat/completions");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer a-private-key");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init?.body))).toEqual({ model: "test-model", messages: [{ role: "user", content: req.prompt }], response_format: { type: "json_schema", json_schema: { name: "distill", strict: true, schema: req.schema } } });
    vi.stubEnv("TEST_ENDPOINT_KEY", "rotated-key");
    fake.mockResolvedValueOnce(completion());
    await backend.completeJSON(req);
    expect(new Headers(fake.mock.calls[1]![1]?.headers).get("authorization")).toBe("Bearer rotated-key");
    vi.stubEnv("TEST_ENDPOINT_KEY", undefined);
    await expect(backend.completeJSON(req)).rejects.toThrow("TEST_ENDPOINT_KEY");
    expect(fake).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, "", "  "])("fails closed on missing/empty credentials: %s", async (value) => {
    vi.stubEnv("TEST_ENDPOINT_KEY", value);
    const fake = vi.fn<typeof fetch>();
    const backend = createEndpointBackend({ baseUrl: "https://example.test", model: "m", apiKeyEnv: "TEST_ENDPOINT_KEY", fetchImpl: fake });
    await expect(backend.completeJSON(req)).rejects.toThrow("TEST_ENDPOINT_KEY");
    expect(fake).not.toHaveBeenCalled();
  });

  it("omits authorization for anonymous local endpoints", async () => {
    const fake = vi.fn<typeof fetch>().mockResolvedValue(completion());
    await createEndpointBackend({ baseUrl: "http://localhost/v1", model: "m", fetchImpl: fake }).completeJSON(req);
    expect(new Headers(fake.mock.calls[0]![1]?.headers).has("authorization")).toBe(false);
  });

  it.each(["response_format", "json_schema"])("falls back once on a 400 %s complaint within one deadline", async (complaint) => {
    const fake = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(complaint, { status: 400 })).mockResolvedValueOnce(completion());
    await expect(createEndpointBackend({ baseUrl: "https://example.test/v1", model: "m", fetchImpl: fake }).completeJSON(req)).resolves.toContain("answer");
    expect(fake).toHaveBeenCalledTimes(2);
    const first = fake.mock.calls[0]![1]!;
    const second = fake.mock.calls[1]![1]!;
    expect(JSON.parse(String(first.body))).toHaveProperty("response_format");
    expect(JSON.parse(String(second.body))).not.toHaveProperty("response_format");
    expect(second.signal).toBe(first.signal);
  });

  it.each([400, 401, 403, 429, 500, 503])("surfaces HTTP %s with bounded, redacted diagnostics and no retry", async (status) => {
    vi.stubEnv("TEST_ENDPOINT_KEY", "highly-secret-token");
    const fake = vi.fn<typeof fetch>().mockResolvedValue(new Response('highly-secret-token Authorization: Bearer highly-secret-token\n' + "x".repeat(2000), { status }));
    const backend = createEndpointBackend({ baseUrl: "https://example.test", model: "m", apiKeyEnv: "TEST_ENDPOINT_KEY", fetchImpl: fake });
    const error = await backend.completeJSON(req).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain(`HTTP ${status}`);
    expect(String(error)).not.toMatch(/highly-secret-token|Authorization|Bearer/);
    expect(String(error).length).toBeLessThan(600);
    expect(fake).toHaveBeenCalledTimes(1);
  });

  it("does not retry the fallback request again", async () => {
    const fake = vi.fn<typeof fetch>().mockImplementation(async () => new Response("json_schema unsupported", { status: 400 }));
    await expect(createEndpointBackend({ baseUrl: "https://example.test", model: "m", fetchImpl: fake }).completeJSON(req)).rejects.toThrow("HTTP 400");
    expect(fake).toHaveBeenCalledTimes(2);
  });

  it.each([null, "", " \n", 12, { answer: "not text" }])("rejects absent/nontext content: %#", async (content) => {
    const fake = vi.fn<typeof fetch>().mockResolvedValue(completion(content));
    await expect(createEndpointBackend({ baseUrl: "https://example.test", model: "m", fetchImpl: fake }).completeJSON(req)).rejects.toThrow("empty message content");
  });

  it.each(["{}", "null", '{"choices":[]}', '{"choices":[{}]}', '{"choices":[null]}'])("rejects missing result fields: %s", async (body) => {
    const fake = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    await expect(createEndpointBackend({ baseUrl: "https://example.test", model: "m", fetchImpl: fake }).completeJSON(req)).rejects.toThrow("empty message content");
  });

  it("does not expose malformed response or transport error contents", async () => {
    const fake = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("secret raw response")).mockRejectedValueOnce(new Error("secret raw transport"));
    const backend = createEndpointBackend({ baseUrl: "https://example.test", model: "m", fetchImpl: fake });
    await expect(backend.completeJSON(req)).rejects.toThrow("Endpoint returned invalid JSON");
    await expect(backend.completeJSON(req)).rejects.toThrow("Endpoint request failed (transport or response body)");
  });

  it("actually aborts a hanging fetch", async () => {
    let signal: AbortSignal | null | undefined;
    const fake = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      signal = init?.signal;
      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
    }));
    await expect(createEndpointBackend({ baseUrl: "https://example.test", model: "m", fetchImpl: fake }).completeJSON({ ...req, timeoutMs: 15 })).rejects.toThrow("timed out");
    expect(signal?.aborted).toBe(true);
    expect(fake).toHaveBeenCalledTimes(1);
  });
});
