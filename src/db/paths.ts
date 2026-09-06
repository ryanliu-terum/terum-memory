import os from "node:os";
import path from "node:path";

/**
 * Home for everything terum-memory owns: the db, WAL/SHM sidecars, downloaded
 * models, config. `TERUM_HOME` overrides for tests and sandboxes only.
 */
export function terumHome(): string {
  return process.env.TERUM_HOME ?? path.join(os.homedir(), ".terum");
}

export function defaultDbPath(): string {
  return path.join(terumHome(), "terum.db");
}

export function modelsDir(): string {
  return path.join(terumHome(), "models");
}
