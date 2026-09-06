import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureModelInstalled } from "../model-install.js";
import type { EmbedderManifest } from "../models.js";

const artifact = Buffer.from([0, 255, 13, 10, 42, 128]);
const manifest: EmbedderManifest = {
  id: "fixture", hfRepo: "fixtures/encoder", revision: "pinned-revision",
  sha256: createHash("sha256").update(artifact).digest("hex"),
  onnxFile: "onnx/model_quantized.onnx", dim: 2, pooling: "mean",
  l2Normalize: true, maxTokens: 16, truncation: "tail", prefixes: null,
};
const files = ["config.json", "tokenizer.json", "tokenizer_config.json", manifest.onnxFile];
let root: string;
const installDir = () => path.join(root, manifest.id);
const markerPath = () => path.join(installDir(), ".installed.json");

function fakeFetch() {
  return vi.fn<typeof fetch>(async (url) => new Response(
    String(url).endsWith(".onnx") ? artifact : JSON.stringify({ fixture: String(url) }),
  ));
}

async function walk(dir: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    result.push(file);
    if (entry.isDirectory()) result.push(...await walk(file));
  }
  return result;
}

beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "terum-model-test-")); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe("model installation", () => {
  it("downloads the pinned layout, sets a timeout on every fetch, and writes the marker last", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const progress = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      expect(existsSync(markerPath())).toBe(false);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(String(url).endsWith(".onnx") ? artifact : "{}");
    });
    expect(await ensureModelInstalled(manifest, { modelsDir: root, fetchImpl, onProgress: progress })).toBe(installDir());
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual(files.map(
      (file) => `https://huggingface.co/${manifest.hfRepo}/resolve/${manifest.revision}/${file}`,
    ));
    expect(timeout.mock.calls).toEqual(files.map(() => [120_000]));
    expect(progress).toHaveBeenCalledTimes(4);
    for (const file of files) expect(existsSync(path.join(installDir(), file))).toBe(true);
    expect(await readFile(path.join(installDir(), manifest.onnxFile))).toEqual(artifact);
    const marker = JSON.parse(await readFile(markerPath(), "utf8"));
    expect(marker).toEqual({ id: manifest.id, revision: manifest.revision, sha256: manifest.sha256, installedAt: expect.any(String) });
    expect(Number.isNaN(Date.parse(marker.installedAt))).toBe(false);
    expect((await walk(root)).filter((file) => file.endsWith(".tmp"))).toEqual([]);
  });

  it("leaves no marker on a mid-install failure and redownloads every file on retry", async () => {
    const fetchImpl = fakeFetch();
    fetchImpl.mockImplementationOnce(async () => new Response("{}"));
    fetchImpl.mockImplementationOnce(async () => { throw new Error("connection lost"); });
    await expect(ensureModelInstalled(manifest, { modelsDir: root, fetchImpl })).rejects.toThrow("connection lost");
    expect(existsSync(markerPath())).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const retry = fakeFetch();
    await ensureModelInstalled(manifest, { modelsDir: root, fetchImpl: retry });
    expect(retry).toHaveBeenCalledTimes(4);
  });

  it("cleans a partially streamed temp file when reading the body fails", async () => {
    let reads = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({
      pull(controller) {
        if (reads++ === 0) controller.enqueue(new Uint8Array([1, 2]));
        else controller.error(new Error("broken stream"));
      },
    })));
    await expect(ensureModelInstalled(manifest, { modelsDir: root, fetchImpl })).rejects.toThrow("broken stream");
    expect(existsSync(markerPath())).toBe(false);
    expect((await walk(root)).filter((file) => file.endsWith(".tmp") || file.endsWith("config.json"))).toEqual([]);
  });

  it("rejects a bad checksum without installing the artifact, marking completion, or retrying", async () => {
    const fetchImpl = fakeFetch();
    await expect(ensureModelInstalled({ ...manifest, sha256: "0".repeat(64) }, { modelsDir: root, fetchImpl }))
      .rejects.toThrow(/Checksum mismatch.*expected 0+.*got/);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(existsSync(markerPath())).toBe(false);
    expect(existsSync(path.join(installDir(), manifest.onnxFile))).toBe(false);
    expect((await walk(root)).filter((file) => file.endsWith(".tmp"))).toEqual([]);
  });

  it("short-circuits a matching marker without network", async () => {
    await ensureModelInstalled(manifest, { modelsDir: root, fetchImpl: fakeFetch() });
    const fetchImpl = fakeFetch();
    expect(await ensureModelInstalled(manifest, { modelsDir: root, fetchImpl })).toBe(installDir());
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["revision", "sha256"] as const)("rejects a disagreeing %s naming both pins and reembed", async (field) => {
    await ensureModelInstalled(manifest, { modelsDir: root, fetchImpl: fakeFetch() });
    const changed = { ...manifest, [field]: field === "sha256" ? "f".repeat(64) : "different-revision" };
    const fetchImpl = fakeFetch();
    const result = ensureModelInstalled(changed, { modelsDir: root, fetchImpl });
    await expect(result).rejects.toThrow(manifest[field]!);
    await expect(result).rejects.toThrow(changed[field]!);
    await expect(result).rejects.toThrow("reembed");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("names the file and HTTP status on non-2xx", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("missing", { status: 404 }));
    await expect(ensureModelInstalled(manifest, { modelsDir: root, fetchImpl })).rejects.toThrow(/config.json.*404/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(existsSync(markerPath())).toBe(false);
  });

  it.skipIf(process.platform === "win32")("creates and repairs 0700 directories and 0600 files even on a cache hit", async () => {
    await ensureModelInstalled(manifest, { modelsDir: root, fetchImpl: fakeFetch() });
    const entries = [root, ...await walk(root)];
    for (const file of entries) {
      const info = await stat(file);
      expect(info.mode & 0o777).toBe(info.isDirectory() ? 0o700 : 0o600);
      await chmod(file, info.isDirectory() ? 0o755 : 0o644);
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await ensureModelInstalled(manifest, { modelsDir: root, fetchImpl: fakeFetch() });
    for (const file of entries) {
      const info = await stat(file);
      expect(info.mode & 0o777).toBe(info.isDirectory() ? 0o700 : 0o600);
    }
    expect(warn).toHaveBeenCalledTimes(entries.length);
  });

  it.each(["null", "{}", "not json"])("does not overwrite malformed marker %s", async (value) => {
    await mkdir(installDir());
    await writeFile(markerPath(), value, { mode: 0o600 });
    const fetchImpl = fakeFetch();
    await expect(ensureModelInstalled(manifest, { modelsDir: root, fetchImpl })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await readFile(markerPath(), "utf8")).toBe(value);
  });

  it.each([
    { revision: null }, { sha256: null }, { sha256: "not-a-hash" },
    { id: "../escape" }, { id: "/absolute" }, { onnxFile: "../escape.onnx" },
    { onnxFile: "onnx/../../escape.onnx" }, { onnxFile: "onnx\\escape.onnx" },
  ])("rejects invalid pins or paths before fetching: %j", async (override) => {
    const fetchImpl = fakeFetch();
    await expect(ensureModelInstalled({ ...manifest, ...override }, { modelsDir: root, fetchImpl })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });
});
