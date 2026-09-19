import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { openDb, setMeta } from "../../db/open.js";
import { claimNext } from "../../jobs/queue.js";
import { enqueueReembed, run } from "../commands/reembed.js";
import type { EmbedderManifest } from "../../engine/models.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "reembed-cli-test-"));
  vi.stubEnv("TERUM_HOME", home);
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  const db = openDb({ dbPath: path.join(home, "memory.db") });
  cleanups.push(() => db.close());
  db.transaction(() => setMeta(db, "embedder_id", "old"))();
  const out = vi.fn(), err = vi.fn();
  const drain = vi.fn(async () => ({ processed: 0, results: [], skipped: 0, unsupported: [], runtimeUnavailable: false }));
  return { db, out, err, drain };
}
const pinned: EmbedderManifest = { id: "new", dim: 3, hfRepo: "fake", revision: "test", sha256: "test",
  onnxFile: "model.onnx", pooling: "mean", l2Normalize: false, maxTokens: 10, truncation: "tail", prefixes: null };

it("rejects an unpinned target before enqueue or worker startup", async () => {
  const f = fixture();
  const manifestFor = () => { throw new Error('embedder "unpinned-fixture" artifact pin is an unmeasured placeholder'); };
  expect(await run(["--model", "unpinned-fixture"], { ...f, manifestFor })).toBe(1);
  expect(f.err).toHaveBeenCalledExactlyOnceWith("cannot reembed: unpinned-fixture is not pinned/calibrated yet");
  expect(f.db.prepare("SELECT * FROM jobs").all()).toEqual([]); expect(f.drain).not.toHaveBeenCalled();
});
it.each(["unknown-model", "../../model", "__proto__"])("rejects unknown id %s cleanly", async id => {
  const f = fixture(); expect(await run(["--model", id], f)).toBe(1);
  expect(f.err.mock.calls[0]?.[0]).toContain("cannot reembed:");
  expect(f.db.prepare("SELECT * FROM jobs").all()).toEqual([]); expect(f.drain).not.toHaveBeenCalled();
});
it("same current model is a no-op without requiring an artifact pin", async () => {
  const f = fixture(); expect(await run(["--model", "old"], f)).toBe(0);
  expect(f.out).toHaveBeenCalledExactlyOnceWith("Already using old; nothing to reembed.");
  expect(f.db.prepare("SELECT * FROM jobs").all()).toEqual([]); expect(f.drain).not.toHaveBeenCalled();
});
it.each([[], ["--model"], ["--model", " "], ["--model", "new", "--model", "new"], ["--model", "new", "extra"], ["--unknown", "new"]])(
  "rejects invalid arguments %j with usage", async (...args) => {
    const f = fixture(); expect(await run(args, f)).toBe(1);
    expect(f.err.mock.calls[0]?.[0]).toContain("Usage: terum-memory reembed --model <id>");
    expect(f.db.prepare("SELECT * FROM jobs").all()).toEqual([]); expect(f.drain).not.toHaveBeenCalled();
  },
);
it("enqueues a pinned target, reports counts, and delegates to bounded worker drain", async () => {
  const f = fixture();
  f.db.transaction(() => {
    f.db.prepare(`INSERT INTO notes (id, site, conversation_id, turn_count, compacted_text, model_used,
      first_captured_at, last_captured_at, distilled_at) VALUES ('n', 'test', 'session', 1, 'note', 'fake', 't', 't', 't')`).run();
    f.db.prepare(`INSERT INTO decisions (id, decision_text, content_hash, provenance, decided_at, created_at)
      VALUES ('d', 'decision', 'hash', 'distilled', 't', 't')`).run();
  })();
  const deps = { ...f, manifestFor: vi.fn(() => pinned) };
  expect(await run(["--model", "new"], deps)).toBe(0);
  expect(f.db.prepare("SELECT kind, payload, status FROM jobs").all()).toEqual([
    { kind: "reembed", payload: '{"targetEmbedderId":"new"}', status: "queued" },
  ]);
  expect(f.out.mock.calls[0]?.[0]).toContain("re-embed 1 notes + 1 decisions under new; other work pauses until it finishes");
  expect(f.drain).toHaveBeenCalledExactlyOnceWith(f.db, deps);
});
it.each([false, true])("coalesces a pending switch (running=%s), retaining its target and id", async running => {
  const f = fixture(); const id = enqueueReembed(f.db, "new");
  if (running) expect(claimNext(f.db)?.id).toBe(id);
  expect(enqueueReembed(f.db, "another-model")).toBe(id);
  const other = openDb({ dbPath: f.db.name });
  try { expect(enqueueReembed(other, "new")).toBe(id); } finally { other.close(); }
  expect(await run(["--model", "another-model"], { ...f, manifestFor: () => ({ ...pinned, id: "another-model" }) })).toBe(0);
  expect(f.out.mock.calls[0]?.[0]).toContain(`Reembed ${id}: re-embed 0 notes + 0 decisions under new`);
  expect(f.db.prepare("SELECT payload FROM jobs").all()).toEqual([{ payload: '{"targetEmbedderId":"new"}' }]);
});
it("surfaces worker startup failures while preserving the enqueued switch", async () => {
  const f = fixture(); expect(await run(["--model", "new"], { ...f, manifestFor: () => pinned,
    drain: async () => { throw new Error("worker unavailable"); } })).toBe(1);
  expect(f.err).toHaveBeenCalledExactlyOnceWith("cannot reembed: worker unavailable");
  expect(f.db.prepare("SELECT status FROM jobs").get()).toEqual({ status: "queued" });
});
