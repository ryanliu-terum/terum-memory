import path from "node:path";
import type { Embedder } from "./embedder-types.js";
import type { EmbedderManifest } from "./models.js";
import { ensureModelInstalled } from "./model-install.js";

export const EMBED_BATCH_SIZE = 8;

export interface InferenceSeam {
  /** Keep the head, truncate to maxTokens, and align the attention mask. */
  tokenize(texts: string[], maxTokens: number): Promise<{ inputIds: number[][]; attentionMask: number[][] }>;
  /** Raw per-token hidden states: [batch][tokens][dim]. */
  forward(inputIds: number[][], attentionMask: number[][]): Promise<number[][][]>;
}

async function localInference(manifest: EmbedderManifest, modelsDir?: string): Promise<InferenceSeam> {
  const directory = await ensureModelInstalled(manifest, { modelsDir });
  const { AutoTokenizer, AutoModel, Tensor, env } = await import("@huggingface/transformers");
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = path.dirname(directory);
  env.useFSCache = false;
  env.useBrowserCache = false;
  env.useCustomCache = false;
  // Absolute paths keep simultaneous loads from depending on the global root.
  const tokenizer = await AutoTokenizer.from_pretrained(directory, { local_files_only: true });
  tokenizer.padding_side = "right";
  const model = await AutoModel.from_pretrained(directory, {
    local_files_only: true,
    device: "cpu",
    // fp32 adds no filename suffix; preserve the exact pinned basename,
    // including any quantization suffix. ONNX defines the graph's data types.
    dtype: "fp32",
    subfolder: path.posix.dirname(manifest.onnxFile) === "." ? "" : path.posix.dirname(manifest.onnxFile),
    model_file_name: path.posix.basename(manifest.onnxFile, ".onnx"),
  });
  return {
    async tokenize(texts, maxTokens) {
      const encoded = await tokenizer(texts, {
        padding: true, truncation: true, max_length: maxTokens, return_tensor: false,
      });
      return { inputIds: encoded.input_ids, attentionMask: encoded.attention_mask };
    },
    async forward(inputIds, attentionMask) {
      const dims = [inputIds.length, inputIds[0]!.length];
      const tensor = (rows: number[][]) => new Tensor("int64", BigInt64Array.from(rows.flat().map(BigInt)), dims);
      const output = await model({ input_ids: tensor(inputIds), attention_mask: tensor(attentionMask) });
      const hidden = output.last_hidden_state;
      if (!(hidden instanceof Tensor) || hidden.dims.length !== 3) {
        throw new Error("Model must return last_hidden_state with shape [batch, tokens, dim]");
      }
      return hidden.tolist() as number[][][];
    },
  };
}

function pool(tokens: number[][], mask: number[], manifest: EmbedderManifest): Float32Array {
  if (tokens.length !== mask.length || tokens.length === 0) {
    throw new Error(`Model token count mismatch: expected ${mask.length} nonempty tokens, got ${tokens.length}`);
  }
  for (const token of tokens) {
    if (token.length !== manifest.dim) {
      throw new Error(`Model dimension mismatch: expected ${manifest.dim}, got ${token.length}`);
    }
  }
  const vector = new Array<number>(manifest.dim).fill(0);
  if (manifest.pooling === "cls") {
    for (let d = 0; d < manifest.dim; d++) vector[d] = tokens[0]![d]!;
  } else {
    const count = mask.reduce((sum, weight) => sum + weight, 0);
    if (count === 0) throw new Error("Cannot mean-pool tokens with an all-zero attention mask");
    for (let t = 0; t < tokens.length; t++) {
      if (mask[t] === 0) continue;
      for (let d = 0; d < manifest.dim; d++) vector[d] = vector[d]! + tokens[t]![d]! * mask[t]!;
    }
    for (let d = 0; d < manifest.dim; d++) vector[d] = vector[d]! / count;
  }
  if (vector.some((value) => !Number.isFinite(value))) throw new Error("Model returned a non-finite vector");
  if (manifest.l2Normalize) {
    const norm = Math.hypot(...vector);
    if (norm === 0) throw new Error("Cannot normalize a zero-norm vector");
    for (let d = 0; d < manifest.dim; d++) vector[d] = vector[d]! / norm;
  }
  const result = Float32Array.from(vector);
  if (result.some((value) => !Number.isFinite(value))) throw new Error("Model vector exceeds Float32 range");
  return result;
}

export async function createLocalEmbedder(
  manifest: EmbedderManifest,
  opts: { modelsDir?: string; inference?: InferenceSeam } = {},
): Promise<Embedder> {
  if (!Number.isSafeInteger(manifest.maxTokens) || manifest.maxTokens < 1 ||
      !Number.isSafeInteger(manifest.dim) || manifest.dim < 1) {
    throw new Error("Embedder maxTokens and dim must be positive integers");
  }
  const inference = opts.inference ?? await localInference(manifest, opts.modelsDir);
  return {
    id: manifest.id,
    dim: manifest.dim,
    async embed(texts, kind) {
      const results: Float32Array[] = [];
      for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
        const batch = texts.slice(start, start + EMBED_BATCH_SIZE)
          .map((text) => (manifest.prefixes?.[kind] ?? "") + text);
        const encoded = await inference.tokenize(batch, manifest.maxTokens);
        if (encoded.inputIds.length !== batch.length || encoded.attentionMask.length !== batch.length) {
          throw new Error(`Tokenizer batch size mismatch: expected ${batch.length}`);
        }
        for (let i = 0; i < batch.length; i++) {
          const ids = encoded.inputIds[i]!;
          const mask = encoded.attentionMask[i]!;
          if (ids.length === 0 || ids.length !== mask.length || mask.some((value) => value !== 0 && value !== 1)) {
            throw new Error("Tokenizer must return nonempty token rows with aligned binary attention masks");
          }
        }
        // Enforce the seam contract too: a test/backend cannot send a tail
        // beyond the manifest limit through to inference.
        const ids = encoded.inputIds.map((row) => row.slice(0, manifest.maxTokens));
        const mask = encoded.attentionMask.map((row) => row.slice(0, manifest.maxTokens));
        const hidden = await inference.forward(ids, mask);
        if (hidden.length !== batch.length) {
          throw new Error(`Model batch size mismatch: expected ${batch.length}, got ${hidden.length}`);
        }
        for (let i = 0; i < batch.length; i++) results.push(pool(hidden[i]!, mask[i]!, manifest));
      }
      return results;
    },
  };
}
