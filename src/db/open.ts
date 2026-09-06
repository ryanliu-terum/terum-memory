import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { defaultDbPath } from "./paths.js";
import { ensureTerumDir, enforceFileModes, type WarnFn } from "./permissions.js";

export type Db = Database.Database;

const SCHEMA_VERSION = "1";

export interface OpenOptions {
  dbPath?: string;
  warn?: WarnFn;
}

/**
 * Open (creating + migrating if needed) the terum-memory database.
 * Every CLI/MCP entrypoint comes through here, so the permission contract
 * is re-checked on every open.
 */
export function openDb(options: OpenOptions = {}): Db {
  const file = options.dbPath ?? defaultDbPath();
  const warn = options.warn ?? console.warn;
  ensureTerumDir(path.dirname(file), warn);

  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  sqliteVec.load(db);
  migrate(db);
  enforceFileModes([file, `${file}-wal`, `${file}-shm`], warn);
  return db;
}

function migrate(db: Db): void {
  const hasMeta = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
    .get();
  if (!hasMeta) {
    const schema = fs.readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
    const apply = db.transaction(() => {
      db.exec(schema);
      const now = new Date().toISOString();
      const insert = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
      insert.run("schema_version", SCHEMA_VERSION);
      insert.run("created_at", now);
    });
    apply();
    return;
  }
  const version = getMeta(db, "schema_version");
  if (version !== SCHEMA_VERSION) {
    throw new Error(
      `unsupported schema_version ${String(version)} (this build supports ${SCHEMA_VERSION})`,
    );
  }
}

export function getMeta(db: Db, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

/**
 * Created by `init` once the embedder (and so the vector dimension) is locked —
 * the static schema deliberately excludes the vec virtual tables.
 */
export function createVecTables(db: Db, dim: number): void {
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new Error(`invalid embedding dimension: ${dim}`);
  }
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS note_vec USING vec0(note_id TEXT PRIMARY KEY, embedding float[${dim}]);
     CREATE VIRTUAL TABLE IF NOT EXISTS decision_vec USING vec0(decision_id TEXT PRIMARY KEY, embedding float[${dim}]);`,
  );
}
