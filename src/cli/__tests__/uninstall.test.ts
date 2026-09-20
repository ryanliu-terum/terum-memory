import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installClaudeCodeConfig } from "../../connect/config-edit.js";
import { openDb } from "../../db/open.js";
import { run as uninstall } from "../commands/uninstall.js";
import type { CommandDeps } from "../commands/shared.js";

const HOOK = "terum-memory hook stop";
let root: string;
let home: string;
let dbPath: string;
let deps: CommandDeps;
let out: ReturnType<typeof vi.fn<(text: string) => void>>;
let err: ReturnType<typeof vi.fn<(text: string) => void>>;
let sidecars: string[];
let markedModel: string;
let unmarkedModel: string;
let savedHome: string | undefined;

const output = (): string => out.mock.calls.map(call => call[0]).join("\n");
const exists = (file: string): boolean => fs.existsSync(file);
const settings = (): string => fs.readFileSync(deps.settingsPath!, "utf8");

beforeEach(() => {
  savedHome = process.env.TERUM_HOME;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "terum-uninstall-"));
  home = path.join(root, "home");
  process.env.TERUM_HOME = home;
  dbPath = path.join(home, "terum.db");
  openDb({ dbPath, warn: () => undefined }).close();
  fs.writeFileSync(path.join(home, "config.json"), "{}\n", { mode: 0o600 });
  fs.writeFileSync(path.join(home, "worker.lock"), JSON.stringify({ pid: 1, token: "t" }), { mode: 0o600 });
  markedModel = path.join(home, "models", "marked");
  unmarkedModel = path.join(home, "models", "unmarked");
  fs.mkdirSync(path.join(markedModel, "onnx"), { recursive: true });
  fs.mkdirSync(unmarkedModel, { recursive: true });
  fs.writeFileSync(path.join(markedModel, ".installed.json"), JSON.stringify({ id: "marked", revision: "r", sha256: "s" }));
  fs.writeFileSync(path.join(markedModel, "onnx", "model.onnx"), "weights");
  fs.writeFileSync(path.join(unmarkedModel, "partial.onnx"), "half");
  const projects = path.join(root, "projects");
  fs.mkdirSync(path.join(projects, "proj"), { recursive: true });
  const transcripts = [path.join(projects, "root.jsonl"), path.join(projects, "proj", "a.jsonl")];
  sidecars = transcripts.map(file => `${file}.terum-offset`);
  for (const file of transcripts) fs.writeFileSync(file, "{}\n");
  for (const file of sidecars) fs.writeFileSync(file, JSON.stringify({ offset: 3 }));
  fs.writeFileSync(path.join(projects, "proj", "notes.txt.terum-offset"), "orphan-lookalike");
  out = vi.fn<(text: string) => void>();
  err = vi.fn<(text: string) => void>();
  deps = { dbPath, projectsDir: projects, settingsPath: path.join(root, "claude", "settings.json"),
    mcpConfigPath: path.join(root, "claude.json"), out, err, opportunistic: false, loadConfig: () => ({}), spawn: () => false };
  installClaudeCodeConfig(deps);
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.TERUM_HOME; else process.env.TERUM_HOME = savedHome;
  fs.rmSync(root, { recursive: true, force: true });
});

function insertRunningJob(leaseUntil: string): void {
  const db = openDb({ dbPath, warn: () => undefined });
  try {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO jobs (id, kind, payload, status, attempts, lease_until, created_at, updated_at)
      VALUES ('job-1', 'distill', '{}', 'running', 1, ?, ?, ?)`).run(leaseUntil, now, now);
  } finally { db.close(); }
}

/** Leave a non-empty -wal on disk as a crash would: written with autocheckpoint off, restored after close. */
function stageUncheckpointedWal(): void {
  const wal = `${dbPath}-wal`;
  const db = openDb({ dbPath, warn: () => undefined });
  let frames: Buffer;
  try {
    db.pragma("wal_autocheckpoint = 0");
    db.prepare("INSERT INTO meta (key, value) VALUES ('purge-test', 'staged')").run();
    frames = fs.readFileSync(wal);
  } finally { db.close(); }
  expect(frames.length).toBeGreaterThan(0);
  if (!exists(wal)) fs.writeFileSync(wal, frames, { mode: 0o600 });
  expect(fs.statSync(wal).size).toBeGreaterThan(0);
}

function expectDataIntact(): void {
  expect(exists(dbPath)).toBe(true);
  expect(exists(path.join(home, "config.json"))).toBe(true);
  expect(exists(path.join(home, "worker.lock"))).toBe(true);
  for (const file of sidecars) expect(exists(file)).toBe(true);
  expect(exists(markedModel)).toBe(true);
}

function expectOwnedGone(): void {
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, path.join(home, "config.json"), path.join(home, "worker.lock"), ...sidecars, markedModel]) {
    expect(exists(file), file).toBe(false);
  }
  expect(exists(unmarkedModel)).toBe(true);
  expect(exists(path.join(unmarkedModel, "partial.onnx"))).toBe(true);
  expect(exists(path.join(deps.projectsDir!, "proj", "notes.txt.terum-offset"))).toBe(true);
  expect(exists(path.join(deps.projectsDir!, "proj", "a.jsonl"))).toBe(true);
  expect(settings()).not.toContain(HOOK);
  expect(fs.readFileSync(deps.mcpConfigPath!, "utf8")).not.toContain('"terum-memory"');
}

describe("uninstall", () => {
  it("plain uninstall removes the integration, keeps every data file, and points at --purge", async () => {
    expect(settings()).toContain(HOOK);
    expect(await uninstall([], deps)).toBe(0);
    expect(settings()).not.toContain(HOOK);
    expectDataIntact();
    expect(output()).toContain(`Data remains under ${home}`);
    expect(output()).toContain("terum-memory uninstall --purge");
  });

  it("rejects unknown flags before touching anything", async () => {
    expect(await uninstall(["--purge", "--force"], deps)).toBe(1);
    expect(err.mock.calls[0]?.[0]).toContain("Usage: terum-memory uninstall [--purge]");
    expect(settings()).toContain(HOOK);
    expectDataIntact();
  });

  it("--purge refuses while a job holds a live lease and deletes nothing", async () => {
    insertRunningJob(new Date(Date.now() + 10 * 60_000).toISOString());
    expect(await uninstall(["--purge"], deps)).toBe(1);
    expectDataIntact();
    expect(exists(unmarkedModel)).toBe(true);
    expect(output()).toMatch(/1 job\(s\) hold a live lease.*worker is still running/);
    expect(output()).toContain("terum-memory status");
    // The integration was already removed (the ruling's ordering), so a rerun after the worker finishes completes.
    expect(settings()).not.toContain(HOOK);
  });

  it("--purge with a planted non-owned file removes the owned set, including an uncheckpointed WAL, and keeps the home", async () => {
    stageUncheckpointedWal();
    const keep = path.join(home, "keep.txt");
    fs.writeFileSync(keep, "mine");
    expect(await uninstall(["--purge"], deps)).toBe(0);
    expectOwnedGone();
    expect(exists(keep)).toBe(true);
    expect(exists(home)).toBe(true);
    expect(exists(path.join(home, "models"))).toBe(true);
    const text = output();
    expect(text).toContain("Claude Code integration removed.");
    expect(text).toContain(`Removed ${dbPath}`);
    expect(text).toContain(`Removed ${markedModel}`);
    for (const file of sidecars) expect(text).toContain(`Removed ${file}`);
    expect(text).toContain(`Kept ${home}`);
    expect(text).toContain(keep);
    expect(text).toContain(unmarkedModel);
    expect(text.split("\n")).not.toContain(`Removed ${home}`);
  });

  it("--purge removes the home directory once only owned files remained", async () => {
    stageUncheckpointedWal();
    fs.rmSync(unmarkedModel, { recursive: true });
    expect(await uninstall(["--purge"], deps)).toBe(0);
    expect(exists(dbPath)).toBe(false);
    expect(exists(home)).toBe(false);
    expect(exists(root)).toBe(true);
    for (const file of sidecars) expect(exists(file)).toBe(false);
    expect(output()).toContain(`Removed ${path.join(home, "models")}`);
    expect(output()).toContain(`Removed ${home}`);
    expect(output()).not.toContain("Kept");
  });

  it("--purge reruns idempotently after a complete wipe", async () => {
    fs.rmSync(unmarkedModel, { recursive: true });
    expect(await uninstall(["--purge"], deps)).toBe(0);
    expect(exists(home)).toBe(false);
    out.mockClear();
    expect(await uninstall(["--purge"], deps)).toBe(0);
    expect(output()).toContain("Nothing to remove");
    expect(output()).not.toContain("Removed ");
    expect(exists(home)).toBe(false);
    expect(exists(dbPath)).toBe(false);
  });

  it("--purge finishes a wipe that a previous run left half-done", async () => {
    // Simulate a crash between unlinking the database and the rest of the owned set.
    fs.unlinkSync(dbPath);
    expect(await uninstall(["--purge"], deps)).toBe(0);
    expectOwnedGone();
    expect(output()).not.toContain(`Removed ${dbPath}`);
    expect(output()).toContain(`Removed ${path.join(home, "config.json")}`);
  });

  it("an expired lease is not live and does not block --purge", async () => {
    insertRunningJob(new Date(Date.now() - 60_000).toISOString());
    expect(await uninstall(["--purge"], deps)).toBe(0);
    expectOwnedGone();
  });

  it("a queued job that never held a lease does not block --purge", async () => {
    const db = openDb({ dbPath, warn: () => undefined });
    try {
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO jobs (id, kind, payload, status, created_at, updated_at)
        VALUES ('job-q', 'distill', '{}', 'queued', ?, ?)`).run(now, now);
    } finally { db.close(); }
    expect(await uninstall(["--purge"], deps)).toBe(0);
    expect(exists(dbPath)).toBe(false);
  });
});
