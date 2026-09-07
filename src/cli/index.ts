#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const COMMANDS = ["init", "connect", "backfill", "sync", "decisions", "show", "check", "search", "decide", "reembed", "status", "uninstall", "mcp", "hook"] as const;
export const usage = (): string => `Usage: terum-memory <command> [options]\nCommands: ${COMMANDS.join(" · ")}\nconnect claude-code; hook stop`;
export interface RouterDeps {
  out?: (text: string) => void;
  err?: (text: string) => void;
  load?: (command: string) => Promise<{ run: (args: string[]) => Promise<number> }>;
}
const loaders: Record<string, () => Promise<{ run: (args: string[]) => Promise<number> }>> = {
  "init": () => import("./commands/init.js"),
  "connect": () => import("./commands/connect.js"),
  "backfill": () => import("./commands/backfill.js"),
  "sync": () => import("./commands/sync.js"),
  "decisions": () => import("./commands/decisions.js"),
  "show": () => import("./commands/show.js"),
  "check": () => import("./commands/check.js"),
  "search": () => import("./commands/search.js"),
  "decide": () => import("./commands/decide.js"),
  "reembed": () => import("./commands/reembed.js"),
  "status": () => import("./commands/status.js"),
  "uninstall": () => import("./commands/uninstall.js"),
  "mcp": () => import("./commands/mcp.js"),
  "hook": () => import("./commands/hook.js"),
};
export async function main(argv: string[], deps: RouterDeps = {}): Promise<number> {
  const out = deps.out ?? console.log;
  const err = deps.err ?? console.error;
  try {
    const [name, ...args] = argv;
    if (name === undefined || ["help", "--help", "-h"].includes(name)) { out(usage()); return 0; }
    if (["--version", "-v"].includes(name)) {
      out((JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version);
      return 0;
    }
    if (!(COMMANDS as readonly string[]).includes(name)) { err(`Unknown command: ${name}\n${usage()}`); return 1; }
    if (name === "connect" || name === "hook") {
      const required = name === "connect" ? "claude-code" : "stop";
      if (args.shift() !== required) { err(`Usage: terum-memory ${name} ${required}`); return 1; }
    }
    const module = await (deps.load ?? (async command => loaders[command]!()))(name);
    return await module.run(args);
  } catch (error) {
    err(`terum-memory: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
