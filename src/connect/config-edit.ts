import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { atomicWrite, isMissing } from "./atomic-write.js";

export interface ClaudeCodeConfigOptions {
  settingsPath?: string;
  mcpConfigPath?: string;
}

const COMMAND = "terum-memory hook stop";
const HOOK = { hooks: [{ type: "command", command: COMMAND }] };
const SERVER = { command: "terum-memory", args: ["mcp"], type: "stdio" };

type JsonObject = Record<string, unknown>;
function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface Node {
  start: number;
  end: number;
  value: unknown;
  children: Node[];
  key?: string;
}

/** Span index over validated JSON; edits leave every unrelated token verbatim. */
function indexJson(text: string): Node {
  JSON.parse(text);
  let cursor = 0;
  const whitespace = (): void => { while (/\s/.test(text[cursor] ?? "") && cursor < text.length) cursor++; };
  const stringEnd = (): void => {
    cursor++;
    while (cursor < text.length) {
      const char = text[cursor++];
      if (char === "\\") cursor++;
      else if (char === '"') return;
    }
  };
  const read = (): Node => {
    whitespace();
    const start = cursor;
    const children: Node[] = [];
    const opener = text[cursor];
    if (opener === "{" || opener === "[") {
      cursor++;
      whitespace();
      const close = opener === "{" ? "}" : "]";
      const keys = new Set<string>();
      while (text[cursor] !== close) {
        const memberStart = cursor;
        let key: string | undefined;
        if (opener === "{") {
          stringEnd();
          key = JSON.parse(text.slice(memberStart, cursor)) as string;
          if (keys.has(key)) throw new Error(`Duplicate JSON key: ${key}`);
          keys.add(key);
          whitespace();
          cursor++; // colon
        }
        const child = read();
        if (key !== undefined) { child.key = key; child.start = memberStart; }
        children.push(child);
        whitespace();
        if (text[cursor] !== ",") break;
        cursor++;
        whitespace();
      }
      cursor++;
    } else if (opener === '"') stringEnd();
    else { while (cursor < text.length && !/[\s,}\]]/.test(text[cursor]!)) cursor++; }
    return { start, end: cursor, children, value: JSON.parse(text.slice(start, cursor)) as unknown };
  };
  return read();
}

function add(text: string, parent: Node, value: unknown, key?: string): string {
  const insertion = (parent.children.length ? "," : "") +
    (key === undefined ? "" : `${JSON.stringify(key)}:`) + JSON.stringify(value);
  const at = parent.children.at(-1)?.end ?? parent.end - 1;
  return text.slice(0, at) + insertion + text.slice(at);
}

function remove(text: string, parent: Node, index: number): string {
  const node = parent.children[index]!;
  const previous = parent.children[index - 1];
  const next = parent.children[index + 1];
  const start = previous ? previous.end : node.start;
  const end = !previous && next ? next.start : node.end;
  return text.slice(0, start) + text.slice(end);
}

function target(text: string, keys: string[], installing: boolean, value: unknown): {
  text: string; node?: Node;
} {
  let node = indexJson(text);
  if (!object(node.value)) throw new Error("Config must be a JSON object");
  for (let i = 0; i < keys.length; i++) {
    if (!object(node.value)) throw new Error(`${keys.slice(0, i).join(".")} must be an object`);
    const child = node.children.find(entry => entry.key === keys[i]);
    if (!child) {
      if (!installing) return { text };
      let nested = value;
      for (let j = keys.length - 1; j > i; j--) nested = { [keys[j]!]: nested };
      return { text: add(text, node, nested, keys[i]) };
    }
    node = child;
  }
  return { text, node };
}

function editSettings(text: string, installing: boolean): string {
  const located = target(text, ["hooks", "Stop"], installing, [HOOK]);
  if (!located.node) return located.text;
  const stop = located.node;
  if (!Array.isArray(stop.value)) throw new Error("hooks.Stop must be an array");
  let found = false;
  for (let i = 0; i < stop.children.length; i++) {
    const entry = stop.children[i]!.value;
    const exact = isDeepStrictEqual(entry, HOOK);
    if (exact) {
      if (!installing) return editSettings(remove(text, stop, i), false);
      found = true;
    } else if (installing && object(entry)) {
      const commands = [entry, ...(Array.isArray(entry.hooks) ? entry.hooks : [])];
      if (commands.some(hook => object(hook) && typeof hook.command === "string" && hook.command.trim() === COMMAND)) {
        throw new Error(`Collision: ${COMMAND} has a noncanonical hook value`);
      }
    }
  }
  return installing && !found ? add(text, stop, HOOK) : text;
}

function editMcp(text: string, installing: boolean): string {
  const located = target(text, ["mcpServers"], installing, { "terum-memory": SERVER });
  if (!located.node) return located.text;
  const servers = located.node;
  if (!object(servers.value)) throw new Error("mcpServers must be an object");
  const index = servers.children.findIndex(entry => entry.key === "terum-memory");
  if (index === -1) return installing ? add(text, servers, SERVER, "terum-memory") : text;
  if (!isDeepStrictEqual(servers.children[index]!.value, SERVER)) {
    if (installing) throw new Error("Collision: mcpServers.terum-memory has a noncanonical value");
    return text;
  }
  return installing ? text : remove(text, servers, index);
}

function editConfigs(opts: ClaudeCodeConfigOptions, installing: boolean): void {
  const targets = [
    { file: opts.settingsPath ?? path.join(os.homedir(), ".claude", "settings.json"), edit: editSettings },
    { file: opts.mcpConfigPath ?? path.join(os.homedir(), ".claude.json"), edit: editMcp },
  ];
  // Validate both before replacing either: a collision or malformed second file
  // must not leave a first-file installation behind.
  const plans = targets.map(({ file, edit }) => {
    let before: string;
    let mode = 0o600;
    try {
      before = fs.readFileSync(file, "utf8");
      mode = fs.statSync(file).mode & 0o777;
    } catch (error) {
      if (!isMissing(error)) throw error;
      if (!installing) return null;
      before = "{}";
    }
    try {
      return { file, before, after: edit(before, installing), mode };
    } catch (error) {
      throw new Error(`Cannot edit ${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  });
  for (const plan of plans) {
    if (plan && plan.before !== plan.after) atomicWrite(plan.file, plan.after, plan.mode);
  }
}

export function installClaudeCodeConfig(opts: ClaudeCodeConfigOptions = {}): void {
  editConfigs(opts, true);
}

export function uninstallClaudeCodeConfig(opts: ClaudeCodeConfigOptions = {}): void {
  editConfigs(opts, false);
}
