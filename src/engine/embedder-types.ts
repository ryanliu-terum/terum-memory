export interface Embedder {
  readonly id: string;
  readonly dim: number;
  /** kind selects the prefix-protocol side; implementations own the prefixes. */
  embed(texts: string[], kind: "document" | "query"): Promise<Float32Array[]>;
}
