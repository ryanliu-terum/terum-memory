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

  const userHook = { type: "command", command: "mine" };
  const noncanonical: Array<{ value: unknown; after: unknown[] }> = [
    { value: { ...hook, matcher: "" }, after: [] },
    { value: { matcher: "", timeout: 5, hooks: hook.hooks }, after: [] },
    { value: { hooks: [{ type: "command", command: " terum-memory hook stop " }] }, after: [] },
    { value: { hooks: [{ command: "terum-memory hook stop" }] }, after: [] },
    { value: { hooks: [...hook.hooks, userHook] }, after: [{ hooks: [userHook] }] },
    { value: { matcher: "x", hooks: [userHook, ...hook.hooks, userHook] }, after: [{ matcher: "x", hooks: [userHook, userHook] }] },
    { value: { hooks: [...hook.hooks, ...hook.hooks, userHook] }, after: [{ hooks: [userHook] }] },
    { value: { command: "terum-memory hook stop" }, after: [] },
    { value: { command: " terum-memory hook stop ", matcher: "" }, after: [] },
  ];

  it.each(noncanonical)("connect refuses noncanonical exact hook commands without touching either file: $value", ({ value }) => {
    const settings = JSON.stringify({ hooks: { Stop: [value] } });
    fs.writeFileSync(opts.settingsPath, settings);
    expect(() => installClaudeCodeConfig(opts)).toThrow(/Collision/);
    expect(read(opts.settingsPath)).toBe(settings);
    expect(fs.existsSync(opts.mcpConfigPath)).toBe(false);
  });

  it.each(noncanonical)("uninstall removes hook objects keyed on the command, keeping user hooks: $value", ({ value, after }) => {
    fs.writeFileSync(opts.settingsPath, JSON.stringify({ hooks: { Stop: [value] } }));
    uninstallClaudeCodeConfig(opts);
    expect(JSON.parse(read(opts.settingsPath)).hooks.Stop).toEqual(after);
    expect(fs.existsSync(opts.mcpConfigPath)).toBe(false);
  });

  it.each([
    "terum-memory hook stop --custom",
    "echo terum-memory hook stop",
    "terum-memory hook stop;",
    "terum-memory  hook stop",
    "TERUM-MEMORY HOOK STOP",
    "terum-memory hook",
    "npx terum-memory hook stop",
  ])("uninstall never touches lookalike command %j", command => {
    const entries = [{ hooks: [{ type: "command", command }] }, { command }, { matcher: "", hooks: [{ command }, userHook] }];
    const settings = JSON.stringify({ hooks: { Stop: entries } });
    fs.writeFileSync(opts.settingsPath, settings);
    uninstallClaudeCodeConfig(opts);
    expect(read(opts.settingsPath)).toBe(settings);
  });

  it("uninstall ignores non-object entries and non-string or non-array shapes around our command", () => {
    const entries = [null, 1, "terum-memory hook stop", ["terum-memory hook stop"],
      { hooks: "terum-memory hook stop" }, { hooks: { command: "terum-memory hook stop" } },
      { command: ["terum-memory hook stop"] }, { hooks: [null, "terum-memory hook stop", { command: 1 }] }];
    const settings = JSON.stringify({ hooks: { Stop: entries } });
    fs.writeFileSync(opts.settingsPath, settings);
    uninstallClaudeCodeConfig(opts);
    expect(read(opts.settingsPath)).toBe(settings);
  });

  it("uninstall removes a hand-edited entry span-wise, leaving surrounding tokens byte-for-byte", () => {
    const before = '{\n  "model": "a\\u0062", "hooks": {"Start":[], "Stop": [\n    {"matcher": "",  "timeout": 5, "hooks": [ {"type":"command", "command":"terum-memory hook stop"} ]},\n    { "hooks": [{"type":"command", "command":"echo terum-memory hook stop"}] }\n  ]},\n  "number": 1e+02\n}\n';
    const after = '{\n  "model": "a\\u0062", "hooks": {"Start":[], "Stop": [\n    { "hooks": [{"type":"command", "command":"echo terum-memory hook stop"}] }\n  ]},\n  "number": 1e+02\n}\n';
    fs.writeFileSync(opts.settingsPath, before);
    uninstallClaudeCodeConfig(opts);
    expect(read(opts.settingsPath)).toBe(after);
  });

  it("uninstall removes only our hook object inside a mixed entry, leaving surrounding tokens byte-for-byte", () => {
    const before = '{"hooks":{"Stop":[ {"matcher": "Bash", "hooks": [ {"command":"mine"} ,{"type":"command","command":" terum-memory hook stop "}, {"command": "theirs"} ], "timeout": 9} ]}, "x": [1, 2 ]}';
    const after = '{"hooks":{"Stop":[ {"matcher": "Bash", "hooks": [ {"command":"mine"}, {"command": "theirs"} ], "timeout": 9} ]}, "x": [1, 2 ]}';
    fs.writeFileSync(opts.settingsPath, before);
    uninstallClaudeCodeConfig(opts);
    expect(read(opts.settingsPath)).toBe(after);
  });

  it("uninstall removes every occurrence across many entries in one pass", () => {
    const entries = [hook, { matcher: "", hooks: hook.hooks }, { unrelated: true }, { hooks: [userHook, ...hook.hooks] },
      { command: "terum-memory hook stop" }, hook, { hooks: [{ command: "terum-memory hook stop --custom" }] }];
    fs.writeFileSync(opts.settingsPath, JSON.stringify({ hooks: { Stop: entries } }));
    uninstallClaudeCodeConfig(opts);
    expect(JSON.parse(read(opts.settingsPath)).hooks.Stop).toEqual([{ unrelated: true }, { hooks: [userHook] },
      { hooks: [{ command: "terum-memory hook stop --custom" }] }]);
    const rename = vi.spyOn(fs, "renameSync");
    uninstallClaudeCodeConfig(opts);
    expect(rename).not.toHaveBeenCalled();
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
