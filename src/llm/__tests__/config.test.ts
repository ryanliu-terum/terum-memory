import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, saveConfig, type TerumConfig } from "../config.js";

let dir: string;
let home: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "terum-config-"));
  home = path.join(dir, "home");
  file = path.join(home, "config.json");
  vi.stubEnv("TERUM_HOME", home);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("chat config", () => {
  it("loads missing config without creating the home", () => {
    expect(loadConfig()).toEqual({});
    expect(fs.existsSync(home)).toBe(false);
  });

  it("round-trips pretty JSON and only the key variable name", () => {
    vi.stubEnv("TEST_CONFIG_KEY", "secret-never-persisted");
    const config: TerumConfig = { chat: { backend: "openai-compatible", base_url: "https://example.test/v1", model: "test-model", api_key_env: "TEST_CONFIG_KEY" } };
    saveConfig(config);
    expect(loadConfig()).toEqual(config);
    expect(fs.readFileSync(file, "utf8")).toBe(`${JSON.stringify(config, null, 2)}\n`);
    expect(fs.readFileSync(file, "utf8")).not.toContain("secret-never-persisted");
    saveConfig({});
    expect(loadConfig()).toEqual({});
  });

  it.skipIf(process.platform === "win32")("creates and repairs private directory and file permissions", () => {
    saveConfig({});
    expect(fs.statSync(home).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    fs.chmodSync(home, 0o755);
    fs.chmodSync(file, 0o644);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    loadConfig();
    expect(fs.statSync(home).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(warning).toHaveBeenCalledTimes(2);
  });

  it("names corrupt JSON's path without echoing its contents or overwriting it", () => {
    saveConfig({});
    fs.writeFileSync(file, '{"secret-value":');
    expect(loadConfig).toThrow(file);
    expect(loadConfig).toThrow("Unparseable JSON");
    try { loadConfig(); } catch (error) { expect(String(error)).not.toContain("secret-value"); }
    expect(fs.readFileSync(file, "utf8")).toBe('{"secret-value":');
  });

  it("preserves the previous config and removes the private temp on rename failure", () => {
    saveConfig({ chat: { backend: "claude" } });
    vi.spyOn(fs, "renameSync").mockImplementation((oldPath) => {
      if (process.platform !== "win32") expect(fs.statSync(oldPath).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(file, "utf8")).toContain("claude");
      throw new Error("simulated rename failure");
    });
    expect(() => saveConfig({ chat: { backend: "codex" } })).toThrow("atomically save");
    expect(loadConfig()).toEqual({ chat: { backend: "claude" } });
    expect(fs.readdirSync(home)).toEqual(["config.json"]);
  });

  it.each([
    { api_key: "accidental-secret" },
    { chat: { backend: "claude", api_key: "accidental-secret" } },
    { chat: { backend: "claude", unexpected: { token: "accidental-secret" } } },
  ])("rejects unexpected fields before writing secrets: %#", (input) => {
    saveConfig({});
    expect(() => saveConfig(input as TerumConfig)).toThrow("unsupported fields");
    try { saveConfig(input as TerumConfig); } catch (error) { expect(String(error)).not.toContain("accidental-secret"); }
    expect(fs.readFileSync(file, "utf8")).toBe("{}\n");
    expect(fs.readdirSync(home)).toEqual(["config.json"]);
  });

  it.each([null, [], 17, { chat: null }, { chat: [] }, { chat: { backend: "constructor" } },
    { chat: { backend: "codex", model: 12 } }, { chat: { backend: "ollama", api_key_env: "sk-raw-secret" } },
    { chat: { backend: "claude", model: "  " } }])("rejects malformed parsed config without echoing data: %#", (input) => {
    saveConfig({});
    fs.writeFileSync(file, JSON.stringify(input));
    expect(loadConfig).toThrow(`Invalid config at ${file}`);
  });
});
