import { getMeta, type Db } from "../db/open.js";
import type { Embedder } from "../engine/embedder-types.js";

/** Shared validation for the one-vector document/query calls. */
export async function embedOne(
  db: Db, embedder: Embedder, text: string, kind: "document" | "query",
): Promise<Float32Array> {
  const vectors = await embedder.embed([text], kind);
  const dim = Number(getMeta(db, "embedder_dim"));
  const vector = vectors[0];
  if (!Number.isSafeInteger(dim) || dim <= 0 || embedder.dim !== dim ||
      vectors.length !== 1 || !(vector instanceof Float32Array) || vector.length !== dim ||
      !vector.every(Number.isFinite)) {
    throw new Error("Invalid embedding dimensions or values");
  }
  return vector;
}

export function decodeVector(bytes: Buffer): Float32Array {
  return Float32Array.from({ length: bytes.byteLength / 4 }, (_, i) => bytes.readFloatLE(i * 4));
}
