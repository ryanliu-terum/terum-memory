import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backendFromConfig, probeChatBackends } from "../probe.js";
import { OLLAMA_BASE_URL, OPENAI_DEFAULT_BASE_URL, OPENAI_DEFAULT_MODEL } from "../defaults.js";
import type { ChatConfig } from "../config.js";

const completion = () => new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }));
const unavailable = () => vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("probe ladder", () => {
  it("uses the injected env key for one plain-text OpenAI request and stops", async () => {
    vi.stubEnv("OPENAI_API_KEY", "different-process-key");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(completion());
    const binaryProbe = vi.fn().mockResolvedValue(false);
    const result = await probeChatBackends({ fetchImpl, binaryProbe, env: { OPENAI_API_KEY: "injected-secret" } });
    expect(result.config).toEqual({ backend: "openai-compatible", base_url: OPENAI_DEFAULT_BASE_URL, model: OPENAI_DEFAULT_MODEL, api_key_env: "OPENAI_API_KEY" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(binaryProbe).not.toHaveBeenCalled();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${OPENAI_DEFAULT_BASE_URL}/chat/completions`);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer injected-secret");
    expect(JSON.parse(String(init?.body))).toEqual({ model: OPENAI_DEFAULT_MODEL, messages: [{ role: "user", content: "Reply: OK" }] });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(result.transcript).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("injected-secret");
    expect(process.env.OPENAI_API_KEY).toBe("different-process-key");
  });

  it.each([
    [["other", "llama3.1:8b", "qwen3:4b", "llama3.3:70b"], "qwen3:4b"],
    [["llama3.1:8b", "mistral:latest", "llama3.3:70b"], "llama3.3:70b"],
    [["custom:latest", "another"], "custom:latest"],
  ] as const)("selects installed Ollama models by preference, else first: %#", async (names, chosen) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ models: names.map((name) => ({ name })) }))).mockResolvedValueOnce(completion());
    const binaryProbe = vi.fn().mockResolvedValue(false);
    const result = await probeChatBackends({ fetchImpl, binaryProbe, env: {} });
    expect(result.config).toEqual({ backend: "ollama", base_url: OLLAMA_BASE_URL, model: chosen });
    expect(result.transcript).toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]![0]).toBe("http://localhost:11434/api/tags");
    expect(fetchImpl.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);
    expect(fetchImpl.mock.calls[1]![0]).toBe(`${OLLAMA_BASE_URL}/chat/completions`);
    expect(JSON.parse(String(fetchImpl.mock.calls[1]![1]?.body)).model).toBe(chosen);
    expect(new Headers(fetchImpl.mock.calls[1]![1]?.headers).has("authorization")).toBe(false);
    expect(binaryProbe).not.toHaveBeenCalled();
  });

  it("returns capture-only with one transcript entry per rung", async () => {
    const binaryProbe = vi.fn().mockResolvedValue(false);
    const result = await probeChatBackends({ fetchImpl: unavailable(), binaryProbe, env: {} });
    expect(result.config).toBeNull();
    expect(result.transcript).toHaveLength(5);
    expect(binaryProbe.mock.calls).toEqual([["claude"], ["codex"], ["gemini"]]);
    expect(result.transcript.map((line) => line.split(":")[0])).toEqual(["OpenAI", "Ollama", "claude", "codex", "gemini"]);
  });

  it.each(["claude", "codex", "gemini"] as const)("stops after %s succeeds", async (binary) => {
    const binaryProbe = vi.fn(async (name: string) => name === binary);
    const result = await probeChatBackends({ fetchImpl: unavailable(), binaryProbe, env: {} });
    expect(result.config).toEqual({ backend: binary });
    expect(binaryProbe.mock.calls.map(([name]) => name)).toEqual(["claude", "codex", "gemini"].slice(0, ["claude", "codex", "gemini"].indexOf(binary) + 1));
  });

  it("continues after failed endpoint and CLI probes and redacts one-line reasons", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("injected-secret", { status: 401 })).mockResolvedValueOnce(new Response('{"models":[]}'));
    const binaryProbe = vi.fn().mockRejectedValueOnce(new Error("injected-secret\nnot logged in")).mockResolvedValueOnce(true);
    const result = await probeChatBackends({ fetchImpl, binaryProbe, env: { OPENAI_API_KEY: "injected-secret" } });
    expect(result.config).toEqual({ backend: "codex" });
    expect(result.transcript).toHaveLength(4);
    expect(result.transcript[0]).toContain("failed: Endpoint HTTP 401");
    expect(result.transcript[1]).toContain("no installed models");
    expect(result.transcript[2]).toContain("not logged in");
    expect(result.transcript.every((line) => !line.includes("\n") && !line.includes("injected-secret"))).toBe(true);
  });

  it.each([null, {}, { models: "wrong" }, { models: [null] }, { models: [{ name: "" }] }, { models: [{ name: 12 }] }])("surfaces malformed Ollama listings: %#", async (body) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify(body)));
    const result = await probeChatBackends({ fetchImpl, binaryProbe: () => false, env: {} });
    expect(result.config).toBeNull();
    expect(result.transcript[1]).toContain("Ollama: failed: invalid");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("falls through when an installed Ollama model cannot complete", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('{"models":[{"name":"qwen3"}]}')).mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    const result = await probeChatBackends({ fetchImpl, binaryProbe: () => true, env: {} });
    expect(result.config).toEqual({ backend: "claude" });
    expect(result.transcript[1]).toContain("failed: Endpoint HTTP 503");
  });

  it("uses process env and global fetch by default, with PATH isolated from real binaries", async () => {
    vi.stubEnv("OPENAI_API_KEY", undefined);
    vi.stubEnv("PATH", "");
    const fake = unavailable();
    vi.stubGlobal("fetch", fake);
    expect((await probeChatBackends()).config).toBeNull();
    expect(fake).toHaveBeenCalledTimes(1);
  });

  it.skipIf(process.platform === "win32")("requires both PATH presence and a successful no-op invocation", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "terum-probe-"));
    const marker = path.join(dir, "invocation.json");
    try {
      fs.writeFileSync(path.join(dir, "claude"), `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on('end', () => { process.stderr.write('not authenticated'); process.exitCode = 9; });`, { mode: 0o700 });
      fs.writeFileSync(path.join(dir, "codex"), `#!${process.execPath}\nlet input = ''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({input, args: process.argv.slice(2)})); process.stdout.write('OK'); });`, { mode: 0o700 });
      const result = await probeChatBackends({ fetchImpl: unavailable(), env: { PATH: dir } });
      expect(result.config).toEqual({ backend: "codex" });
      expect(result.transcript[2]).toContain("claude: failed:");
      expect(result.transcript[2]).toContain("not authenticated");
      expect(result.transcript).toHaveLength(4);
      expect(JSON.parse(fs.readFileSync(marker, "utf8"))).toEqual({ input: "Reply: OK\n\nReturn ONLY JSON matching this schema:\n{}", args: ["exec"] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("backendFromConfig", () => {
  it.each(["claude", "codex", "gemini"] as const)("constructs %s without probing or spawning", (backend) => {
    const fake = vi.fn<typeof fetch>();
    expect(backendFromConfig({ backend }, { fetchImpl: fake }).modelId).toBe(`${backend}-cli`);
    expect(fake).not.toHaveBeenCalled();
  });

  it.each(["openai-compatible", "ollama"] as const)("carries explicit %s endpoint fields through", async (backend) => {
    vi.stubEnv("CONFIG_ENDPOINT_KEY", "private-key");
    const fake = vi.fn<typeof fetch>().mockResolvedValueOnce(completion());
    const adapter = backendFromConfig({ backend, base_url: "http://example.test/custom/v1", model: "chosen", api_key_env: "CONFIG_ENDPOINT_KEY" }, { fetchImpl: fake });
    expect(adapter.modelId).toBe("chosen");
    await adapter.completeJSON({ prompt: "p", schema: {}, timeoutMs: 1000 });
    expect(fake.mock.calls[0]![0]).toBe("http://example.test/custom/v1/chat/completions");
    expect(new Headers(fake.mock.calls[0]![1]?.headers).get("authorization")).toBe("Bearer private-key");
    expect(JSON.parse(String(fake.mock.calls[0]![1]?.body)).model).toBe("chosen");
  });

  it("applies endpoint defaults and requires a known Ollama model", async () => {
    const fake = vi.fn<typeof fetch>().mockImplementation(async () => completion());
    const openai = backendFromConfig({ backend: "openai-compatible" }, { fetchImpl: fake });
    expect(openai.modelId).toBe(OPENAI_DEFAULT_MODEL);
    await openai.completeJSON({ prompt: "p", schema: {}, timeoutMs: 1000 });
    expect(fake.mock.calls[0]![0]).toBe(`${OPENAI_DEFAULT_BASE_URL}/chat/completions`);
    const ollama = backendFromConfig({ backend: "ollama", model: "installed" }, { fetchImpl: fake });
    await ollama.completeJSON({ prompt: "p", schema: {}, timeoutMs: 1000 });
    expect(fake.mock.calls[1]![0]).toBe(`${OLLAMA_BASE_URL}/chat/completions`);
    expect(() => backendFromConfig({ backend: "ollama" })).toThrow("requires a model");
    expect(() => backendFromConfig({ backend: "invalid" } as unknown as ChatConfig)).toThrow("Unsupported chat backend");
  });

  it("propagates runtime failure without silently probing another lane", async () => {
    const fake = unavailable();
    const backend = backendFromConfig({ backend: "openai-compatible" }, { fetchImpl: fake });
    await expect(backend.completeJSON({ prompt: "p", schema: {}, timeoutMs: 1000 })).rejects.toThrow("Endpoint request failed");
    expect(fake).toHaveBeenCalledTimes(1);
  });
});
