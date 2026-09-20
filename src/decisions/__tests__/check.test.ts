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
import { runCheckDecision, runGetStandingDecisions } from "../check.js";
import { axis, fixture, NOW, rows, seed, vector } from "./helpers.js";

it("ranks all origins/provenances by cosine, floors and caps, and records precisely what surfaced", async () => {
  const f = fixture();
  const best = seed(f.db, { text: "Best distilled decision", provenance: "distilled", embedding: axis });
  const ledger = seed(f.db, { origin: "ledger", embedding: vector(0.99) });
  const low = seed(f.db, { embedding: vector(0.54) });
  for (let i = 0; i < 45; i++) seed(f.db, { embedding: vector(0.6 + i / 200) });
  const result = await runCheckDecision(f.db, "Use local storage", f.deps);
  expect(result.error).toBeUndefined();
  expect(result.candidates).toHaveLength(40);
  expect(result.candidates[0]).toEqual({ decision_id: best, decision_text: "Best distilled decision",
    topic: "storage", reason: "because", provenance: "distilled", decided_at: NOW, similarity: 1 });
  expect(result.candidates[1]!.decision_id).toBe(ledger);
  expect(result.candidates.map(row => row.decision_id)).not.toContain(low);
  expect(result.candidates.every((row, i) => i === 0 || result.candidates[i - 1]!.similarity >= row.similarity)).toBe(true);
  expect(f.embed).toHaveBeenCalledExactlyOnceWith(["Use local storage"], "query");
  expect(rows(f.db, "receipts")).toMatchObject([{ statement: "Use local storage", surfaced_at: NOW,
    surfaced_ids: JSON.stringify(result.candidates.map(row => row.decision_id)), edge_id: null }]);
  expect(rows(f.db, "receipts")).toHaveLength(1);
});

it.each([false, true])("an empty/clear database is silent and still gets an empty receipt (seed=%s)", async populated => {
  const f = fixture();
  if (populated) seed(f.db, { embedding: vector(-1) });
  expect(await runCheckDecision(f.db, "Unrelated statement", f.deps)).toEqual({ candidates: [] });
  expect(rows(f.db, "receipts")).toMatchObject([{ statement: "Unrelated statement", surfaced_ids: "[]" }]);
});

it.each(["reject", "dimension", "nonfinite", "count"])("check embedding %s fails without a receipt", async mode => {
  const f = fixture();
  seed(f.db);
  if (mode === "reject") f.embed.mockRejectedValueOnce(new Error("unavailable"));
  if (mode === "dimension") f.embed.mockResolvedValueOnce([new Float32Array(2)]);
  if (mode === "nonfinite") f.embed.mockResolvedValueOnce([new Float32Array([NaN, 0, 0])]);
  if (mode === "count") f.embed.mockResolvedValueOnce([]);
  expect(await runCheckDecision(f.db, "statement", f.deps)).toEqual({ candidates: [], error: "embedding failed" });
  expect(rows(f.db, "receipts")).toHaveLength(0);
});

it("surfaces a receipt write failure instead of reporting an unrecorded success", async () => {
  const f = fixture();
  f.db.transaction(() => f.db.exec(`CREATE TRIGGER reject_receipt AFTER INSERT ON receipts
    BEGIN SELECT RAISE(ABORT, 'receipt failed'); END`))();
  await expect(runCheckDecision(f.db, "statement", f.deps)).rejects.toThrow("receipt failed");
  expect(rows(f.db, "receipts")).toHaveLength(0);
});

it("standing without a topic includes vector-less decisions in recency order and never embeds", async () => {
  const f = fixture();
  const oldest = seed(f.db, { decidedAt: "2024-01-01", provenance: "distilled" });
  const newest = seed(f.db, { decidedAt: "2026-01-01", withVector: false });
  const middle = seed(f.db, { decidedAt: "2025-01-01", origin: "ledger" });
  const result = await runGetStandingDecisions(f.db, {}, f.deps);
  expect(result.decisions.map(row => row.decision_id)).toEqual([newest, middle, oldest]);
  expect(Object.keys(result.decisions[0]!).sort()).toEqual([
    "decided_at", "decision_id", "decision_text", "provenance", "topic",
  ]);
  expect(f.embed).not.toHaveBeenCalled();
  expect(rows(f.db, "receipts")).toHaveLength(0);
});

it.each([
  [undefined, 20], [0, 20], [-1, 20], [NaN, 20], [Infinity, 20], [-Infinity, 20],
  ["5", 20], [null, 20], [2.9, 2], [0.5, 0], [50, 50], [100, 50],
])("standing clamps limit %s to %s with and without a topic", async (limit, expected) => {
  const f = fixture();
  f.db.transaction(() => {
    for (let i = 0; i < 55; i++) seed(f.db, { decidedAt: new Date(Date.UTC(2025, 0, i + 1)).toISOString() });
  })();
  for (const topic of [undefined, "storage"]) {
    const result = await runGetStandingDecisions(f.db, { topic, limit: limit as number | undefined }, f.deps);
    expect(result.error).toBeUndefined();
    expect(result.decisions).toHaveLength(expected as number);
    const dates = result.decisions.map(row => row.decided_at);
    expect(dates).toEqual([...dates].sort().reverse());
  }
});

it("topic takes the 200 most similar before recency and excludes even a newer lower-ranked match", async () => {
  const f = fixture();
  const relevantIds: string[] = [];
  f.db.transaction(() => {
    for (let i = 0; i < 200; i++) relevantIds.push(seed(f.db, {
      embedding: vector(0.8 + (199 - i) / 1000),
      decidedAt: new Date(Date.UTC(2020, 0, i + 1)).toISOString(),
    }));
  })();
  const recentButLessRelevant = seed(f.db, { embedding: vector(0.7), decidedAt: "2027-01-01" });
  const belowFloor = seed(f.db, { embedding: vector(0.54), decidedAt: "2028-01-01" });
  const result = await runGetStandingDecisions(f.db, { topic: "database", limit: 50 }, f.deps);
  expect(f.embed).toHaveBeenCalledExactlyOnceWith(["database"], "query");
  expect(result.decisions.map(row => row.decision_id)).toEqual(relevantIds.slice(-50).reverse());
  expect(result.decisions.map(row => row.decision_id)).not.toContain(recentButLessRelevant);
  expect(result.decisions.map(row => row.decision_id)).not.toContain(belowFloor);
  expect(Object.keys(result.decisions[0]!).sort()).toEqual([
    "decided_at", "decision_id", "decision_text", "provenance", "topic",
  ]);
});

it("topic filtering uses the floor, and a topic with no relevant match is normal", async () => {
  const f = fixture();
  const included = seed(f.db, { embedding: vector(0.56) });
  seed(f.db, { embedding: vector(0.54) });
  expect((await runGetStandingDecisions(f.db, { topic: "storage" }, f.deps)).decisions.map(row => row.decision_id))
    .toEqual([included]);
  f.embed.mockResolvedValueOnce([vector(-1)]);
  expect(await runGetStandingDecisions(f.db, { topic: "unrelated" }, f.deps)).toEqual({ decisions: [] });
});

it("topic embedding fails closed", async () => {
  const f = fixture();
  seed(f.db);
  f.embed.mockRejectedValueOnce(new Error("unavailable"));
  expect(await runGetStandingDecisions(f.db, { topic: "storage" }, f.deps))
    .toEqual({ decisions: [], error: "embedding failed" });
  expect(rows(f.db, "receipts")).toHaveLength(0);
});

it("check and topic standing propagate unmeasured database rail errors without fallback", async () => {
  const f = fixture();
  seed(f.db);
  f.db.transaction(() => setMeta(f.db, "embedder_id", "unmeasured-fixture"))();
  await expect(runCheckDecision(f.db, "statement", f.deps)).rejects.toThrow("no measured thresholds");
  await expect(runGetStandingDecisions(f.db, { topic: "storage" }, f.deps)).rejects.toThrow("no measured thresholds");
  expect(rows(f.db, "receipts")).toHaveLength(0);
  expect(f.embed).not.toHaveBeenCalled();
  expect((await runGetStandingDecisions(f.db, {}, f.deps)).decisions).toHaveLength(1);
});
