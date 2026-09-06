import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installClaudeCodeConfig, uninstallClaudeCodeConfig } from "../config-edit.js";

let dir: string;
let opts: { settingsPath: string; mcpConfigPath: string };
const hook = { hooks: [{ type: "command", command: "terum-memory hook stop" }] };
const server = { command: "terum-memory", args: ["mcp"], type: "stdio" };
const read = (file: string): string => fs.readFileSync(file, "utf8");
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
  opts = { settingsPath: path.join(dir, "settings.json"), mcpConfigPath: path.join(dir, "mcp.json") };
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("Claude Code config ownership", () => {
  it("preserves unrelated tokens and restores populated files byte-for-byte on uninstall", () => {
    const settings = '{\n  "model": "a\\u0062", "number": 1e+02, "hooks": {"Start":[], "Stop": [\n    { "hooks": [{"type":"command", "command":"echo terum-memory hook stop"}] }\n  ]}\n}\n';
    const mcp = '{ "unknown": {"escaped":"quote: \\\"; bracket: }"}, "mcpServers": {\n "terum-memory-custom" : {"command": "terum-memory"}, "other": {"command":"other","args":[]}\n} }\n';
    fs.writeFileSync(opts.settingsPath, settings, { mode: 0o640 });
    fs.writeFileSync(opts.mcpConfigPath, mcp, { mode: 0o644 });
    installClaudeCodeConfig(opts);
    const installedSettings = read(opts.settingsPath);
    const installedMcp = read(opts.mcpConfigPath);
    expect(JSON.parse(installedSettings).hooks.Stop).toContainEqual(hook);
    expect(JSON.parse(installedMcp).mcpServers["terum-memory"]).toEqual(server);
    expect(installedSettings).toContain('"model": "a\\u0062", "number": 1e+02');
    expect(fs.statSync(opts.settingsPath).mode & 0o777).toBe(0o640);
    expect(fs.statSync(opts.mcpConfigPath).mode & 0o777).toBe(0o644);
    const rename = vi.spyOn(fs, "renameSync");
    installClaudeCodeConfig(opts);
    expect(rename).not.toHaveBeenCalled();
    expect(read(opts.settingsPath)).toBe(installedSettings);
    expect(read(opts.mcpConfigPath)).toBe(installedMcp);
    uninstallClaudeCodeConfig(opts);
    expect(read(opts.settingsPath)).toBe(settings);
    expect(read(opts.mcpConfigPath)).toBe(mcp);
    rename.mockClear();
    uninstallClaudeCodeConfig(opts);
    expect(rename).not.toHaveBeenCalled();
  });

  it("creates missing parent dirs and files privately, while uninstall of missing paths is a no-op", () => {
    opts.settingsPath = path.join(dir, "new", "settings.json");
    uninstallClaudeCodeConfig(opts);
    expect(fs.existsSync(path.dirname(opts.settingsPath))).toBe(false);
    expect(fs.existsSync(opts.mcpConfigPath)).toBe(false);
    installClaudeCodeConfig(opts);
    expect(fs.statSync(path.dirname(opts.settingsPath)).mode & 0o777).toBe(0o700);
    for (const file of Object.values(opts)) expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(read(opts.settingsPath))).toEqual({ hooks: { Stop: [hook] } });
    expect(JSON.parse(read(opts.mcpConfigPath))).toEqual({ mcpServers: { "terum-memory": server } });
    uninstallClaudeCodeConfig(opts);
    expect(JSON.parse(read(opts.settingsPath))).toEqual({ hooks: { Stop: [] } });
    expect(JSON.parse(read(opts.mcpConfigPath))).toEqual({ mcpServers: {} });
  });

  it("adds absent containers without modifying other top-level values", () => {
    fs.writeFileSync(opts.settingsPath, '{"hooks":{"Start": []}, "theme": "dark"}');
    fs.writeFileSync(opts.mcpConfigPath, '{"user": { "enabled": true }}');
    installClaudeCodeConfig(opts);
    expect(read(opts.settingsPath)).toContain('"Start": []');
    expect(read(opts.mcpConfigPath)).toContain('"user": { "enabled": true }');
  });

  it.each([
    { command: "different", args: ["mcp"], type: "stdio" },
    { ...server, env: { EXTRA: "value" } },
    null,
  ])("refuses an exact MCP key with noncanonical value %j before touching either file", value => {
    const settings = '{"safe":true}';
    const mcp = JSON.stringify({ mcpServers: { "terum-memory": value } });
    fs.writeFileSync(opts.settingsPath, settings);
    fs.writeFileSync(opts.mcpConfigPath, mcp);
    expect(() => installClaudeCodeConfig(opts)).toThrow(/Collision.*terum-memory/);
    expect(read(opts.settingsPath)).toBe(settings);
    expect(read(opts.mcpConfigPath)).toBe(mcp);
    uninstallClaudeCodeConfig(opts);
    expect(read(opts.mcpConfigPath)).toBe(mcp);
  });

  it.each([
    { ...hook, matcher: "" },
    { hooks: [{ type: "command", command: " terum-memory hook stop " }] },
    { hooks: [...hook.hooks, { type: "command", command: "mine" }] },
    { command: "terum-memory hook stop" },
  ])("refuses noncanonical exact hook commands and preserves them on uninstall: %j", value => {
    const settings = JSON.stringify({ hooks: { Stop: [value] } });
    fs.writeFileSync(opts.settingsPath, settings);
    expect(() => installClaudeCodeConfig(opts)).toThrow(/Collision/);
    expect(read(opts.settingsPath)).toBe(settings);
    expect(fs.existsSync(opts.mcpConfigPath)).toBe(false);
    uninstallClaudeCodeConfig(opts);
    expect(read(opts.settingsPath)).toBe(settings);
  });

  it.each(["settingsPath", "mcpConfigPath"] as const)("refuses malformed %s and names it without modifying either file", key => {
    fs.writeFileSync(opts.settingsPath, '{"unrelated": true}');
    fs.writeFileSync(opts.mcpConfigPath, '{"unrelated": true}');
    fs.writeFileSync(opts[key], '{"unfinished":');
    const before = Object.values(opts).map(read);
    expect(() => installClaudeCodeConfig(opts)).toThrow(opts[key]);
    expect(() => uninstallClaudeCodeConfig(opts)).toThrow(opts[key]);
    expect(Object.values(opts).map(read)).toEqual(before);
  });

  it.each(['null', '[]', '{"hooks":null}', '{"hooks":{"Stop":{}}}', '{"hooks":{},"hooks":{}}'])("refuses unsafe settings shapes %s", settings => {
    fs.writeFileSync(opts.settingsPath, settings);
    expect(() => installClaudeCodeConfig(opts)).toThrow(opts.settingsPath);
    expect(read(opts.settingsPath)).toBe(settings);
  });

  it("accepts canonical object values regardless of key ordering", () => {
    const settings = '{"hooks":{"Stop":[{"hooks":[{"command":"terum-memory hook stop","type":"command"}]}]}}';
    const mcp = '{"mcpServers":{"terum-memory":{"type":"stdio","args":["mcp"],"command":"terum-memory"}}}';
    fs.writeFileSync(opts.settingsPath, settings);
    fs.writeFileSync(opts.mcpConfigPath, mcp);
    installClaudeCodeConfig(opts);
    expect(read(opts.settingsPath)).toBe(settings);
    expect(read(opts.mcpConfigPath)).toBe(mcp);
  });

  it.each([0, 1, 2])("removes only canonical entries at array position %s", position => {
    const others = [{ hooks: [{ command: "terum-memory hook stop --custom" }] }, { hooks: [{ command: "echo ok" }] }];
    const entries: unknown[] = [...others];
    entries.splice(position, 0, hook);
    fs.writeFileSync(opts.settingsPath, JSON.stringify({ hooks: { Stop: entries } }));
    uninstallClaudeCodeConfig(opts);
    expect(JSON.parse(read(opts.settingsPath)).hooks.Stop).toEqual(others);
  });

  it("removes repeated canonical entries without deleting adjacent unrelated entries", () => {
    fs.writeFileSync(opts.settingsPath, JSON.stringify({ hooks: { Stop: [hook, hook, { unrelated: true }, hook] } }));
    uninstallClaudeCodeConfig(opts);
    expect(JSON.parse(read(opts.settingsPath)).hooks.Stop).toEqual([{ unrelated: true }]);
  });

  it("leaves original config intact and cleans temporary files when rename fails", () => {
    fs.writeFileSync(opts.settingsPath, '{}');
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw new Error("rename failure"); });
    expect(() => installClaudeCodeConfig(opts)).toThrow("rename failure");
    expect(read(opts.settingsPath)).toBe('{}');
    expect(fs.readdirSync(dir)).toEqual(["settings.json"]);
  });
});
