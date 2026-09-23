import { afterEach, expect, it, vi } from "vitest";
import { thresholdsFor, REFERENCE_EMBEDDER } from "../../engine/thresholds.js";
import type { ChatBackend } from "../../llm/backend.js";
import { COSINE_AUTO_MERGE_DISABLED, effectiveRail, makeDedupJudge, selectDedupCandidate, type DedupCandidate, type DedupIncoming } from "../dedup.js";
import { axis, vector } from "./helpers.js";

const rail = thresholdsFor(REFERENCE_EMBEDDER).rail;
const incoming: DedupIncoming = {
  decisionText: "Stop using the shared cache", contentHash: "incoming", embedding: axis, decidedAt: "2026-01-02",
};
function candidate(id: string, similarity: number, overrides: Partial<DedupCandidate> = {}): DedupCandidate {
  return { id, decision_text: "Use the shared cache", content_hash: id, embedding: vector(similarity),
    decided_at: "2026-01-01", created_at: "2026-01-01", ...overrides };
}
afterEach(() => vi.restoreAllMocks());

it("exact hashes short-circuit semantic matches and judges, sorted by cosine then creation/id", async () => {
  const judge = vi.fn(async () => true);
  const low = candidate("low", -1, { content_hash: incoming.contentHash });
  const older = candidate("a", 0, { content_hash: incoming.contentHash, created_at: "2025-01-01" });
  const newer = candidate("b", 0, { content_hash: incoming.contentHash });
  const result = await selectDedupCandidate(incoming, [candidate("semantic", 1), low, newer, older], rail, judge);
  expect(result).toEqual({ candidate: older, similarity: 0, alsoMatched: ["b", "low"] });
  expect(judge).not.toHaveBeenCalled();
});

it("auto merges above the measured merge threshold without judging", async () => {
  const judge = vi.fn(async () => false);
  const match = candidate("auto", 0.8);
  expect((await selectDedupCandidate(incoming, [match], rail, judge)).candidate).toBe(match);
  expect(judge).not.toHaveBeenCalled();
});

it.each([true, false])("judge band qualifies only with true (verdict=%s)", async same => {
  const match = candidate("band", 0.65);
  const judge = vi.fn(async () => same);
  const result = await selectDedupCandidate(incoming, [match], rail, judge);
  expect(result.candidate).toBe(same ? match : null);
  expect(judge).toHaveBeenCalledExactlyOnceWith(incoming, match);
});

it("leaves an in-band reversal distinct and sends the exact identity prompt/schema", async () => {
  const match = candidate("reverse", 0.65);
  const completeJSON = vi.fn<ChatBackend["completeJSON"]>(async () => '{"verdict":"reversal_or_distinct"}');
  const judge = makeDedupJudge({ modelId: "fake", completeJSON });
  expect(await selectDedupCandidate(incoming, [match], rail, judge))
    .toEqual({ candidate: null, similarity: null, alsoMatched: [] });
  expect(completeJSON).toHaveBeenCalledExactlyOnceWith({
    prompt: "Decide whether two recorded decisions are the same decision re-stated, or a reversal/different decision. Return only the required JSON verdict.\n\nIncoming decision (decided 2026-01-02):\nStop using the shared cache\n\nCandidate decision (decided 2026-01-01):\nUse the shared cache\n\nSame decision re-stated, or a reversal/different decision?",
    schema: { type: "object", additionalProperties: false, required: ["verdict"],
      properties: { verdict: { type: "string", enum: ["same_decision", "reversal_or_distinct"] } } },
    timeoutMs: 10_000,
  });
});

it("sorts all qualifiers by similarity then creation then id, retaining alsoMatched", async () => {
  const a = candidate("a", 0.8);
  const b = candidate("b", 0.8);
  const old = candidate("old", 0.8, { created_at: "2025-01-01" });
  const high = candidate("high", 1);
  expect(await selectDedupCandidate(incoming, [b, a, old, high], rail, async () => false))
    .toEqual({ candidate: high, similarity: 1, alsoMatched: ["old", "a", "b"] });
});

it("ignores below-band, opposite, zero and empty candidates", async () => {
  const judge = vi.fn(async () => true);
  for (const candidates of [[], [candidate("low", 0.59), candidate("opposite", -1),
    candidate("zero", 0, { embedding: new Float32Array(3) })]]) {
    expect(await selectDedupCandidate(incoming, candidates, rail, judge))
      .toEqual({ candidate: null, similarity: null, alsoMatched: [] });
  }
  expect(judge).not.toHaveBeenCalled();
});

it("uses supplied rail values including inclusive boundaries", async () => {
  const custom = { merge: 1, judgeLow: 0, floor: -1 };
  const judge = vi.fn(async () => true);
  const auto = candidate("auto", 1);
  const band = candidate("band", 0);
  const result = await selectDedupCandidate(incoming, [auto, band, candidate("below", -1)], custom, judge);
  expect(result).toEqual({ candidate: auto, similarity: 1, alsoMatched: ["band"] });
  expect(judge).toHaveBeenCalledExactlyOnceWith(incoming, band);
});

it.each(["throw", "", "not JSON", '{"verdict":"conflict"}', "null", "[]", "{}",
  '{"verdict":true}', '{"verdict":"same_decision","extra":true}'])("judge failure %j warns and cannot merge", async content => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const judge = makeDedupJudge({ modelId: "fake", completeJSON: async () => {
    if (content === "throw") throw new Error("private backend detail");
    return content;
  } });
  expect(await judge(incoming, candidate("band", 0.65))).toBe(false);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls.flat().join(" ")).not.toContain("private backend detail");
});

it("parses same_decision as a positive identity verdict", async () => {
  const judge = makeDedupJudge({ modelId: "fake", completeJSON: async () => ' { "verdict": "same_decision" } ' });
  expect(await judge(incoming, candidate("band", 0.65))).toBe(true);
});

it("effectiveRail keeps the measured floor and judge band but never merges on cosine alone while the guard holds", async () => {
  expect(COSINE_AUTO_MERGE_DISABLED).toBe(true);
  const effective = effectiveRail(rail);
  expect(effective.floor).toBe(rail.floor);
  expect(effective.judgeLow).toBe(rail.judgeLow);
  expect(effective.merge).toBe(Number.POSITIVE_INFINITY);
  const judge = vi.fn(async () => false);
  const identical = candidate("identical", 1);
  expect((await selectDedupCandidate(incoming, [identical], effective, judge)).candidate).toBeNull();
  expect(judge).toHaveBeenCalledExactlyOnceWith(incoming, identical);
});
