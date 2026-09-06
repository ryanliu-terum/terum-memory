import { createHash } from "node:crypto";

export function decisionContentHash(text: string): string {
  return createHash("sha256").update(text.trim().replace(/\s+/g, " ").toLowerCase()).digest("hex");
}
