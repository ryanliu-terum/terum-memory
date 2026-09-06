#!/usr/bin/env node
import { readFileSync } from "node:fs";

const COMMANDS = [
  "init",
  "connect",
  "backfill",
  "sync",
  "decisions",
  "show",
  "check",
  "search",
  "decide",
  "reembed",
  "status",
  "uninstall",
  "mcp",
  "hook",
] as const;

function version(): string {
  const pkg = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  return pkg.version;
}

function usage(): string {
  return [
    "terum-memory — local-first memory + decision record for coding agents",
    "",
    "Usage: terum-memory <command> [options]",
    "",
    `Commands: ${COMMANDS.join(" · ")}`,
    "",
    "Status: v0.1 port in progress — commands land module by module.",
  ].join("\n");
}

const command = process.argv[2];

if (command === undefined || command === "help" || command === "--help" || command === "-h") {
  console.log(usage());
  process.exit(0);
}

if (command === "--version" || command === "-v") {
  console.log(version());
  process.exit(0);
}

if ((COMMANDS as readonly string[]).includes(command)) {
  console.error(`terum-memory ${command}: not implemented yet — v0.1 port in progress.`);
  process.exit(1);
}

console.error(`terum-memory: unknown command "${command}"\n\n${usage()}`);
process.exit(1);
