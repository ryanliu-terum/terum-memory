export interface ParsedTurn {
  conversationId: string;
  sourceKey: string;
  prompt: string;
  response: string;
  model: string | null;
  cwd: string | null;
  capturedAt: string;
}

export interface TranscriptDelta {
  turns: ParsedTurn[];
  nextOffset: number;
  parseErrors: number;
  lastBadOffset: number | null;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(object)
    .filter(block => block.type === "text" && typeof block.text === "string")
    .map(block => block.text).join("");
}

/** bytes is the full transcript snapshot; prefix records supply pairing context only. */
export function parseTranscriptDelta(bytes: Buffer, startOffset: number): TranscriptDelta {
  if (!Number.isSafeInteger(startOffset) || startOffset < 0 || startOffset > bytes.length ||
      (startOffset > 0 && bytes[startOffset - 1] !== 10)) {
    throw new Error("startOffset must be a record boundary within the transcript");
  }
  const result: TranscriptDelta = {
    turns: [], nextOffset: startOffset, parseErrors: 0, lastBadOffset: null,
  };
  const users = new Map<string, { text: string; cwd: string | null }>();
  for (let offset = 0; offset < bytes.length;) {
    const end = bytes.indexOf(10, offset);
    if (end === -1) break;
    const inDelta = offset >= startOffset;
    if (inDelta) result.nextOffset = end + 1;
    let record: unknown;
    try {
      record = JSON.parse(bytes.toString("utf8", offset, end)) as unknown;
    } catch {
      if (inDelta) {
        result.parseErrors++;
        result.lastBadOffset = offset;
      }
      offset = end + 1;
      continue;
    }
    if (object(record) && (record.type === "user" || record.type === "assistant")) {
      // Known record kinds with unusable required fields are counted, not silently lost.
      if (typeof record.sessionId !== "string" || !object(record.message) ||
          (record.type === "assistant" && typeof record.timestamp !== "string")) {
        if (inDelta) {
          result.parseErrors++;
          result.lastBadOffset = offset;
        }
      } else {
        const text = contentText(record.message.content);
        const cwd = typeof record.cwd === "string" ? record.cwd : null;
        if (record.type === "user") users.set(record.sessionId, { text, cwd });
        else {
          const user = users.get(record.sessionId);
          if (inDelta && user && text.length > 0) {
            result.turns.push({
              conversationId: record.sessionId,
              sourceKey: typeof record.uuid === "string" ? record.uuid : String(offset),
              prompt: user.text, response: text,
              model: typeof record.message.model === "string" ? record.message.model : null,
              cwd: cwd ?? user.cwd, capturedAt: record.timestamp as string,
            });
          }
        }
      }
    }
    offset = end + 1;
  }
  return result;
}
