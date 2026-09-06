import type { DistilledNote } from "./distill.js";

export class DistillParseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DistillParseError";
  }
}

export function parseDistilledNote(raw: string): DistilledNote {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (cause) {
    throw new DistillParseError("Distill output is not valid JSON", { cause });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DistillParseError("Distill output must be an object");
  }
  const object = value as Record<string, unknown>;
  const string = (key: string): string =>
    typeof object[key] === "string" ? object[key].trim() : "";
  const strings = (key: string): string[] => {
    const items = object[key];
    return Array.isArray(items)
      ? items.filter((item): item is string => typeof item === "string")
        .map((item) => item.trim()).filter(Boolean)
      : [];
  };
  return {
    topic: string("topic"),
    summary: string("summary"),
    context: string("context"),
    key_details: strings("key_details"),
    decisions: strings("decisions"),
    derived_conclusions: strings("derived_conclusions"),
    code_implementation: strings("code_implementation"),
    preferences_corrections: strings("preferences_corrections"),
    open_threads: strings("open_threads"),
    tags: strings("tags"),
  };
}

export function renderCompactedText(note: DistilledNote): string {
  const parts: string[] = [];
  if (note.topic) parts.push(`**Topic**: ${note.topic}`);
  if (note.summary) parts.push(`**One-line summary**: ${note.summary}`);
  if (note.context) parts.push(`**Context**: ${note.context}`);
  const section = (title: string, items: string[]) => {
    if (items.length > 0) parts.push(`**${title}**:\n${items.map((i) => `- ${i}`).join("\n")}`);
  };
  section("Key Details", note.key_details);
  section("Decisions & Reasoning", note.decisions);
  section("Findings & Analysis", note.derived_conclusions);
  section("Code & Implementation", note.code_implementation);
  section("Preferences & Corrections", note.preferences_corrections);
  section("Open Threads", note.open_threads);
  return parts.join("\n\n");
}

export type SectionKind = "key_details" | "decisions" | "findings" | "code" | "preferences" | "open_threads";
export interface CompactedDoc {
  why: string | null;
  sections: Array<{ kind: SectionKind; bullets: string[] }>;
}

const HEADERS = new Map<string, SectionKind | "why" | "skip">([
  ["topic", "skip"],
  ["one-line summary", "skip"],
  ["context", "why"],
  ["key details", "key_details"],
  ["decisions & reasoning", "decisions"],
  ["findings & analysis", "findings"],
  ["code & implementation", "code"],
  ["preferences & corrections", "preferences"],
  ["open threads", "open_threads"],
]);

export function parseCompactedTextToDoc(text: string): CompactedDoc {
  const doc: CompactedDoc = { why: null, sections: [] };
  const why: string[] = [];
  let kind: SectionKind | "why" | "skip" = "key_details";
  for (const line of text.split(/\r?\n/)) {
    const header = /^\*{1,2}([^*]+?)\*{1,2}:?\s*(.*)$/.exec(line);
    if (header) {
      kind = HEADERS.get(header[1]!.trim().replace(/:$/, "").trim().toLowerCase()) ?? "key_details";
    }
    const content = (header ? header[2]! : line).trim().replace(/^[-–•]\s*/, "").trim();
    if (!content || kind === "skip") continue;
    if (kind === "why") {
      why.push(content);
    } else {
      let section = doc.sections.find((section) => section.kind === kind);
      if (!section) {
        section = { kind, bullets: [] };
        doc.sections.push(section);
      }
      section.bullets.push(content);
    }
  }
  doc.why = why.length ? why.join("\n") : null;
  return doc;
}
