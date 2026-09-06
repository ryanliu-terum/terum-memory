import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import type { EmbedderManifest } from "../models.js";

const mocks = vi.hoisted(() => ({
  install: vi.fn(), tokenizerLoad: vi.fn(), modelLoad: vi.fn(), tokenize: vi.fn(), forward: vi.fn(),
  env: { allowRemoteModels: true, allowLocalModels: false, localModelPath: "", useFSCache: true, useBrowserCache: true, useCustomCache: true },
}));
vi.mock("../model-install.js", () => ({ ensureModelInstalled: mocks.install }));
vi.mock("@huggingface/transformers", () => ({
  env: mocks.env,
  AutoTokenizer: { from_pretrained: mocks.tokenizerLoad },
  AutoModel: { from_pretrained: mocks.modelLoad },
  Tensor: class {
    constructor(public type: string, public data: BigInt64Array | Float32Array, public dims: number[]) {}
    tolist() { return [[[3, 4], [9, 9]]]; }
  },
}));
import { Tensor } from "@huggingface/transformers";
import { createLocalEmbedder } from "../embedder.js";

const manifest: EmbedderManifest = {
  id: "fixture", hfRepo: "fixtures/encoder", revision: "pinned", sha256: "f".repeat(64),
  onnxFile: "onnx/model_quantized.onnx", dim: 2, pooling: "mean",
  l2Normalize: false, maxTokens: 2, truncation: "tail", prefixes: null,
};
const root = path.resolve("fixture-models");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.install.mockResolvedValue(path.join(root, manifest.id));
  mocks.tokenizerLoad.mockResolvedValue(mocks.tokenize);
  mocks.modelLoad.mockResolvedValue(mocks.forward);
  mocks.tokenize.mockReturnValue({ input_ids: [[101, 102]], attention_mask: [[1, 0]] });
  mocks.forward.mockResolvedValue({ last_hidden_state: new Tensor("float32", new Float32Array([3, 4, 9, 9]), [1, 2, 2]) });
});

it("installs first, loads only local files, and adapts truncation, tensors, and hidden states", async () => {
  const embedder = await createLocalEmbedder(manifest, { modelsDir: root });
  expect(mocks.install).toHaveBeenCalledWith(manifest, { modelsDir: root });
  expect(mocks.install.mock.invocationCallOrder[0]).toBeLessThan(mocks.tokenizerLoad.mock.invocationCallOrder[0]!);
  expect(mocks.env).toEqual({
    allowRemoteModels: false, allowLocalModels: true, localModelPath: root,
    useFSCache: false, useBrowserCache: false, useCustomCache: false,
  });
  expect(mocks.tokenizerLoad).toHaveBeenCalledWith(path.join(root, manifest.id), { local_files_only: true });
  expect(mocks.modelLoad).toHaveBeenCalledWith(path.join(root, manifest.id), {
    local_files_only: true, device: "cpu", dtype: "fp32", subfolder: "onnx", model_file_name: "model_quantized",
  });
  expect(await embedder.embed(["text"], "document")).toEqual([new Float32Array([3, 4])]);
  expect(mocks.tokenize).toHaveBeenCalledWith(["text"], {
    padding: true, truncation: true, max_length: 2, return_tensor: false,
  });
  const feeds = mocks.forward.mock.calls[0]![0];
  expect(feeds.input_ids.type).toBe("int64");
  expect(feeds.input_ids.dims).toEqual([1, 2]);
  expect(Array.from(feeds.input_ids.data)).toEqual([101n, 102n]);
  expect(Array.from(feeds.attention_mask.data)).toEqual([1n, 0n]);
});

it.each(["encoder.onnx", "nested/weights/encoder_int8.onnx"])("preserves the exact manifest artifact path %s", async (onnxFile) => {
  await createLocalEmbedder({ ...manifest, onnxFile }, { modelsDir: root });
  const options = mocks.modelLoad.mock.calls[0]![1];
  expect(path.posix.join(options.subfolder, `${options.model_file_name}.onnx`)).toBe(onnxFile);
});

it("does not load the library's model API when installation fails", async () => {
  mocks.install.mockRejectedValueOnce(new Error("checksum mismatch"));
  await expect(createLocalEmbedder(manifest, { modelsDir: root })).rejects.toThrow("checksum mismatch");
  expect(mocks.tokenizerLoad).not.toHaveBeenCalled();
  expect(mocks.modelLoad).not.toHaveBeenCalled();
});

it("does not install or load a model with an injected seam", async () => {
  await createLocalEmbedder(manifest, { inference: { tokenize: vi.fn(), forward: vi.fn() } });
  expect(mocks.install).not.toHaveBeenCalled();
  expect(mocks.tokenizerLoad).not.toHaveBeenCalled();
  expect(mocks.modelLoad).not.toHaveBeenCalled();
});

it("rejects pooled-only model output instead of bypassing the pooling protocol", async () => {
  mocks.forward.mockResolvedValueOnce({ sentence_embedding: new Tensor("float32", new Float32Array([3, 4]), [1, 2]) });
  const embedder = await createLocalEmbedder(manifest, { modelsDir: root });
  await expect(embedder.embed(["text"], "query")).rejects.toThrow("last_hidden_state");
});
