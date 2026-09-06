import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { terumHome } from "../db/paths.js";
import { ensureTerumDir, enforceFileModes } from "../db/permissions.js";

export interface ChatConfig {
  backend: "openai-compatible" | "ollama" | "claude" | "codex" | "gemini";
  base_url?: string;
  model?: string;
  api_key_env?: string;
}

export interface TerumConfig { chat?: ChatConfig; }

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reject extra properties without echoing names or values that might be secrets. */
function validatedConfig(value: unknown): TerumConfig {
  const invalid = (): never => { throw new Error("Invalid terum config: unsupported fields or values"); };
  if (!object(value) || Object.keys(value).some((key) => key !== "chat")) return invalid();
  if (value.chat === undefined) return {};
  const chat = value.chat;
  if (!object(chat) || Object.keys(chat).some((key) =>
    !["backend", "base_url", "model", "api_key_env"].includes(key))) return invalid();
  if (typeof chat.backend !== "string" ||
    !["openai-compatible", "ollama", "claude", "codex", "gemini"].includes(chat.backend)) return invalid();
  const result: ChatConfig = { backend: chat.backend as ChatConfig["backend"] };
  for (const key of ["base_url", "model", "api_key_env"] as const) {
    const field = chat[key];
    if (field !== undefined) {
      if (typeof field !== "string" || !field.trim()) return invalid();
      result[key] = field;
    }
  }
  if (result.api_key_env !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(result.api_key_env)) return invalid();
  return { chat: result };
}

export function loadConfig(): TerumConfig {
  const dir = terumHome();
  const file = path.join(dir, "config.json");
  let contents: string;
  try {
    // A missing config is read-only: do not create the home just to return {}.
    if (fs.existsSync(dir)) ensureTerumDir(dir);
    enforceFileModes([file]);
    contents = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Could not read config at ${file}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    // SyntaxError can quote the original input, including accidental secrets.
    throw new Error(`Unparseable JSON in config at ${file}`);
  }
  try {
    return validatedConfig(value);
  } catch {
    throw new Error(`Invalid config at ${file}: unsupported fields or values`);
  }
}

export function saveConfig(config: TerumConfig): void {
  const contents = `${JSON.stringify(validatedConfig(config), null, 2)}\n`;
  const dir = terumHome();
  const file = path.join(dir, "config.json");
  ensureTerumDir(dir);
  enforceFileModes([file]);
  const temp = path.join(dir, `.config-${randomUUID()}.tmp`);
  let created = false;
  try {
    const fd = fs.openSync(temp, "wx", 0o600);
    created = true;
    try {
      enforceFileModes([temp]);
      fs.writeFileSync(fd, contents, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, file);
    created = false;
  } catch {
    // Do not propagate filesystem errors that could contain caller-supplied data.
    throw new Error(`Could not atomically save config at ${file}`);
  } finally {
    if (created) {
      try {
        fs.unlinkSync(temp);
      } catch {
        throw new Error(`Could not clean up temporary config at ${temp}`);
      }
    }
  }
}
