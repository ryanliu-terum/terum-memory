import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("keeps transformers package references (including imports and re-exports) inside embedder.ts", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const importers: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === "__tests__") continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(file); continue; }
      // Deliberately broader than import syntax: also catches dynamic imports,
      // require, subpaths, and re-exports without depending on a TS parser API.
      if ((await readFile(file, "utf8")).includes("@huggingface/transformers")) {
        importers.push(path.relative(root, file).split(path.sep).join("/"));
      }
    }
  }
  await walk(root);
  expect(importers).toEqual(["engine/embedder.ts"]);
});
