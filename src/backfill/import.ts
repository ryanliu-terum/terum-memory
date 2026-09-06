import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { getMeta, setMeta, type Db } from "../db/open.js";
import { resolveRepoName, type CaptureOptions } from "../connect/capture.js";
import { parseTranscriptDelta } from "../connect/transcript.js";

export interface ImportResult {
  inserted: number;
  conversationsTouched: string[];
  /** Also returned so page results can surface malformed sessions. */
  parseErrors: number;
}

/** No queue writes or offset sidecars. Safe inside a page's fenced transaction. */
export function importSession(db: Db, transcriptPath: string, opts: CaptureOptions = {}): ImportResult {
  const delta = parseTranscriptDelta(fs.readFileSync(transcriptPath), 0);
  const now = (opts.now ?? (() => new Date()))().toISOString();
  const resolver = opts.repoResolver ?? resolveRepoName;
  const turns = delta.turns.map(turn => ({
    ...turn, repoName: turn.cwd === null ? null : resolver(turn.cwd),
  }));
  return db.transaction(() => {
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
    return { inserted, conversationsTouched: [...touched], parseErrors: delta.parseErrors };
  }).immediate();
}
