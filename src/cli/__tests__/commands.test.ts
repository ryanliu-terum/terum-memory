import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fixture, seed, rows } from "../../decisions/__tests__/helpers.js";
import { getMeta, setMeta } from "../../db/open.js";
import { enqueueJob, claimNext, failJob, completeJob, queueCounts } from "../../jobs/queue.js";
import { pair } from "../../backfill/__tests__/fixtures.js";
import { run as init } from "../commands/init.js";
import { run as connect } from "../commands/connect.js";
import { run as uninstall } from "../commands/uninstall.js";
import { run as backfill } from "../commands/backfill.js";
import { run as decisions } from "../commands/decisions.js";
import { run as show } from "../commands/show.js";
import { run as check } from "../commands/check.js";
import { run as search } from "../commands/search.js";
import { run as decide } from "../commands/decide.js";
import { run as status } from "../commands/status.js";
import { run as sync } from "../commands/sync.js";
import { run as mcp } from "../commands/mcp.js";
import type { CommandDeps } from "../commands/shared.js";

function setup() {
  const f = fixture();
  const home = path.dirname(f.db.name);
  const out = vi.fn<(text: string) => void>();
  const err = vi.fn<(text: string) => void>();
  const spawn = vi.fn(() => true);
  const deps: CommandDeps = { db: f.db, out, err, spawn, runtime: f.deps, opportunistic: false,
    projectsDir: path.join(home, "projects"), settingsPath: path.join(home, "claude", "settings.json"),
    mcpConfigPath: path.join(home, "claude.json"), loadConfig: () => ({}), env: {} };
  return { ...f, deps, out, err, spawn, home, output: () => out.mock.calls.map(call => call[0]).join("\n") };
}
function transcripts(dir: string, count: number) {
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) fs.writeFileSync(path.join(dir, `${i}.jsonl`), pair(`session-${i}`, `uuid-${i}`));
}

describe("init", () => {
  it("creates/migrates the database and clearly reports unpinned artifacts", async () => {
    const f = setup(); const file = path.join(f.home, "fresh.db");
    expect(await init([], { ...f.deps, db: undefined, dbPath: file })).toBe(1);
    expect(fs.existsSync(file)).toBe(true);
    expect(f.output()).toMatch(/No calibrated embedder pinned yet/);
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it("a locked database never relocks, reinstalls, or probes", async () => {
    const f = setup(); f.db.transaction(() => setMeta(f.db, "embedder_locked_at", "original"))();
    const install = vi.fn(); const probe = vi.fn();
    expect(await init(["--model", "different"], { ...f.deps, ensureModelInstalled: install, probeChatBackends: probe })).toBe(0);
    expect(getMeta(f.db, "embedder_locked_at")).toBe("original");
    expect(getMeta(f.db, "embedder_id")).toBe("text-embedding-3-small");
    expect(install).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled();
    expect(f.output()).toContain("capture-only mode");
  });
  it("pins meta and vectors atomically only after a successful injected install", async () => {
    const f = setup(); const file = path.join(f.home, "pinned.db");
    const manifest = { id: "test", dim: 3, hfRepo: "fake", revision: "pin", sha256: "x", onnxFile: "model.onnx",
      pooling: "mean" as const, l2Normalize: true, maxTokens: 10, truncation: "tail" as const, prefixes: null };
    const saveConfig = vi.fn(); const probeChatBackends = vi.fn(async () => ({ config: null, transcript: ["No backend found"] }));
    const install = vi.fn(async () => f.home);
    const opts = { ...f.deps, db: undefined, dbPath: file, manifestFor: () => manifest, ensureModelInstalled: install, probeChatBackends, saveConfig };
    expect(await init([], opts)).toBe(0); expect(install).toHaveBeenCalledOnce(); expect(saveConfig).toHaveBeenCalledWith({});
    expect(await init([], opts)).toBe(0); expect(install).toHaveBeenCalledOnce(); expect(probeChatBackends).toHaveBeenCalledOnce();
  });
});

describe("connect, backfill and uninstall", () => {
  it("installs idempotently, offers the plan, and honors --no-backfill", async () => {
    const f = setup(); transcripts(f.deps.projectsDir!, 1);
    expect(await connect(["--no-backfill"], f.deps)).toBe(0);
    const first = fs.readFileSync(f.deps.settingsPath!, "utf8");
    expect(await connect(["--no-backfill"], f.deps)).toBe(0);
    expect(fs.readFileSync(f.deps.settingsPath!, "utf8")).toBe(first);
    expect(f.output()).toContain("Backfill plan: 1 selected"); expect(queueCounts(f.db).queued).toBe(0); expect(f.spawn).not.toHaveBeenCalled();
    expect(await uninstall([], f.deps)).toBe(0); expect(fs.existsSync(f.db.name)).toBe(true);
    expect(fs.readFileSync(f.deps.settingsPath!, "utf8")).not.toContain("terum-memory hook stop");
    expect(f.output()).toContain("Data remains under"); expect(f.output()).toContain("terum-memory uninstall --purge");
  });
  it("default connect durably enqueues the snapshot and requests a detached worker", async () => {
    const f = setup(); transcripts(f.deps.projectsDir!, 2);
    expect(await connect([], f.deps)).toBe(0);
    expect(queueCounts(f.db).queued).toBe(1); expect(f.spawn).toHaveBeenCalledOnce();
    const row = f.db.prepare("SELECT payload FROM jobs").get() as { payload: string };
    expect(JSON.parse(row.payload).snapshot.selected).toHaveLength(2);
  });
  it("backfill imports using the real M11 jobs even when runtime is unavailable", async () => {
    const f = setup(); transcripts(f.deps.projectsDir!, 2);
    expect(await backfill([], { ...f.deps, runtime: () => { throw new Error("no runtime"); } })).toBe(0);
    expect(f.db.prepare("SELECT count(*) AS n FROM captures").get()).toEqual({ n: 2 });
    expect(f.output()).toContain("waiting on no runtime"); expect(f.output()).toContain("Backfill partial"); expect(f.spawn).toHaveBeenCalledOnce();
  });
  it("default caps at 50 and reports omissions", async () => {
    const f = setup(); transcripts(f.deps.projectsDir!, 51);
    await connect([], f.deps);
    const row = f.db.prepare("SELECT payload FROM jobs").get() as { payload: string };
    expect(JSON.parse(row.payload).snapshot.selected).toHaveLength(50);
    expect(f.output()).toContain("1 omitted");
  });
  it.each([["--limit", "-1"], ["--limit", "1.5"], ["--limit", "1e3"], ["--limit", "9007199254740992"], ["--slow", "--all"], ["--wat"], ["--limit"]])("rejects bad flags %j", async (...args) => {
    const f = setup(); expect(await backfill(args, f.deps)).toBe(1);
    expect(f.err).toHaveBeenCalled(); expect(queueCounts(f.db).queued).toBe(0);
  });
  it("--all requires actual key availability or Ollama", async () => {
    const f = setup(); transcripts(f.deps.projectsDir!, 1);
    await expect(backfill(["--all"], { ...f.deps, loadConfig: () => ({ chat: { backend: "openai-compatible", api_key_env: "TEST_KEY" } }) })).rejects.toThrow("requires an API key or Ollama");
    expect(queueCounts(f.db).queued).toBe(0);
  });
  it.each(["ollama", "openai-compatible"] as const)("--all confirms more than 200 sessions for %s", async backend => {
    const f = setup(); transcripts(f.deps.projectsDir!, 201);
    const confirm = vi.fn(async () => false);
    await backfill(["--all"], { ...f.deps, confirm, env: { TEST_KEY: "fake" }, loadConfig: () => ({ chat: { backend, api_key_env: "TEST_KEY" } }) });
    expect(confirm).toHaveBeenCalledOnce(); expect(queueCounts(f.db).queued).toBe(0); expect(f.spawn).not.toHaveBeenCalled();
  });
  it("--all with confirmation enqueues every session", async () => {
    const f = setup(); transcripts(f.deps.projectsDir!, 201);
    await backfill(["--all"], { ...f.deps, confirm: async () => true, loadConfig: () => ({ chat: { backend: "ollama" } }), drainOptions: { dispatch: async (db, claim) => ({ status: completeJob(db, claim) ? "done" : "stale" }) } });
    const row = f.db.prepare("SELECT payload FROM jobs WHERE kind = 'backfill'").get() as { payload: string };
    expect(JSON.parse(row.payload).snapshot.selected).toHaveLength(201);
  });
  it("--slow staggers batches without immediate full import", async () => {
    const f = setup(); transcripts(f.deps.projectsDir!, 101);
    const now = () => new Date("2030-01-01T00:00:00Z");
    await backfill(["--slow"], { ...f.deps, now });
    const runs = f.db.prepare("SELECT run_after, payload FROM jobs ORDER BY rowid").all() as Array<{ run_after: string; payload: string }>;
    expect(runs).toHaveLength(3);
    expect(runs.map(row => JSON.parse(row.payload).snapshot.selected.length)).toEqual([50, 50, 1]);
    expect(runs.map(row => row.run_after)).toEqual(["2030-01-01T00:00:00.000Z", "2030-01-01T00:05:00.000Z", "2030-01-01T00:10:00.000Z"]);
  });
});

describe("read commands and ratification", () => {
  it("lists standing decisions and topic candidates through the real engine", async () => {
    const f = setup(); const id = seed(f.db, { text: "Use SQLite" });
    expect(await decisions([], f.deps)).toBe(0); expect(f.output()).toContain(id);
    expect(await decisions(["--topic", "storage"], f.deps)).toBe(0); expect(f.output()).toContain("Use SQLite");
  });
  it("--unpublished shows every row beyond the standing engine cap", async () => {
    const f = setup(); for (let i = 0; i < 65; i++) seed(f.db, { id: `decision-${i}` });
    await decisions(["--unpublished"], f.deps);
    expect(f.output()).toContain("All decisions are unpublished"); expect(f.output()).toContain("decision-64");
    expect(f.output().split("\n")).toHaveLength(67);
  });
  it("plain listing does not build a runtime", async () => {
    const f = setup(); const runtime = vi.fn(() => { throw new Error("unavailable"); });
    expect(await decisions([], { ...f.deps, runtime })).toBe(0); expect(runtime).not.toHaveBeenCalled();
  });
  it("show prints full decisions and notes", async () => {
    const f = setup(); const id = seed(f.db, { text: "Use SQLite", provenance: "distilled" });
    expect(await show([id], f.deps)).toBe(0); expect(f.output()).toContain('"decision_text": "Use SQLite"');
    const row = f.db.prepare("SELECT note_id FROM decisions WHERE id = ?").get(id) as { note_id: string };
    expect(await show([row.note_id], f.deps)).toBe(0); expect(f.output()).toContain('"compacted_text": "note"');
  });
  it("check and search print ranked candidates from seeded vectors", async () => {
    const f = setup(); const id = seed(f.db, { text: "Use SQLite" });
    expect(await check(["Use SQLite"], f.deps)).toBe(0); expect(f.output()).toContain(id); expect(rows(f.db, "receipts")).toHaveLength(1);
    f.out.mockClear(); expect(await search(["storage"], f.deps)).toBe(0); expect(f.output()).toContain(`1. ${id}\t1.000\tUse SQLite`);
  });
  it.each([[decisions, [], "No standing decisions found"], [show, ["missing"], "No decision or note found"],
    [check, ["hello"], "No conflicting decision found"], [search, ["hello"], "No results found"]] as const)("empty read output is successful", async (run, args, text) => {
    const f = setup(); expect(await run([...args], f.deps)).toBe(0); expect(f.output()).toContain(text);
  });
  it("decide ratifies verbatim human consent, reason and topic, then merges", async () => {
    const f = setup(); const text = "  Use SQLite for local storage.  ";
    expect(await decide([text, "--reason", "Local first", "--topic", "storage"], f.deps)).toBe(0);
    expect(rows(f.db, "decisions")[0]).toMatchObject({ provenance: "ratified", human_quote: text, decision_text: text, reason: "Local first", topic: "storage" });
    expect(f.output()).toContain("created"); await decide([text], f.deps); expect(f.output()).toContain("merged");
    expect(rows(f.db, "decisions")).toHaveLength(1);
  });
  it.each([[], [""], ["   "], ["text", "--typo"], ["text", "--reason"], ["text", "--topic", "x", "--topic", "y"]])("decide rejects malformed input %j", async (...args) => {
    const f = setup(); expect(await decide(args, f.deps)).toBe(1); expect(rows(f.db, "decisions")).toHaveLength(0);
    expect(f.err.mock.calls[0]?.[0]).toContain("Usage:");
  });
  it("engine errors are surfaced instead of becoming empty results", async () => {
    const f = setup(); await expect(check(["x"], { ...f.deps, check: async () => ({ candidates: [], error: "embedding failed" }) })).rejects.toThrow("embedding failed");
    await expect(search(["x"], { ...f.deps, search: async () => ({ results: [], error: "search failed" }) })).rejects.toThrow("search failed");
  });
});

it("sync retries dead letters then drains and prints real before/after counts", async () => {
  const f = setup(); enqueueJob(f.db, "backfill", {}); failJob(f.db, claimNext(f.db)!, "dead", { fatal: true });
  expect(await sync(["--retry-failed"], { ...f.deps, drainOptions: { dispatch: async (db, claim) => ({ status: completeJob(db, claim) ? "done" : "stale" }) } })).toBe(0);
  expect(f.output()).toContain('"failed":1'); expect(f.output()).toContain('"done":1'); expect(f.output()).toContain("Requeued 1 failed jobs");
});
it("status reports database, queue, embedder, backend, hook and parse errors", async () => {
  const f = setup(); await connect(["--no-backfill"], f.deps); enqueueJob(f.db, "distill", {});
  f.db.transaction(() => setMeta(f.db, "parse_errors", '{"transcript":{"count":2,"lastBadOffset":10}}'))();
  await status([], { ...f.deps, loadConfig: () => ({ chat: { backend: "claude" } }) });
  expect(f.output()).toContain(f.db.name); expect(f.output()).toContain('"queued":1'); expect(f.output()).toContain("Undistilled captures: 0");
  expect(f.output()).toContain("text-embedding-3-small"); expect(f.output()).toContain("Backend: claude"); expect(f.output()).toContain("Stop hook: installed"); expect(f.output()).toContain('"count":2');
});
it("MCP delegates to its transport without human stdout", async () => {
  const f = setup(); const serve = vi.fn(async () => undefined);
  expect(await mcp([], { ...f.deps, serve })).toBe(0); expect(serve).toHaveBeenCalledOnce(); expect(f.out).not.toHaveBeenCalled();
});
it("ordinary command invocations opportunistically drain and detach", async () => {
  const f = setup(); for (let i = 0; i < 6; i++) enqueueJob(f.db, "backfill", {});
  await show(["missing"], { ...f.deps, opportunistic: true, drainOptions: { dispatch: async (db, claim) => ({ status: completeJob(db, claim) ? "done" : "stale" }) } });
  expect(queueCounts(f.db).done).toBe(5); expect(f.spawn).toHaveBeenCalledOnce();
});

it("MCP opportunistic drain reports partial work on stderr only", async () => {
  const f = setup(); enqueueJob(f.db, "backfill", {});
  const serve = vi.fn(async () => undefined);
  await mcp([], { ...f.deps, serve, opportunistic: true, drainOptions: { dispatch: async (db, claim) => {
    completeJob(db, claim); return { status: "done", warnings: ["1 malformed transcript record"] };
  } } });
  expect(f.out).not.toHaveBeenCalled(); expect(serve).toHaveBeenCalledOnce();
  expect(f.err.mock.calls.some(call => call[0].includes("partial work: 1 malformed transcript record"))).toBe(true);
});
