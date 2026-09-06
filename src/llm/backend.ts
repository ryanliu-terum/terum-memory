export interface ChatBackend {
  readonly modelId: string;
  /** One schema-constrained completion; resolves to the raw text of the model's message. */
  completeJSON(req: {
    prompt: string;
    schema: Record<string, unknown>;
    timeoutMs: number;
  }): Promise<string>;
}
