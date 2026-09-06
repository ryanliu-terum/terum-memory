import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getMeta, setMeta, type Db } from "../db/open.js";
import { enforceFileModes } from "../db/permissions.js";
import { enqueueDistill } from "../jobs/queue.js";
import { parseTranscriptDelta } from "./transcript.js";
import { atomicWrite, isMissing } from "./atomic-write.js";

export interface CaptureOptions {
  now?: () => Date;
  repoResolver?: (cwd: string) => string | null;
}
export interface CaptureResult {
  inserted: number;
  conversationsTouched: string[];
  parseErrors: number;
  nextOffset: number;
}

export function resolveRepoName(cwd: string): string | null {
  if (!path.isAbsolute(cwd)) return null;
  let dir = path.normalize(cwd);
  for (;;) {
    try {
      if (fs.statSync(path.join(dir, ".git")).isDirectory()) return path.basename(dir).toLowerCase();
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function captureFromTranscript(
  db: Db, transcriptPath: string, opts: CaptureOptions = {},
): CaptureResult {
  // A caller-owned transaction could roll back after the sidecar was advanced.
  if (db.inTransaction) throw new Error("captureFromTranscript requires an independent transaction");
  const sidecar = `${transcriptPath}.terum-offset`;
  let offset = 0;
  try {
    enforceFileModes([sidecar]);
    const stored = JSON.parse(fs.readFileSync(sidecar, "utf8")) as { offset?: unknown };
    if (!stored || !Number.isSafeInteger(stored.offset) || (stored.offset as number) < 0) {
      throw new Error(`Invalid transcript offset in ${sidecar}`);
    }
    offset = stored.offset as number;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  // The prefix is needed to recover the latest user for each interleaved session.
  const delta = parseTranscriptDelta(fs.readFileSync(transcriptPath), offset);
  const now = (opts.now ?? (() => new Date()))().toISOString();
  const resolver = opts.repoResolver ?? resolveRepoName;
  const turns = delta.turns.map(turn => ({
    ...turn, repoName: turn.cwd === null ? null : resolver(turn.cwd),
  }));
  const result = db.transaction((): CaptureResult => {
    let inserted = 0;
    const touched = new Set<string>();
    const insert = db.prepare(`INSERT OR IGNORE INTO captures
      (id, site, conversation_id, conversation_title, prompt, response, model,
       metadata, source_key, captured_at, created_at, distilled_at)
      VALUES (?, 'claude-code', ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL)`);
    for (const turn of turns) {
      const changes = insert.run(randomUUID(), turn.conversationId, turn.prompt,
        turn.response, turn.model, JSON.stringify(turn.repoName === null ? {} : { repo_name: turn.repoName }),
        turn.sourceKey, turn.capturedAt, now).changes;
      inserted += changes;
      if (changes > 0) touched.add(turn.conversationId);
    }
    for (const conversation of touched) enqueueDistill(db, "claude-code", conversation, { now: () => new Date(now) });
    if (delta.parseErrors > 0) {
      const stored = getMeta(db, "parse_errors");
      const accounting = stored === undefined ? {} : JSON.parse(stored) as Record<string, { count: number; lastBadOffset: number | null }>;
      if (!accounting || typeof accounting !== "object" || Array.isArray(accounting)) {
        throw new Error("Invalid parse_errors metadata");
      }
      const prior = Object.hasOwn(accounting, transcriptPath) ? accounting[transcriptPath] : undefined;
      if (prior && (!Number.isSafeInteger(prior.count) || prior.count < 0)) throw new Error("Invalid parse_errors count");
      Object.defineProperty(accounting, transcriptPath, { value: {
        count: (prior?.count ?? 0) + delta.parseErrors, lastBadOffset: delta.lastBadOffset,
      }, enumerable: true, configurable: true, writable: true });
      setMeta(db, "parse_errors", JSON.stringify(accounting));
    }
    return { inserted, conversationsTouched: [...touched], parseErrors: delta.parseErrors, nextOffset: delta.nextOffset };
  }).immediate();
  atomicWrite(sidecar, JSON.stringify({ offset: delta.nextOffset }));
  return result;
}
