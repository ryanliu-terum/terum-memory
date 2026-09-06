import { cosineSimilarity } from "../engine/linker.js";
import type { DecisionRailConstants } from "../engine/thresholds.js";
import type { ChatBackend } from "../llm/backend.js";

export interface DedupCandidate {
  id: string;
  decision_text: string;
  content_hash: string;
  embedding: Float32Array;
  decided_at: string;
  created_at: string;
}

export interface DedupIncoming {
  decisionText: string;
  contentHash: string;
  embedding: Float32Array;
  decidedAt: string;
}

export interface DedupSelection {
  candidate: DedupCandidate | null;
  similarity: number | null;
  alsoMatched: string[];
}

type Judge = (incoming: DedupIncoming, candidate: DedupCandidate) => Promise<boolean>;
interface Match { candidate: DedupCandidate; similarity: number }

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function selection(matches: Match[]): DedupSelection {
  matches.sort((a, b) => b.similarity - a.similarity ||
    compareText(a.candidate.created_at, b.candidate.created_at) ||
    compareText(a.candidate.id, b.candidate.id));
  return {
    candidate: matches[0]?.candidate ?? null,
    similarity: matches[0]?.similarity ?? null,
    alsoMatched: matches.slice(1).map(({ candidate }) => candidate.id),
  };
}

export async function selectDedupCandidate(
  incoming: DedupIncoming,
  candidates: DedupCandidate[],
  rail: DecisionRailConstants,
  judge: Judge,
): Promise<DedupSelection> {
  const exact = candidates.filter(candidate => candidate.content_hash === incoming.contentHash);
  if (exact.length) {
    return selection(exact.map(candidate => ({
      candidate, similarity: cosineSimilarity(incoming.embedding, candidate.embedding),
    })));
  }
  const matches: Match[] = [];
  for (const candidate of candidates) {
    const similarity = cosineSimilarity(incoming.embedding, candidate.embedding);
    if (similarity >= rail.merge ||
        (similarity >= rail.judgeLow && await judge(incoming, candidate))) {
      matches.push({ candidate, similarity });
    }
  }
  return selection(matches);
}

export function makeDedupJudge(backend: ChatBackend): Judge {
  return async (incoming, candidate) => {
    try {
      const content = await backend.completeJSON({
        prompt: `Decide whether two recorded decisions are the same decision re-stated, or a reversal/different decision. Return only the required JSON verdict.

Incoming decision (decided ${incoming.decidedAt}):
${incoming.decisionText}

Candidate decision (decided ${candidate.decided_at}):
${candidate.decision_text}

Same decision re-stated, or a reversal/different decision?`,
        schema: {
          type: "object", additionalProperties: false, required: ["verdict"],
          properties: { verdict: { type: "string", enum: ["same_decision", "reversal_or_distinct"] } },
        },
        timeoutMs: 10_000,
      });
      const parsed: unknown = JSON.parse(content);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) ||
          Object.keys(parsed).length !== 1 || !("verdict" in parsed) ||
          (parsed.verdict !== "same_decision" && parsed.verdict !== "reversal_or_distinct")) {
        console.warn("Decision dedup judge returned an invalid verdict; no merge");
        return false;
      }
      return parsed.verdict === "same_decision";
    } catch {
      // Do not log backend content/errors: they may contain caller secrets.
      console.warn("Decision dedup judge failed; no merge");
      return false;
    }
  };
}
