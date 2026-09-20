/**
 * Supported embedder artifact pins. Cosine values are meaningless without the
 * exact artifact, so every supported embedder is pinned by HF repo id +
 * revision + ONNX file + sha256; downloads verify the checksum and install
 * atomically (tmp + rename). Same throw-on-placeholder rule as thresholds.ts:
 * an unpinned artifact cannot silently ship.
 */

export interface EmbedderManifest {
  id: string;
  dim: number;
  hfRepo: string;
  /** exact HF revision (commit sha) — null = unpinned placeholder, throws */
  revision: string | null;
  onnxFile: string;
  /** sha256 of the ONNX artifact — null = unpinned placeholder, throws */
  sha256: string | null;
  pooling: "mean" | "cls";
  l2Normalize: boolean;
  maxTokens: number;
  truncation: "tail";
  /**
   * Prefix protocol, applied at the single embed choke point: `document` for
   * stored texts, `query` for query-side texts. Nothing outside the embedder
   * module may call the model directly.
   */
  prefixes: { document: string; query: string } | null;
}

const MANIFESTS: Record<string, EmbedderManifest> = {
  "nomic-embed-text-v1": {
    id: "nomic-embed-text-v1",
    dim: 768,
    hfRepo: "nomic-ai/nomic-embed-text-v1",
    // Pinned 2026-09-19 to the upstream repository's then-current revision.
    revision: "3ac47f125a41961d13b397d0332866be2f9152e1",
    onnxFile: "onnx/model_quantized.onnx",
    sha256: "b7941066a6529a287e2502ea6cb68ff82006d311eac53627dc88c259cbcbda64",
    pooling: "mean",
    l2Normalize: true,
    maxTokens: 8192,
    truncation: "tail",
    prefixes: { document: "search_document: ", query: "search_query: " },
  },
  "all-MiniLM-L6-v2": {
    id: "all-MiniLM-L6-v2",
    dim: 384,
    hfRepo: "sentence-transformers/all-MiniLM-L6-v2",
    // Pinned 2026-09-19. Upstream ships no `model_quantized.onnx`; the
    // dynamically quantized uint8 graph is the ~25 MB low-resource artifact and
    // runs on any CPU (its filename records the quantization target only).
    revision: "1110a243fdf4706b3f48f1d95db1a4f5529b4d41",
    onnxFile: "onnx/model_quint8_avx2.onnx",
    sha256: "b941bf19f1f1283680f449fa6a7336bb5600bdcd5f84d10ddc5cd72218a0fd21",
    pooling: "mean",
    l2Normalize: true,
    maxTokens: 512,
    truncation: "tail",
    prefixes: null,
  },
};

export function knownEmbedders(): string[] {
  return Object.keys(MANIFESTS);
}

export function manifestFor(embedderId: string): EmbedderManifest {
  const manifest = MANIFESTS[embedderId];
  if (manifest === undefined) {
    throw new Error(`unknown embedder "${embedderId}"`);
  }
  if (manifest.revision === null || manifest.sha256 === null) {
    throw new Error(
      `embedder "${embedderId}" artifact pin is an unmeasured placeholder ` +
        `(revision/sha256 missing) — pin the exact HF revision and ONNX sha256 before use`,
    );
  }
  return manifest;
}
