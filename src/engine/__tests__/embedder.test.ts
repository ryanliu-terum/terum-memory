import { describe, expect, it, vi } from "vitest";
import { createLocalEmbedder, EMBED_BATCH_SIZE, type InferenceSeam } from "../embedder.js";
import type { EmbedderManifest } from "../models.js";

const manifest: EmbedderManifest = {
  id: "fixture", hfRepo: "fixtures/encoder", revision: null, sha256: null,
  onnxFile: "onnx/model_quantized.onnx", dim: 2, pooling: "mean",
  l2Normalize: false, maxTokens: 4, truncation: "tail", prefixes: null,
};

function fixture(tokens = [[2, 4], [6, 8]], mask = [1, 1]) {
  return {
    tokenize: vi.fn<InferenceSeam["tokenize"]>(async (texts) => ({
      inputIds: texts.map(() => tokens.map((_, i) => i)), attentionMask: texts.map(() => mask),
    })),
    forward: vi.fn<InferenceSeam["forward"]>(async (ids) => ids.map(() => tokens)),
  };
}

describe("local embed choke point", () => {
  it("owns document and query prefixing, including empty and already-prefixed texts", async () => {
    const inference = fixture();
    const embedder = await createLocalEmbedder({ ...manifest, prefixes: {
      document: "search_document: ", query: "search_query: ",
    } }, { inference });
    await embedder.embed(["hello", "", "search_document: existing"], "document");
    await embedder.embed(["where?", ""], "query");
    expect(inference.tokenize.mock.calls).toEqual([
      [["search_document: hello", "search_document: ", "search_document: search_document: existing"], 4],
      [["search_query: where?", "search_query: "], 4],
    ]);
    expect(embedder.id).toBe(manifest.id);
    expect(embedder.dim).toBe(manifest.dim);
  });

  it("passes unprefixed texts verbatim for both kinds", async () => {
    const inference = fixture();
    const embedder = await createLocalEmbedder(manifest, { inference });
    const texts = ["", "  whitespace\n", "文🙂", "search_query: literal"];
    await embedder.embed(texts, "document");
    await embedder.embed(texts, "query");
    expect(inference.tokenize.mock.calls).toEqual([[texts, 4], [texts, 4]]);
  });

  it.each([
    { pooling: "mean" as const, mask: [1, 1], expected: [4, 6] },
    { pooling: "mean" as const, mask: [1, 0], expected: [2, 4] },
    { pooling: "mean" as const, mask: [0, 1], expected: [6, 8] },
    { pooling: "cls" as const, mask: [1, 1], expected: [2, 4] },
  ])("pools $pooling with mask $mask", async ({ pooling, mask, expected }) => {
    const embedder = await createLocalEmbedder({ ...manifest, pooling }, { inference: fixture(undefined, mask) });
    const [result] = await embedder.embed(["text"], "document");
    expect(result).toBeInstanceOf(Float32Array);
    expect(Array.from(result!)).toEqual(expected);
    expect(result).toHaveLength(manifest.dim);
  });

  it.each(["mean", "cls"] as const)("normalizes %s after pooling to unit length", async (pooling) => {
    const embedder = await createLocalEmbedder({ ...manifest, pooling, l2Normalize: true }, {
      inference: fixture([[3, 4], [3, 4]]),
    });
    const [result] = await embedder.embed(["text"], "query");
    expect(result![0]).toBeCloseTo(0.6, 6);
    expect(result![1]).toBeCloseTo(0.8, 6);
    expect(Math.abs(Math.hypot(...result!) - 1)).toBeLessThan(1e-6);
  });

  it("throws on zero norm, including cancellation during mean pooling", async () => {
    const embedder = await createLocalEmbedder({ ...manifest, l2Normalize: true }, {
      inference: fixture([[1, -1], [-1, 1]]),
    });
    await expect(embedder.embed(["text"], "query")).rejects.toThrow("zero-norm");
  });

  it("allows zero vectors when normalization is disabled", async () => {
    const embedder = await createLocalEmbedder(manifest, { inference: fixture([[0, 0], [0, 0]]) });
    expect(await embedder.embed([""], "query")).toEqual([new Float32Array([0, 0])]);
  });

  it("passes maxTokens to tokenize and enforces head truncation before forward", async () => {
    const inference = fixture();
    inference.tokenize.mockResolvedValue({ inputIds: [[91, 7, 3, 25, 99, 100]], attentionMask: [[1, 1, 1, 0, 1, 1]] });
    inference.forward.mockImplementation(async (ids, masks) => {
      expect(ids).toEqual([[91, 7, 3, 25]]);
      expect(masks).toEqual([[1, 1, 1, 0]]);
      return ids.map((row) => row.map((id) => [id, 0]));
    });
    const embedder = await createLocalEmbedder(manifest, { inference });
    await embedder.embed(["long input"], "document");
    expect(inference.tokenize).toHaveBeenCalledWith(["long input"], manifest.maxTokens);
    expect(inference.forward).toHaveBeenCalledTimes(1);
  });

  it("batches tokenization and inference at 8, preserving all 20 results in input order", async () => {
    const inference = fixture();
    inference.tokenize.mockImplementation(async (texts) => ({
      inputIds: texts.map((text) => [Number(text)]), attentionMask: texts.map(() => [1]),
    }));
    inference.forward.mockImplementation(async (ids) => ids.map(([id]) => [[id!, -id!]]));
    const embedder = await createLocalEmbedder(manifest, { inference });
    const texts = Array.from({ length: 20 }, (_, i) => String(i));
    const result = await embedder.embed(texts, "document");
    expect(EMBED_BATCH_SIZE).toBe(8);
    expect(inference.tokenize.mock.calls.map(([batch]) => batch.length)).toEqual([8, 8, 4]);
    expect(inference.forward.mock.calls.map(([batch]) => batch.length)).toEqual([8, 8, 4]);
    expect(result.map((vector) => vector[0])).toEqual(texts.map(Number));
  });

  it.each(["document", "query"] as const)("returns [] for empty %s input without seam calls", async (kind) => {
    const inference = fixture();
    const embedder = await createLocalEmbedder(manifest, { inference });
    expect(await embedder.embed([], kind)).toEqual([]);
    expect(inference.tokenize).not.toHaveBeenCalled();
    expect(inference.forward).not.toHaveBeenCalled();
  });

  it.each(["mean", "cls"] as const)("checks every token dimension for %s, including masked tokens", async (pooling) => {
    const embedder = await createLocalEmbedder({ ...manifest, pooling }, {
      inference: fixture([[1, 2], [3, 4, 5]], [1, 0]),
    });
    await expect(embedder.embed(["bad shape"], "query")).rejects.toThrow(/expected 2, got 3/);
  });

  it("throws instead of dividing by zero for an all-masked mean", async () => {
    const embedder = await createLocalEmbedder(manifest, { inference: fixture(undefined, [0, 0]) });
    await expect(embedder.embed(["text"], "query")).rejects.toThrow("all-zero attention mask");
  });

  it.each([NaN, Infinity, -Infinity])("rejects non-finite active values: %s", async (value) => {
    const embedder = await createLocalEmbedder(manifest, { inference: fixture([[value, 1], [2, 3]]) });
    await expect(embedder.embed(["text"], "query")).rejects.toThrow("non-finite");
  });

  it("excludes masked NaNs from the mean entirely", async () => {
    const embedder = await createLocalEmbedder(manifest, { inference: fixture([[2, 3], [NaN, NaN]], [1, 0]) });
    expect(await embedder.embed(["text"], "query")).toEqual([new Float32Array([2, 3])]);
  });

  it.each([
    { inputIds: [], attentionMask: [] },
    { inputIds: [[]], attentionMask: [[]] },
    { inputIds: [[1, 2]], attentionMask: [[1]] },
    { inputIds: [[1]], attentionMask: [[-1]] },
  ])("rejects malformed tokenizer output: %j", async (encoded) => {
    const inference = fixture();
    inference.tokenize.mockResolvedValue(encoded);
    const embedder = await createLocalEmbedder(manifest, { inference });
    await expect(embedder.embed(["text"], "query")).rejects.toThrow(/Tokenizer/);
    expect(inference.forward).not.toHaveBeenCalled();
  });

  it.each([{ hidden: [] }, { hidden: [[[1, 2]]] }])("rejects malformed forward shape: $hidden", async ({ hidden }) => {
    const inference = fixture();
    inference.forward.mockResolvedValue(hidden);
    const embedder = await createLocalEmbedder(manifest, { inference });
    await expect(embedder.embed(["text"], "query")).rejects.toThrow(/mismatch/);
  });

  it("propagates inference failures without returning partial results", async () => {
    const inference = fixture();
    inference.forward.mockRejectedValueOnce(new Error("inference failed"));
    const embedder = await createLocalEmbedder(manifest, { inference });
    await expect(embedder.embed(["text"], "query")).rejects.toThrow("inference failed");
  });
});
