import { spawn } from "node:child_process";
import type { ChatBackend } from "../backend.js";
import { SPAWN_KILL_GRACE_MS, SPAWN_OUTPUT_CAP_BYTES, SPAWN_TIMEOUT_MS } from "../defaults.js";
import { safeExcerpt } from "./openai-compatible.js";

export type AgentBinary = "claude" | "codex" | "gemini";
export interface AgentCliOptions {
  binary: AgentBinary;
  binaryPath?: string;
  killGraceMs?: number;
  outputCapBytes?: number;
}

export function createAgentCliBackend(opts: AgentCliOptions): ChatBackend {
  // Explicit comparisons also reject prototype names such as "constructor".
  if (opts.binary !== "claude" && opts.binary !== "codex" && opts.binary !== "gemini") {
    throw new Error("Unsupported agent CLI binary");
  }
  const argv = opts.binary === "codex" ? ["exec"] : ["-p"];
  const grace = opts.killGraceMs ?? SPAWN_KILL_GRACE_MS;
  const cap = opts.outputCapBytes ?? SPAWN_OUTPUT_CAP_BYTES;
  if (!Number.isSafeInteger(grace) || grace < 0 || !Number.isSafeInteger(cap) || cap < 1) {
    throw new Error("Invalid agent CLI resource limits");
  }
  return {
    modelId: `${opts.binary}-cli`,
    completeJSON({ prompt, schema, timeoutMs }) {
      const timeout = timeoutMs ?? SPAWN_TIMEOUT_MS;
      if (!Number.isSafeInteger(timeout) || timeout < 1) return Promise.reject(new Error("Invalid agent CLI timeout"));
      const input = `${prompt}\n\nReturn ONLY JSON matching this schema:\n${JSON.stringify(schema)}`;
      return new Promise<string>((resolve, reject) => {
        const child = spawn(opts.binaryPath ?? opts.binary, argv, { shell: false, stdio: ["pipe", "pipe", "pipe"] });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let bytes = 0;
        let stderrBytes = 0;
        let failure: Error | undefined;
        let exited = false;
        let settled = false;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const timer = setTimeout(() => stop(new Error(`Agent CLI ${opts.binary} timed out after ${timeout}ms`)), timeout);

        function clearTimers(): void {
          clearTimeout(timer);
          if (killTimer !== undefined) clearTimeout(killTimer);
        }
        function stop(error: Error): void {
          if (failure || settled) return;
          failure = error;
          child.stdin.destroy();
          // Descendants can inherit these pipes. A failed call must not wait for
          // their EOF after the direct child has exited or been killed.
          child.stdout.destroy();
          child.stderr.destroy();
          if (!exited) {
            child.kill("SIGTERM");
            killTimer = setTimeout(() => {
              if (!exited) child.kill("SIGKILL");
            }, grace);
          }
        }
        function collect(chunk: Buffer, stream: "stdout" | "stderr"): void {
          if (failure) return;
          bytes += chunk.length;
          if (bytes > cap) {
            stop(new Error(`Agent CLI ${opts.binary} exceeded output cap of ${cap} bytes`));
            return;
          }
          if (stream === "stdout") stdout.push(chunk);
          else if (stderrBytes < 2048) {
            const part = chunk.subarray(0, 2048 - stderrBytes);
            stderr.push(part);
            stderrBytes += part.length;
          }
        }
        child.stdout.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
        child.stderr.on("data", (chunk: Buffer) => collect(chunk, "stderr"));
        child.stdin.on("error", () => stop(new Error(`Agent CLI ${opts.binary} could not receive stdin`)));
        child.stdout.on("error", () => stop(new Error(`Agent CLI ${opts.binary} stdout read failed`)));
        child.stderr.on("error", () => stop(new Error(`Agent CLI ${opts.binary} stderr read failed`)));
        child.on("error", () => {
          // Spawn errors may contain executable paths; keep the diagnostic bounded.
          stop(new Error(`Agent CLI ${opts.binary} could not start or be signalled`));
        });
        child.on("exit", () => {
          exited = true;
          if (killTimer !== undefined) clearTimeout(killTimer);
        });
        child.on("close", (code, signal) => {
          settled = true;
          clearTimers();
          const excerpt = safeExcerpt(Buffer.concat(stderr).toString("utf8"));
          if (failure) {
            reject(new Error(`${failure.message}; exit code ${code}${signal ? ` (${signal})` : ""}: ${excerpt}`));
            return;
          }
          const output = Buffer.concat(stdout).toString("utf8");
          if (code !== 0 || !output.trim()) {
            reject(new Error(`Agent CLI ${opts.binary} exit code ${code}${signal ? ` (${signal})` : ""}${!output.trim() ? "; empty stdout" : ""}: ${excerpt}`));
            return;
          }
          resolve(output);
        });
        child.stdin.end(input);
      });
    },
  };
}
