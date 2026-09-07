import { openDb, type Db } from "../../db/open.js";
import { captureFromTranscript, type CaptureOptions } from "../../connect/capture.js";
import { spawnDetachedWorker } from "../../worker/spawn.js";
import path from "node:path";
export interface HookDeps {
  db?: Db;
  dbPath?: string;
  readStdin?: () => Promise<string>;
  spawn?: () => boolean | Promise<boolean>;
  err?: (text: string) => void;
  captureOptions?: CaptureOptions;
}
async function stdin(): Promise<string> {
  let text = "";
  for await (const chunk of process.stdin) {
    text += String(chunk);
    if (text.length > 1_048_576) throw new Error("Stop hook input exceeds 1 MiB");
  }
  return text;
}
export async function run(args: string[], deps: HookDeps = {}): Promise<number> {
  if (args.length) { (deps.err ?? console.error)("Usage: terum-memory hook stop"); return 1; }
  const input: unknown = JSON.parse(await (deps.readStdin ?? stdin)());
  if (typeof input !== "object" || input === null || !("transcript_path" in input) ||
      typeof input.transcript_path !== "string" || !input.transcript_path.trim()) throw new Error("Stop hook requires transcript_path");
  const db = deps.db ?? openDb({ dbPath: deps.dbPath });
  try {
    const result = captureFromTranscript(db, input.transcript_path, deps.captureOptions);
    if (result.parseErrors) (deps.err ?? console.error)(`Stop hook: ${result.parseErrors} malformed transcript records`);
    await (deps.spawn ?? (() => spawnDetachedWorker({ home: path.dirname(db.name), dbPath: db.name })))();
    return 0;
  } finally { if (!deps.db) db.close(); }
}
