import { describe, expect, it } from "vitest";
import {
  COVERAGE_GUIDANCE, DISTILL_PROMPT, DISTILL_SCHEMA, NOTE_VOICE,
  SALIENCE_GUIDANCE, SUMMARY_STATE_GUARDRAIL, type DistilledNote,
} from "../distill.js";
import { DistillParseError, parseCompactedTextToDoc, parseDistilledNote, renderCompactedText } from "../parse.js";

const note: DistilledNote = {
  topic: "JWT TTL fix", summary: "fixed expiration", context: "tokens expired after five minutes",
  key_details: ["TTL was 300s", "auth.ts rejected expired tokens"],
  decisions: ["chose 3600s to permit longer sessions"], derived_conclusions: ["recommended rotating keys"],
  code_implementation: ["changed auth.ts"], preferences_corrections: ["kept strict validation"],
  open_threads: ["deferred load testing"], tags: ["JWT", "auth.ts"],
};

describe("parseDistilledNote", () => {
  it("round-trips a full schema object", () => {
    expect(parseDistilledNote(JSON.stringify(note))).toEqual(note);
  });

  it("defaults absent or malformed fields and filters arrays without stringifying values", () => {
    expect(parseDistilledNote(JSON.stringify({
      topic: "  topic  ", summary: 42, context: null, key_details: "not an array",
      decisions: [false, " a ", null, {}, ["nested"], "", " \n", 3, "b"],
      tags: { 0: "tag" }, ignored: "extra", __proto__: { open_threads: ["polluted"] },
    }))).toEqual({
      topic: "topic", summary: "", context: "", key_details: [], decisions: ["a", "b"],
      derived_conclusions: [], code_implementation: [], preferences_corrections: [], open_threads: [], tags: [],
    });
  });

  it.each(["", "not JSON", "```json\n{}\n```", "{", "null", "[]", "1", "true", '"object"'])(
    "throws a typed retryable parse error for %j", (raw) => {
      expect(() => parseDistilledNote(raw)).toThrow(DistillParseError);
    },
  );
});

describe("render and parse compacted text", () => {
  it("renders every section in exactly the prescribed order and recovers the document", () => {
    const rendered = renderCompactedText(note);
    expect(rendered).toBe(`**Topic**: JWT TTL fix

**One-line summary**: fixed expiration

**Context**: tokens expired after five minutes

**Key Details**:
- TTL was 300s
- auth.ts rejected expired tokens

**Decisions & Reasoning**:
- chose 3600s to permit longer sessions

**Findings & Analysis**:
- recommended rotating keys

**Code & Implementation**:
- changed auth.ts

**Preferences & Corrections**:
- kept strict validation

**Open Threads**:
- deferred load testing`);
    expect(parseCompactedTextToDoc(rendered)).toEqual({
      why: note.context,
      sections: [
        { kind: "key_details", bullets: note.key_details },
        { kind: "decisions", bullets: note.decisions },
        { kind: "findings", bullets: note.derived_conclusions },
        { kind: "code", bullets: note.code_implementation },
        { kind: "preferences", bullets: note.preferences_corrections },
        { kind: "open_threads", bullets: note.open_threads },
      ],
    });
  });

  it("routes unknown headings and leading prose to details, accepts bullet styles and alternate headers", () => {
    expect(parseCompactedTextToDoc(`leading prose
**Unknown**: inline detail
– en dash
• dot
*DECISIONS & REASONING:* committed
- next decision
**constructor**: ordinary unknown header
**Context**: first line
second line
**Topic**: skipped
also skipped
**One-line summary**: skipped too`)).toEqual({
      why: "first line\nsecond line",
      sections: [
        { kind: "key_details", bullets: ["leading prose", "inline detail", "en dash", "dot", "ordinary unknown header"] },
        { kind: "decisions", bullets: ["committed", "next decision"] },
      ],
    });
  });

  it.each(["", " \n\t\r\n", "**Topic**: only a topic\n**Key Details**:\n- "])("omits empty sections for %j", (text) => {
    expect(parseCompactedTextToDoc(text)).toEqual({ why: null, sections: [] });
  });

  it("omits empty fields and tags from rendering", () => {
    expect(renderCompactedText(parseDistilledNote('{"tags":["tag"]}'))).toBe("");
  });
});

it("exports the ten-field schema and composes pinned guidance in order on the intended lines", () => {
  expect(DISTILL_SCHEMA.additionalProperties).toBe(false);
  expect(DISTILL_SCHEMA.required).toEqual(Object.keys(note));
  expect(Object.keys(DISTILL_SCHEMA.properties as object)).toEqual(Object.keys(note));
  expect(DISTILL_PROMPT.startsWith("You are distilling a coding session into structured notes for future retrieval.\n")).toBe(true);
  expect(DISTILL_PROMPT).toContain(`${SALIENCE_GUIDANCE}\n${COVERAGE_GUIDANCE}\nField guidance:`);
  expect(DISTILL_PROMPT).toContain(`middleware".${SUMMARY_STATE_GUARDRAIL}\n- context:`);
  expect(DISTILL_PROMPT.endsWith(`${NOTE_VOICE}\n`)).toBe(true);
});
