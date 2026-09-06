import { describe, expect, it } from "vitest";
import { assembleTranscript, chunkText, DISTILL_CONTENT_BUDGET, mergeNotes } from "../compactor.js";
import { parseDistilledNote } from "../parse.js";

it("assembles turns verbatim with role labels and blank-line separators", () => {
  expect(assembleTranscript([{ prompt: "hello", response: "world" }, { prompt: "next\nline", response: "" }]))
    .toBe("User:\nhello\n\nAssistant:\nworld\n\nUser:\nnext\nline\n\nAssistant:\n");
  expect(assembleTranscript([])).toBe("");
  expect(DISTILL_CONTENT_BUDGET).toBe(100_000);
});

describe("chunkText", () => {
  it.each(["", "small\ntext", "1234567890"])("preserves under-budget input %j", (text) => {
    expect(chunkText(text, 10)).toEqual([text]);
  });

  it("greedily packs complete lines and includes their separators", () => {
    expect(chunkText("ab\ncd\nef\ngh\n", 6)).toEqual(["ab\ncd\n", "ef\ngh\n"]);
    expect(chunkText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  it("losslessly reassembles adversarial newlines, hard splits, Unicode, and exact boundaries", () => {
    for (const text of ["\n\n\n", "abcd\n", "a\r\nb\r\n", "x\nabcdefghijkl\nz\n", "雪😀\n🚀", "x".repeat(100_001)]) {
      for (const budget of [1, 2, 3, 7, 100_000]) {
        const chunks = chunkText(text, budget);
        expect(chunks.join("")).toBe(text);
        expect(chunks.every((chunk) => chunk.length > 0 && chunk.length <= budget)).toBe(true);
      }
    }
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid budget %s", (budget) => {
    expect(() => chunkText("", budget)).toThrow(/budget/);
  });
});

it("merges all array fields with ordered trimmed deduplication, first topic/context, and all summaries", () => {
  const first = parseDistilledNote('{"summary":" first ","context":"why"}');
  const second = parseDistilledNote('{"topic":"topic","summary":"second","context":"later"}');
  for (const key of ["key_details", "decisions", "derived_conclusions", "code_implementation", "preferences_corrections", "open_threads", "tags"] as const) {
    first[key] = ["a", " a ", "", "  "];
    second[key] = ["b", "a", "B"];
  }
  const merged = mergeNotes([first, second, parseDistilledNote("{}")]);
  expect(merged).toEqual({ ...second, context: "why", summary: "first; second",
    key_details: ["a", "b", "B"], decisions: ["a", "b", "B"], derived_conclusions: ["a", "b", "B"],
    code_implementation: ["a", "b", "B"], preferences_corrections: ["a", "b", "B"], open_threads: ["a", "b", "B"], tags: ["a", "b", "B"],
  });
  expect(mergeNotes([])).toEqual(parseDistilledNote("{}"));
  expect(first.key_details).toEqual(["a", " a ", "", "  "]);
});
