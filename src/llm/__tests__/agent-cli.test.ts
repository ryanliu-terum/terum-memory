import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentCliBackend, type AgentBinary } from "../adapters/agent-cli.js";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

let dir: string;
let serial = 0;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "terum-cli-")); });
afterEach(() => {
  vi.clearAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});
function fixture(source: string): string {
  const file = path.join(dir, `fixture ${serial++}.cjs`);
  fs.writeFileSync(file, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  return file;
}
const req = { prompt: "test", schema: { type: "object" }, timeoutMs: 2000 };

describe.skipIf(process.platform === "win32")("agent CLI subprocess contract", () => {
  it.each(["claude", "codex", "gemini"] as const)("%s receives verbatim stdin and fixed argv without a shell", async (binary) => {
    const binaryPath = fixture(`let input = ''; process.stdin.setEncoding('utf8');
      process.stdin.on('data', c => input += c);
      process.stdin.on('end', () => process.stdout.write(JSON.stringify({input, argv: process.argv.slice(2)})));`);
    const prompt = 'quotes " and \' ; | & $(rm -rf /) `whoami`\n--help\n--output=/tmp/nope\nUnicode: 水🦉';
    const backend = createAgentCliBackend({ binary, binaryPath });
    expect(backend.modelId).toBe(`${binary}-cli`);
    const result = JSON.parse(await backend.completeJSON({ ...req, prompt }));
    expect(result.input).toBe(`${prompt}\n\nReturn ONLY JSON matching this schema:\n${JSON.stringify(req.schema)}`);
    const args = binary === "codex" ? ["exec"] : ["-p"];
    expect(result.argv).toEqual(args);
    expect(spawn).toHaveBeenCalledWith(binaryPath, args, { shell: false, stdio: ["pipe", "pipe", "pipe"] });
  });

  it("reports nonzero exit with bounded stderr", async () => {
    const binaryPath = fixture(`process.stdin.resume(); process.stdin.on('end', () => { process.stderr.write('diagnostic ' + 'x'.repeat(4096)); process.stdout.write('{}'); process.exitCode = 7; });`);
    const result = await createAgentCliBackend({ binary: "claude", binaryPath }).completeJSON(req).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    expect(String(result)).toContain("exit code 7");
    expect(String(result)).toContain("diagnostic");
    expect(String(result).length).toBeLessThan(600);
  });

  it("rejects empty stdout even on exit zero", async () => {
    const binaryPath = fixture(`process.stdin.resume(); process.stdin.on('end', () => { process.stderr.write('no result'); process.stdout.write('  \\n'); });`);
    await expect(createAgentCliBackend({ binary: "codex", binaryPath }).completeJSON(req)).rejects.toThrow("exit code 0; empty stdout: no result");
  });

  it("surfaces spawn failure", async () => {
    await expect(createAgentCliBackend({ binary: "gemini", binaryPath: path.join(dir, "missing") }).completeJSON(req)).rejects.toThrow(/could not start|could not receive stdin/);
  });

  it.each(["stdout", "stderr", "combined"])("kills on %s byte cap breach, never returns a truncated result", async (stream) => {
    const pidFile = path.join(dir, "pid");
    const binaryPath = fixture(`require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      process.on('SIGTERM', () => {});
      process.stdin.resume(); process.stdin.on('end', () => {
        ${stream === "stdout" ? "process.stdout.write('水'.repeat(100));" : stream === "stderr" ? "process.stderr.write('x'.repeat(300));" : "process.stdout.write('{}' + ' '.repeat(148)); process.stderr.write('x'.repeat(150));"}
        setInterval(() => {}, 1000);
      });`);
    await expect(createAgentCliBackend({ binary: "gemini", binaryPath, outputCapBytes: 256, killGraceMs: 300 }).completeJSON(req)).rejects.toThrow("exceeded output cap");
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("times out with SIGTERM and rejects even when the child handles it with exit zero", async () => {
    const marker = path.join(dir, "term");
    const binaryPath = fixture(`process.on('SIGTERM', () => { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'SIGTERM'); process.exit(0); }); process.stdin.resume(); setInterval(() => {}, 1000);`);
    await expect(createAgentCliBackend({ binary: "claude", binaryPath, killGraceMs: 500 }).completeJSON({ ...req, timeoutMs: 3000 })).rejects.toThrow("timed out");
    expect(fs.readFileSync(marker, "utf8")).toBe("SIGTERM");
  });

  it("escalates to SIGKILL after the grace when SIGTERM is ignored", async () => {
    const marker = path.join(dir, "term");
    const pidFile = path.join(dir, "pid");
    const binaryPath = fixture(`const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      process.on('SIGTERM', () => fs.writeFileSync(${JSON.stringify(marker)}, 'ignored'));
      process.stdin.resume(); setInterval(() => {}, 1000);`);
    const start = Date.now();
    await expect(createAgentCliBackend({ binary: "codex", binaryPath, killGraceMs: 500 }).completeJSON({ ...req, timeoutMs: 3000 })).rejects.toThrow("timed out");
    expect(Date.now() - start).toBeGreaterThanOrEqual(3400);
    expect(fs.readFileSync(marker, "utf8")).toBe("ignored");
    expect(() => process.kill(Number(fs.readFileSync(pidFile, "utf8")), 0)).toThrow();
    const child = vi.mocked(spawn).mock.results[0]!.value as ReturnType<typeof spawn>;
    expect(child.signalCode).toBe("SIGKILL");
  });

  it("bounds a failed call even when a descendant holds stdout open after the child exits", async () => {
    const pidFile = path.join(dir, "descendant-pid");
    const binaryPath = fixture(`const child = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {stdio: ['ignore', process.stdout, process.stderr]});
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      process.exit(0);`);
    try {
      await expect(createAgentCliBackend({ binary: "claude", binaryPath, killGraceMs: 300 }).completeJSON({ ...req, timeoutMs: 3000 })).rejects.toThrow(/timed out|could not receive stdin/);
      expect(fs.existsSync(pidFile)).toBe(true);
    } finally {
      if (fs.existsSync(pidFile)) process.kill(Number(fs.readFileSync(pidFile, "utf8")), "SIGKILL");
    }
  });
});

it.each(["unknown", "constructor", "__proto__", "claude; echo hi"])("rejects unknown binary %s synchronously, even with an override", (binary) => {
  expect(() => createAgentCliBackend({ binary: binary as AgentBinary, binaryPath: process.execPath })).toThrow("Unsupported agent CLI");
  expect(spawn).not.toHaveBeenCalled();
});
