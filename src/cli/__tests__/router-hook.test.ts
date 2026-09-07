import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { fixture } from "../../decisions/__tests__/helpers.js";
import { pair } from "../../backfill/__tests__/fixtures.js";
import { queueCounts } from "../../jobs/queue.js";
import { main } from "../index.js";
import { run as hook } from "../commands/hook.js";

it.each([["connect", "claude-code", "--no-backfill"], ["hook", "stop"]])("router consumes two-token command %s %s", async (...args) => {
  const run = vi.fn(async () => 0); const load = vi.fn(async () => ({ run }));
  expect(await main(args, { load })).toBe(0); expect(load).toHaveBeenCalledWith(args[0]); expect(run).toHaveBeenCalledWith(args.slice(2));
});
it.each([[], ["--help"], ["-h"], ["help"]])("help is preserved", async (...args) => {
  const out = vi.fn(); expect(await main(args, { out })).toBe(0); expect(out.mock.calls[0]?.[0]).toContain("Usage:");
});
it("version is preserved without loading commands", async () => {
  const out = vi.fn(); const load = vi.fn(); expect(await main(["--version"], { out, load })).toBe(0);
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as { version: string };
  expect(out).toHaveBeenCalledWith(pkg.version); expect(load).not.toHaveBeenCalled();
});
it.each([["unknown"], ["reembed"], ["connect", "wrong"], ["hook"], ["hook", "other"], ["../db/open"]])("unknown routing exits one with usage", async (...args) => {
  const err = vi.fn(); const load = vi.fn(); expect(await main(args, { err, load })).toBe(1);
  expect(err.mock.calls[0]?.[0]).toContain("Usage:"); expect(load).not.toHaveBeenCalled();
});
it("thrown errors are clean stderr messages without stacks", async () => {
  const err = vi.fn(); const out = vi.fn();
  expect(await main(["status"], { err, out, load: async () => ({ run: async () => { throw new Error("clean failure"); } }) })).toBe(1);
  expect(err).toHaveBeenCalledExactlyOnceWith("terum-memory: clean failure"); expect(out).not.toHaveBeenCalled();
});
it("real router loads commands lazily and catches import or command failures", async () => {
  const err = vi.fn();
  expect(await main(["status"], { err, load: async () => { throw new Error("module missing"); } })).toBe(1);
  expect(err).toHaveBeenCalledWith("terum-memory: module missing");
});
it("hook captures stdin transcript, spawns once, and returns within the fast budget", async () => {
  const { db } = fixture(); const file = path.join(path.dirname(db.name), "input.jsonl");
  fs.writeFileSync(file, pair()); const spawn = vi.fn(() => true);
  const started = performance.now();
  expect(await hook([], { db, readStdin: async () => JSON.stringify({ transcript_path: file }), spawn })).toBe(0);
  expect(performance.now() - started).toBeLessThan(100);
  expect(db.prepare("SELECT prompt, response FROM captures").all()).toEqual([{ prompt: "question", response: "response" }]);
  expect(queueCounts(db).queued).toBe(1); expect(spawn).toHaveBeenCalledOnce();
});
it.each(["{}", "null", "[]", '{"transcript_path":42}', '{"transcript_path":" "}', "not json"])("hook rejects malformed stdin %s", async input => {
  const { db } = fixture(); const spawn = vi.fn(() => true);
  await expect(hook([], { db, readStdin: async () => input, spawn })).rejects.toThrow(); expect(spawn).not.toHaveBeenCalled();
});
it("hook rejects unknown flags before reading stdin", async () => {
  const readStdin = vi.fn(async () => "{}"); const err = vi.fn();
  expect(await hook(["--bad"], { readStdin, err })).toBe(1); expect(readStdin).not.toHaveBeenCalled(); expect(err).toHaveBeenCalledWith("Usage: terum-memory hook stop");
});
it("hook reports malformed records and does not silently lose parse accounting", async () => {
  const { db } = fixture(); const file = path.join(path.dirname(db.name), "input.jsonl");
  fs.writeFileSync(file, "broken\n" + pair()); const err = vi.fn();
  await hook([], { db, readStdin: async () => JSON.stringify({ transcript_path: file }), spawn: () => true, err });
  expect(err).toHaveBeenCalledWith("Stop hook: 1 malformed transcript records");
});
it("hook transitive imports exclude LLM, embedder, compactor and worker loop", () => {
  const seen = new Set<string>();
  function walk(file: string): void {
    if (seen.has(file)) return; seen.add(file);
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*|\b(?:import|require)\s*\(\s*)["']([^"']+)["']/g)) {
      const specifier = match[1]!;
      expect(specifier).not.toMatch(/@huggingface|embedder|compactor|\/llm\/|worker\/loop/);
      if (specifier.startsWith(".")) walk(path.resolve(path.dirname(file), specifier.replace(/\.js$/, ".ts")));
    }
  }
  walk(path.resolve("src/cli/commands/hook.ts"));
  expect(seen.has(path.resolve("src/connect/capture.ts"))).toBe(true);
  expect(seen.has(path.resolve("src/worker/spawn.ts"))).toBe(true);
});
