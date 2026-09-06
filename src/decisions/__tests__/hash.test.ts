import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { decisionContentHash as compactorHash } from "../../engine/compactor.js";
import { decisionContentHash } from "../hash.js";

it("normalizes case and all whitespace while preserving meaningful differences", () => {
  const expected = createHash("sha256").update("use sqlite locally").digest("hex");
  expect(decisionContentHash(" \tUse\r\n SQLITE\u00a0 locally  ")).toBe(expected);
  expect(decisionContentHash("use sqlite locally")).toBe(expected);
  expect(decisionContentHash("do not use sqlite locally")).not.toBe(expected);
  expect(decisionContentHash(" ")).toBe(createHash("sha256").update("").digest("hex"));
  expect(compactorHash).toBe(decisionContentHash);
});
