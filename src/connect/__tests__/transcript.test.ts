import { describe, expect, it } from "vitest";
import { parseTranscriptDelta } from "../transcript.js";

const timestamp = "2026-01-02T03:04:05.000Z";
function record(type: string, content: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, sessionId: "s1", uuid: `${type}-id`, timestamp,
    cwd: "/work/repo", message: { role: type, content, model: "model-id" }, ...extra }) + "\n";
}

describe("transcript delta", () => {
  it("extracts two complete pairs with assistant identity and data", () => {
    const bytes = Buffer.from(record("user", "question") + record("assistant", "answer") +
      record("user", "next") + record("assistant", "second", { uuid: "a2", cwd: "/other" }));
    const result = parseTranscriptDelta(bytes, 0);
    expect(result).toEqual({ turns: [
      { conversationId: "s1", sourceKey: "assistant-id", prompt: "question", response: "answer",
        model: "model-id", cwd: "/work/repo", capturedAt: timestamp },
      { conversationId: "s1", sourceKey: "a2", prompt: "next", response: "second",
        model: "model-id", cwd: "/other", capturedAt: timestamp },
    ], nextOffset: bytes.length, parseErrors: 0, lastBadOffset: null });
  });

  it("extracts only text blocks and skips empty assistant content", () => {
    const bytes = Buffer.from(record("user", [{ type: "text", text: "q" }, { type: "tool_result", text: "secret" }]) +
      record("assistant", [{ type: "text", text: "one" }, { type: "tool_use", text: "hidden" },
        { type: "thinking", text: "hidden" }, null, { type: "text", text: 42 }, { type: "text", text: "two" }]) +
      record("assistant", [{ type: "tool_use", text: "ignored" }]) + record("assistant", ""));
    const result = parseTranscriptDelta(bytes, 0);
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0]).toMatchObject({ prompt: "q", response: "onetwo" });
    expect(result.parseErrors).toBe(0);
  });

  it("retries an incomplete assistant after a consumed multibyte user", () => {
    const user = record("user", "你好 🦊");
    const assistant = record("assistant", "réponse", { uuid: undefined, cwd: undefined });
    const first = Buffer.from(user + assistant.slice(0, -5));
    const delta = parseTranscriptDelta(first, 0);
    expect(delta).toEqual({ turns: [], nextOffset: Buffer.byteLength(user), parseErrors: 0, lastBadOffset: null });
    const appended = Buffer.from(user + assistant);
    const next = parseTranscriptDelta(appended, delta.nextOffset);
    expect(next.turns[0]).toMatchObject({ prompt: "你好 🦊", response: "réponse",
      sourceKey: String(Buffer.byteLength(user)), cwd: "/work/repo" });
    expect(next.nextOffset).toBe(appended.length);
    expect(parseTranscriptDelta(appended, next.nextOffset).turns).toEqual([]);
  });

  it("recovers a user at EOF when the assistant arrives in a later call", () => {
    const user = record("user", "waiting");
    const first = parseTranscriptDelta(Buffer.from(user), 0);
    expect(first.nextOffset).toBe(Buffer.byteLength(user));
    expect(parseTranscriptDelta(Buffer.from(user + record("assistant", "done")), first.nextOffset).turns[0]?.prompt).toBe("waiting");
  });

  it("counts complete bad lines at byte offsets without losing surrounding turns", () => {
    const first = record("user", "é") + record("assistant", "first");
    const bytes = Buffer.from(first + "not JSON\n" + record("assistant", "second", { uuid: "second" }));
    const result = parseTranscriptDelta(bytes, 0);
    expect(result.turns).toHaveLength(2);
    expect(result.parseErrors).toBe(1);
    expect(result.lastBadOffset).toBe(Buffer.byteLength(first));
    expect(result.nextOffset).toBe(bytes.length);
    expect(parseTranscriptDelta(bytes, Buffer.byteLength(first + "not JSON\n")).parseErrors).toBe(0);
  });

  it("decodes invalid UTF8 lossily", () => {
    const bytes = Buffer.concat([Buffer.from(record("user", "q")),
      Buffer.from(record("assistant", "PLACEHOLDER").replace("PLACEHOLDER", "\u0001"))]);
    bytes[bytes.indexOf(1)] = 0xff;
    expect(parseTranscriptDelta(bytes, 0).turns[0]?.response).toBe("�");
  });

  it("pairs interleaved sessions independently and ignores unrelated records", () => {
    const bytes = Buffer.from(record("user", "a") + record("user", "b", { sessionId: "s2" }) +
      record("progress", "ignore") + record("assistant", "B", { sessionId: "s2" }) + record("assistant", "A"));
    expect(parseTranscriptDelta(bytes, 0).turns.map(t => [t.conversationId, t.prompt, t.response])).toEqual([
      ["s2", "b", "B"], ["s1", "a", "A"],
    ]);
  });

  it("does not invent prompts, models, or cwd for absent data", () => {
    expect(parseTranscriptDelta(Buffer.from(record("assistant", "orphan")), 0).turns).toEqual([]);
    const bytes = Buffer.from(record("user", "q", { cwd: null }) + record("assistant", "ignored", {
      cwd: null, message: { content: "r" },
    }));
    expect(parseTranscriptDelta(bytes, 0).turns[0]).toMatchObject({ cwd: null, model: null });
  });

  it("handles arbitrary JSON and counts unusable known record shapes", () => {
    const bytes = Buffer.from('null\n[]\n42\n{}\n{"type":"user"}\n{"type":"assistant","sessionId":"s","message":{}}\n');
    expect(parseTranscriptDelta(bytes, 0)).toMatchObject({ turns: [], parseErrors: 2, nextOffset: bytes.length });
  });

  it.each([-1, 0.5, NaN, Infinity, 2, 999])("rejects invalid offset %s", offset => {
    expect(() => parseTranscriptDelta(Buffer.from('{}\n'), offset)).toThrow(/record boundary/);
  });
});
