import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { buildBackfillSnapshot, scanTranscripts } from "../scan.js";
import { session } from "./fixtures.js";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "backfill-scan-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

it("scans one project level newest-first, retaining sizes/mtimes and excluding sidecars", () => {
  const project = path.join(dir, "project");
  fs.mkdirSync(project);
  const files = [session(project, "old", "old\n"), session(dir, "new", "newest\n"), session(project, "middle", "middle\n")];
  [1000, 3000, 2000].forEach((mtime, i) => fs.utimesSync(files[i]!, mtime, mtime));
  fs.writeFileSync(`${files[0]}.terum-offset`, "{}");
  fs.mkdirSync(path.join(project, "nested"));
  session(path.join(project, "nested"), "excluded");
  fs.symlinkSync(files[0]!, path.join(dir, "linked.jsonl"));
  expect(scanTranscripts({ projectsDir: dir }).transcripts).toEqual([files[1], files[2], files[0]].map(file => ({
    path: file, mtimeMs: fs.statSync(file!).mtimeMs, sizeBytes: fs.statSync(file!).size,
  })));
});

it("breaks mtime ties by path and returns empty only for missing roots", () => {
  const b = session(dir, "b");
  const a = session(dir, "a");
  for (const file of [a, b]) fs.utimesSync(file, 1000, 1000);
  expect(scanTranscripts({ projectsDir: dir }).transcripts.map(item => item.path)).toEqual([a, b]);
  expect(scanTranscripts({ projectsDir: path.join(dir, "missing") })).toEqual({ transcripts: [] });
  expect(() => scanTranscripts({ projectsDir: a })).toThrow();
});

it("persists the entire capped snapshot and takes ages only from omitted transcripts", () => {
  const scan = { transcripts: [9000, 7000, 3000].map((mtimeMs, i) => ({ path: `${i}.jsonl`, mtimeMs, sizeBytes: i })) };
  const result = buildBackfillSnapshot(scan, 1);
  expect(result).toMatchObject({ selected: ["0.jsonl"], omitted: ["1.jsonl", "2.jsonl"],
    omittedAgeRange: { newestMtimeMs: 7000, oldestMtimeMs: 3000 } });
  expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  expect(Number.isFinite(Date.parse(result.scannedAt))).toBe(true);
  scan.transcripts[0]!.path = "changed";
  expect(result.selected).toEqual(["0.jsonl"]);
  expect(buildBackfillSnapshot(scan, 3).omittedAgeRange).toBeNull();
  expect(buildBackfillSnapshot(scan, 0).omitted).toHaveLength(3);
  expect(buildBackfillSnapshot({ transcripts: [] }, 50).selected).toEqual([]);
});

it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid limit %s", limit => {
  expect(() => buildBackfillSnapshot({ transcripts: [] }, limit)).toThrow(/limit/);
});
