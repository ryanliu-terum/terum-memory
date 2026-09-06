import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../open.js";

const posixOnly = process.platform === "win32" ? describe.skip : describe;

let dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "terum-perm-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

posixOnly("filesystem permission contract", () => {
  it("creates the data dir 0700 and the db 0600", () => {
    const parent = tempDir();
    const dataDir = path.join(parent, ".terum");
    const dbPath = path.join(dataDir, "terum.db");
    const db = openDb({ dbPath, warn: () => {} });
    db.close();
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
  });

  it("repairs loosened modes on reopen and warns", () => {
    const parent = tempDir();
    const dataDir = path.join(parent, ".terum");
    const dbPath = path.join(dataDir, "terum.db");
    openDb({ dbPath, warn: () => {} }).close();

    chmodSync(dataDir, 0o755);
    chmodSync(dbPath, 0o644);
    const warnings: string[] = [];
    const db = openDb({ dbPath, warn: (message) => warnings.push(message) });
    db.close();

    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    expect(warnings.some((w) => w.includes("repaired permissions"))).toBe(true);
  });
});
