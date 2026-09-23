import { randomUUID } from "node:crypto";
import { decisionContentHash } from "../decisions/hash.js";
export { decisionContentHash } from "../decisions/hash.js";
import { getMeta, type Db } from "../db/open.js";
import { completeJob, enqueueCoalesced, failJob } from "../jobs/queue.js";
import type { JobClaim } from "../jobs/types.js";
import type { ChatBackend } from "../llm/backend.js";
import { DISTILL_PROMPT, DISTILL_SCHEMA, type DistilledNote } from "./distill.js";
import type { Embedder } from "./embedder-types.js";
import { parseDistilledNote, renderCompactedText } from "./parse.js";
import { scrubSecrets } from "./secret-scrub.js";

export const DISTILL_CONTENT_BUDGET = 100_000;

export function assembleTranscript(turns: ReadonlyArray<{ prompt: string; response: string }>): string {
  return turns.map(({ prompt, response }) => `User:\n${prompt}\n\nAssistant:\n${response}`).join("\n\n");
}

/** Keep newline bytes with their line so chunks join losslessly, including CRLF. */
export function chunkText(text: string, budget: number): string[] {
  if (!Number.isSafeInteger(budget) || budget <= 0) {
    throw new Error("Chunk budget must be a positive safe integer");
  }
  if (text.length <= budget) return [text];
  const chunks: string[] = [];
  let current = "";
  for (const match of text.matchAll(/[^\n]*\n|[^\n]+$/g)) {
    let line = match[0];
    if (current.length + line.length > budget && current) {
      chunks.push(current);
      current = "";
    }
    while (line.length > budget) {
      chunks.push(line.slice(0, budget));
      line = line.slice(budget);
    }
    current += line;
  }
  if (current) chunks.push(current);
  return chunks;
}

export function mergeNotes(notes: readonly DistilledNote[]): DistilledNote {
  const merged = parseDistilledNote("{}");
  for (const key of ["topic", "context"] as const) {
    merged[key] = notes.map((note) => note[key].trim()).find(Boolean) ?? "";
  }
  merged.summary = notes.map((note) => note.summary.trim()).filter(Boolean).join("; ");
  for (const key of [
    "key_details", "decisions", "derived_conclusions", "code_implementation",
    "preferences_corrections", "open_threads", "tags",
  ] as const) {
    merged[key] = [...new Set(notes.flatMap((note) => note[key]).map((item) => item.trim()).filter(Boolean))];
  }
  return merged;
}

interface Capture {
  id: string;
  prompt: string;
  response: string;
  metadata: string;
  conversation_title: string | null;
  captured_at: string;
  created_at: string;
  distilled_at: string | null;
}

function majorityRepo(captures: Capture[]): string | null {
  const counts = new Map<string, { count: number; latest: number }>();
  captures.forEach((capture, latest) => {
    // Corrupt metadata is an unknown repository, not a distill failure: the capture abstains from the
    // vote and the note still lands (repo_name null when no capture is readable). Dead-lettering here
    // would pin a whole conversation behind one bad row that retries can never repair.
    let metadata: unknown;
    try { metadata = JSON.parse(capture.metadata); } catch { return; }
    if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return;
    const value = (metadata as Record<string, unknown>).repo_name;
    if (typeof value !== "string") return;
    const repo = value.trim().replace(/[\\/]+$/, "").split(/[\\/]/).at(-1)?.toLowerCase();
    if (!repo) return;
    counts.set(repo, { count: (counts.get(repo)?.count ?? 0) + 1, latest });
  });
  return [...counts].sort((a, b) => b[1].count - a[1].count || b[1].latest - a[1].latest)[0]?.[0] ?? null;
}

export interface DistillDeps {
  backend: ChatBackend;
  embedder: Embedder;
  now?: () => Date;
}

function validateVectors(db: Db, embedder: Embedder, vectors: Float32Array[], count: number): void {
  const lockedDim = getMeta(db, "embedder_dim");
  if (!Number.isSafeInteger(embedder.dim) || embedder.dim <= 0 ||
      (lockedDim !== undefined && Number(lockedDim) !== embedder.dim)) {
    throw new Error("Embedding dimension mismatch with database");
  }
  if (vectors.length !== count) throw new Error("Embedding vector count mismatch");
  for (const vector of vectors) {
    if (!(vector instanceof Float32Array) || vector.length !== embedder.dim) {
      throw new Error("Embedding dimension mismatch");
    }
    if (!vector.every(Number.isFinite)) throw new Error("Embedding contains non-finite values");
  }
}

function vectorBytes(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

/** All remote work precedes the single fenced persistence transaction. */
export async function runDistillJob(db: Db, claim: JobClaim, deps: DistillDeps): Promise<void> {
  try {
    const payload = claim.payload;
    if (claim.kind !== "distill" || payload === null || typeof payload !== "object" ||
        !("site" in payload) || typeof payload.site !== "string" ||
        !("conversation_id" in payload) || typeof payload.conversation_id !== "string") {
      throw new Error("Invalid distill job payload");
    }
    const { site, conversation_id: conversationId } = payload;
    // A single SELECT snapshots full history and pending ids together. rowid breaks
    // exact timestamp ties deterministically without changing chronological order.
    const captures = db.prepare(`
      SELECT id, prompt, response, metadata, conversation_title, captured_at, created_at, distilled_at
      FROM captures WHERE site = ? AND conversation_id = ?
      ORDER BY captured_at, created_at, rowid
    `).all(site, conversationId) as Capture[];
    const pendingIds = captures.filter((capture) => capture.distilled_at === null).map((capture) => capture.id);
    if (!pendingIds.length) {
      completeJob(db, claim, undefined, deps);
      return;
    }
    const repoName = majorityRepo(captures);
    // The single choke point precedes chunking: secrets spanning a chunk boundary
    // must be removed before any chunk can reach the backend.
    const transcript = scrubSecrets(assembleTranscript(captures));
    const notes: DistilledNote[] = [];
    for (const chunk of chunkText(transcript, DISTILL_CONTENT_BUDGET)) {
      notes.push(parseDistilledNote(await deps.backend.completeJSON({
        prompt: DISTILL_PROMPT + "\n\n" + chunk,
        schema: DISTILL_SCHEMA,
        timeoutMs: 60_000,
      })));
    }
    const note = notes.length === 1 ? notes[0]! : mergeNotes(notes);
    const compactedText = renderCompactedText(note);
    const vectors = await deps.embedder.embed([compactedText, ...note.decisions], "document");
    validateVectors(db, deps.embedder, vectors, 1 + note.decisions.length);
    const now = (deps.now ?? (() => new Date()))().toISOString();
    const decisions = new Map<string, { text: string; vector: Float32Array }>();
    note.decisions.forEach((text, index) => {
      const hash = decisionContentHash(text);
      if (!decisions.has(hash)) decisions.set(hash, { text, vector: vectors[index + 1]! });
    });

    completeJob(db, claim, (tx) => {
      const existing = tx.prepare("SELECT id FROM notes WHERE site = ? AND conversation_id = ?")
        .get(site, conversationId) as { id: string } | undefined;
      const noteId = existing?.id ?? randomUUID();
      const title = [...captures].reverse().find((capture) => capture.conversation_title !== null)?.conversation_title ?? null;
      tx.prepare(`
        INSERT INTO notes (id, site, conversation_id, conversation_title, turn_count, topic,
          summary, compacted_text, entity_tags, repo_name, project_id, model_used,
          first_captured_at, last_captured_at, distilled_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
        ON CONFLICT(site, conversation_id) DO UPDATE SET
          conversation_title = excluded.conversation_title, turn_count = excluded.turn_count,
          topic = excluded.topic, summary = excluded.summary, compacted_text = excluded.compacted_text,
          entity_tags = excluded.entity_tags, repo_name = excluded.repo_name, project_id = NULL,
          model_used = excluded.model_used, first_captured_at = excluded.first_captured_at,
          last_captured_at = excluded.last_captured_at, distilled_at = excluded.distilled_at
      `).run(noteId, site, conversationId, title, captures.length, note.topic, note.summary,
        compactedText, JSON.stringify(note.tags), repoName, deps.backend.modelId,
        captures[0]!.captured_at, captures.at(-1)!.captured_at, now);
      tx.prepare("DELETE FROM note_vec WHERE note_id = ?").run(noteId);
      tx.prepare("INSERT INTO note_vec (note_id, embedding) VALUES (?, ?)").run(noteId, vectorBytes(vectors[0]!));

      const previous = tx.prepare("SELECT id, content_hash, provenance FROM decisions WHERE note_id = ?")
        .all(noteId) as Array<{ id: string; content_hash: string; provenance: string }>;
      for (const row of previous) {
        if (row.provenance === "distilled" && !decisions.has(row.content_hash)) {
          tx.prepare("DELETE FROM decision_vec WHERE decision_id = ?").run(row.id);
          tx.prepare("DELETE FROM decisions WHERE id = ? AND provenance = 'distilled'").run(row.id);
        }
      }
      // A ratified row with the same hash already owns the unique key. Preserve it
      // exactly, just as a surviving distilled row keeps both its row and vector.
      const existingHashes = new Set(previous.map((row) => row.content_hash));
      for (const [hash, decision] of decisions) {
        if (existingHashes.has(hash)) continue;
        const id = randomUUID();
        tx.prepare(`
          INSERT INTO decisions (id, note_id, decision_text, topic, content_hash,
            source_summary, provenance, decided_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'distilled', ?, ?)
        `).run(id, noteId, decision.text, note.topic, hash, note.summary, now, now);
        tx.prepare("INSERT INTO decision_vec (decision_id, embedding) VALUES (?, ?)")
          .run(id, vectorBytes(decision.vector));
      }
      // Batch exact ids to stay below SQLite's bind limit on very long histories.
      for (let offset = 0; offset < pendingIds.length; offset += 500) {
        const ids = pendingIds.slice(offset, offset + 500);
        tx.prepare(`UPDATE captures SET distilled_at = ? WHERE id IN (${ids.map(() => "?").join(",")})`)
          .run(now, ...ids);
      }
      enqueueCoalesced(tx, "link-cluster", {}, deps);
    }, deps);
    // completeJob rolls everything back on a lost fence; no further writes follow.
  } catch (error) {
    failJob(db, claim, error, deps);
  }
}
