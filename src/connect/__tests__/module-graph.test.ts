import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

it("capture's transitive module graph excludes embedding and compaction engines", () => {
  const visited = new Set<string>();
  function walk(file: string): void {
    if (visited.has(file)) return;
    visited.add(file);
    const source = fs.readFileSync(file, "utf8");
    // Include static imports/reexports, bare imports and literal dynamic loads.
    const imports = /(?:\bfrom\s*|\bimport\s*|\b(?:import|require)\s*\(\s*)["']([^"']+)["']/g;
    for (const match of source.matchAll(imports)) {
      const specifier = match[1]!;
      expect(specifier).not.toMatch(/@huggingface\/transformers|embedder|compactor|compact(?:ion)?\.js/);
      if (specifier.startsWith(".")) walk(path.resolve(path.dirname(file), specifier.replace(/\.js$/, ".ts")));
    }
  }
  walk(path.resolve("src/connect/capture.ts"));
  expect(visited.has(path.resolve("src/jobs/queue.ts"))).toBe(true);
  expect(visited.has(path.resolve("src/db/paths.ts"))).toBe(true);
});
