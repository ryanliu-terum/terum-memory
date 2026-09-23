import { expect, it, vi } from "vitest";
// The shipped local embedders are measured; an unmeasured id is simulated through the
// module seam so the "no fallback constants" contract stays under test.
vi.mock("../../engine/thresholds.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../engine/thresholds.js")>();
  return { ...actual, thresholdsFor: (id: string) => {
    if (id === "unmeasured-fixture") throw new Error('no measured thresholds for embedder "unmeasured-fixture" (fixture)');
    return actual.thresholdsFor(id);
  } };
});
import { setMeta } from "../../db/open.js";
import { decisionContentHash } from "../hash.js";
import { ratifyDecision, type RatifyInput } from "../ratify.js";
import { axis, fixture, NOW, rows, seed, vector } from "./helpers.js";

const input: RatifyInput = {
  decision_text: "Choose local SQLite storage", human_confirmed: true, human_confirmation_quote: "Yes, use SQLite",
};

it.each([
  { human_confirmed: undefined }, { human_confirmed: false },
  { human_confirmed: "true" }, { human_confirmed: 1 },
  { human_confirmation_quote: undefined }, { human_confirmation_quote: "" },
  { human_confirmation_quote: " \n\t " }, { human_confirmation_quote: null },
  { human_confirmation_quote: 42 },
])("fails the human gate before any side effect: %j", async invalid => {
  const f = fixture();
  const result = await ratifyDecision(f.db, { ...input, ...invalid } as RatifyInput, f.deps);
  expect(result).toEqual({ ok: false,
    error: "ratify_decision requires an explicit human confirmation and non-blank verbatim quote" });
  expect(rows(f.db, "decisions")).toHaveLength(0);
  expect(rows(f.db, "decision_vec")).toHaveLength(0);
  expect(f.embed).not.toHaveBeenCalled();
  expect(f.completeJSON).not.toHaveBeenCalled();
});

it("scrubs every supplied field before embedding, hashing, judging or storing", async () => {
  const f = fixture();
  const secret = "sk-abcdefghijklmnopqrstuvwxyz";
  const text = `Use ${secret} with password: x`;
  const scrubbed = "Use [REDACTED] with password: [REDACTED]";
  seed(f.db, { embedding: vector(0.65) });
  f.completeJSON.mockResolvedValueOnce('{"verdict":"reversal_or_distinct"}');
  const result = await ratifyDecision(f.db, { ...input, decision_text: text,
    reason: `password: x`, topic: secret, human_confirmation_quote: text }, f.deps);
  expect(result).toMatchObject({ ok: true, merged: false });
  if (!result.ok) throw new Error("Expected ratification");
  expect(f.embed).toHaveBeenCalledExactlyOnceWith([scrubbed], "document");
  expect(f.completeJSON.mock.calls[0]![0].prompt).toContain(scrubbed);
  expect(f.completeJSON.mock.calls[0]![0].prompt).not.toContain(secret);
  expect(f.db.prepare("SELECT * FROM decisions WHERE id = ?").get(result.decisionId)).toMatchObject({
    decision_text: scrubbed, human_quote: scrubbed, reason: "password: [REDACTED]", topic: "[REDACTED]",
    content_hash: decisionContentHash(scrubbed),
  });
});

it("inserts a ratified local UUID row and its vector atomically", async () => {
  const f = fixture();
  const result = await ratifyDecision(f.db, input, f.deps);
  expect(result).toMatchObject({ ok: true, merged: false });
  if (!result.ok) throw new Error("Expected ratification");
  expect(result.decisionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(rows(f.db, "decisions")).toMatchObject([{
    id: result.decisionId, note_id: null, decision_text: input.decision_text,
    content_hash: decisionContentHash(input.decision_text), provenance: "ratified", origin: "local",
    human_quote: input.human_confirmation_quote, decided_at: NOW, created_at: NOW,
    reason: null, topic: null, published_at: null, ledger_path: null,
  }]);
  expect(rows(f.db, "decision_vec")).toEqual([{ decision_id: result.decisionId,
    embedding: Buffer.from(axis.buffer) }]);
});

it("upgrades a judge-confirmed high-cosine distilled decision while preserving its first record and vector", async () => {
  const f = fixture();
  const id = seed(f.db, { text: "Keep storage on this machine", provenance: "distilled",
    embedding: vector(0.8), decidedAt: "2025-01-01", createdAt: "2025-01-02" });
  const before = rows(f.db, "decisions")[0]!;
  const vectors = rows(f.db, "decision_vec");
  expect(await ratifyDecision(f.db, input, f.deps)).toEqual({ ok: true, decisionId: id, merged: true });
  expect(rows(f.db, "decisions")).toEqual([{ ...before, provenance: "ratified", human_quote: input.human_confirmation_quote }]);
  expect(rows(f.db, "decision_vec")).toEqual(vectors);
  // Above the measured merge constant, but cosine alone does not merge until reconciliation.
  expect(f.completeJSON).toHaveBeenCalledTimes(1);
});

it("keeps a high-cosine reversal distinct instead of dropping the incoming text on cosine alone", async () => {
  const f = fixture();
  f.completeJSON.mockResolvedValue('{"verdict":"reversal_or_distinct"}');
  const id = seed(f.db, { text: "Keep storage on this machine", embedding: vector(0.95) });
  const result = await ratifyDecision(f.db, input, f.deps);
  expect(result).toMatchObject({ ok: true, merged: false });
  expect(rows(f.db, "decisions").map(row => row.id).sort()).toEqual([id, (result as { decisionId: string }).decisionId].sort());
  expect(rows(f.db, "decisions").map(row => row.decision_text)).toContain(input.decision_text);
});

it("keeps an in-band reversal as two separate rows and vectors", async () => {
  const f = fixture();
  const id = seed(f.db, { text: "Use the shared cache", embedding: vector(0.65) });
  f.completeJSON.mockResolvedValueOnce('{"verdict":"reversal_or_distinct"}');
  const result = await ratifyDecision(f.db, { ...input, decision_text: "Stop using the shared cache" }, f.deps);
  expect(result).toMatchObject({ ok: true, merged: false });
  if (result.ok) expect(result.decisionId).not.toBe(id);
  expect(rows(f.db, "decisions")).toHaveLength(2);
  expect(rows(f.db, "decision_vec")).toHaveLength(2);
  expect(f.completeJSON).toHaveBeenCalledTimes(1);
});

it("merges a judge-approved paraphrase", async () => {
  const f = fixture();
  const id = seed(f.db, { embedding: vector(0.65) });
  expect(await ratifyDecision(f.db, input, f.deps)).toEqual({ ok: true, decisionId: id, merged: true });
  expect(rows(f.db, "decisions")).toHaveLength(1);
  expect(rows(f.db, "decisions")[0]!.human_quote).toBe(input.human_confirmation_quote);
});

it("ignores ledger decisions even with identical content hashes and vectors", async () => {
  const f = fixture();
  const id = seed(f.db, { text: input.decision_text, origin: "ledger" });
  const result = await ratifyDecision(f.db, input, f.deps);
  expect(result).toMatchObject({ ok: true, merged: false });
  if (result.ok) expect(result.decisionId).not.toBe(id);
  expect(rows(f.db, "decisions")).toHaveLength(2);
});

it("two connections racing the same hash preserve one row and the first quote/timestamp", async () => {
  const f = fixture();
  const second = f.connect();
  const results = await Promise.all([
    ratifyDecision(f.db, input, f.deps),
    ratifyDecision(second, { ...input, human_confirmation_quote: "second quote" },
      { ...f.deps, now: () => new Date("2026-05-01") }),
  ]);
  const first = results[0]!;
  expect(first).toMatchObject({ ok: true, merged: false });
  if (!first.ok) throw new Error("Expected first ratification");
  expect(results[1]).toEqual({ ok: true, merged: true, decisionId: first.decisionId });
  expect(rows(f.db, "decisions")).toMatchObject([{ id: first.decisionId,
    human_quote: input.human_confirmation_quote, decided_at: NOW, created_at: NOW }]);
  expect(rows(f.db, "decisions")).toHaveLength(1);
  expect(rows(f.db, "decision_vec")).toHaveLength(1);
  expect(await ratifyDecision(second, { ...input, human_confirmation_quote: "retry" }, f.deps))
    .toEqual({ ok: true, decisionId: first.decisionId, merged: true });
  expect(rows(f.db, "decisions")[0]!.human_quote).toBe(input.human_confirmation_quote);
});

it("revalidates exact hashes inserted during judging, without holding a write lock across calls", async () => {
  const f = fixture();
  const second = f.connect();
  seed(f.db, { embedding: vector(0.65) });
  let exactId = "";
  f.embed.mockImplementationOnce(async () => {
    expect(f.db.inTransaction).toBe(false);
    return [axis];
  });
  f.completeJSON.mockImplementationOnce(async () => {
    expect(f.db.inTransaction).toBe(false);
    exactId = seed(second, { text: input.decision_text, quote: "concurrent first quote" });
    return '{"verdict":"same_decision"}';
  });
  const result = await ratifyDecision(f.db, input, f.deps);
  expect(result).toEqual({ ok: true, decisionId: exactId, merged: true });
  expect(rows(f.db, "decisions")).toHaveLength(2);
  expect(f.db.prepare("SELECT human_quote FROM decisions WHERE id = ?").get(exactId))
    .toEqual({ human_quote: "concurrent first quote" });
});

it("inserts when the selected candidate disappears during judging", async () => {
  const f = fixture();
  const second = f.connect();
  const id = seed(f.db, { embedding: vector(0.65) });
  f.completeJSON.mockImplementationOnce(async () => {
    second.transaction(() => {
      second.prepare("DELETE FROM decision_vec WHERE decision_id = ?").run(id);
      second.prepare("DELETE FROM decisions WHERE id = ?").run(id);
    }).immediate();
    return '{"verdict":"same_decision"}';
  });
  const result = await ratifyDecision(f.db, input, f.deps);
  expect(result).toMatchObject({ ok: true, merged: false });
  if (result.ok) expect(result.decisionId).not.toBe(id);
  expect(rows(f.db, "decisions")).toHaveLength(1);
  expect(rows(f.db, "decision_vec")).toHaveLength(1);
});

it.each(["reject", "dimension", "count", "nonfinite", "declared-dimension", "meta-dimension"])(
  "embedding %s fails closed with no writes", async mode => {
    const f = fixture();
    if (mode === "reject") f.embed.mockRejectedValueOnce(new Error("unavailable"));
    if (mode === "dimension") f.embed.mockResolvedValueOnce([new Float32Array(2)]);
    if (mode === "count") f.embed.mockResolvedValueOnce([]);
    if (mode === "nonfinite") f.embed.mockResolvedValueOnce([new Float32Array([Infinity, 0, 0])]);
    if (mode === "declared-dimension") f.deps.embedder.dim = 2;
    if (mode === "meta-dimension") f.db.transaction(() => setMeta(f.db, "embedder_dim", "4"))();
    expect(await ratifyDecision(f.db, input, f.deps)).toEqual({ ok: false, error: "embedding failed" });
    expect(rows(f.db, "decisions")).toHaveLength(0);
    expect(rows(f.db, "decision_vec")).toHaveLength(0);
  },
);

it("rolls back the decision and trigger vector if vector insertion fails", async () => {
  const f = fixture();
  f.db.transaction(() => f.db.exec(`CREATE TRIGGER duplicate_vector AFTER INSERT ON decisions BEGIN
    INSERT INTO decision_vec (decision_id, embedding) VALUES (NEW.id, '[1,0,0]'); END`))();
  await expect(ratifyDecision(f.db, input, f.deps)).rejects.toThrow();
  expect(rows(f.db, "decisions")).toHaveLength(0);
  expect(rows(f.db, "decision_vec")).toHaveLength(0);
});

it("propagates unmeasured rail errors without writing or inventing constants", async () => {
  const f = fixture();
  f.db.transaction(() => setMeta(f.db, "embedder_id", "unmeasured-fixture"))();
  await expect(ratifyDecision(f.db, input, f.deps)).rejects.toThrow("no measured thresholds");
  expect(rows(f.db, "decisions")).toHaveLength(0);
});
