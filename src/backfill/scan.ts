import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface TranscriptScan {
  transcripts: Array<{ path: string; mtimeMs: number; sizeBytes: number }>;
}

export interface BackfillSnapshot {
  selected: string[];
  omitted: string[];
  omittedAgeRange: { newestMtimeMs: number; oldestMtimeMs: number } | null;
  scannedAt: string;
}

/** Scan root files and immediate project directories; do not follow symlinks. */
export function scanTranscripts(opts: { projectsDir?: string } = {}): TranscriptScan {
  const root = path.resolve(opts.projectsDir ?? path.join(os.homedir(), ".claude", "projects"));
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { transcripts: [] };
    throw error;
  }
  const transcripts: TranscriptScan["transcripts"] = [];
  function add(dir: string, entry: fs.Dirent): void {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) return;
    const file = path.join(dir, entry.name);
    const stat = fs.statSync(file);
    transcripts.push({ path: file, mtimeMs: stat.mtimeMs, sizeBytes: stat.size });
  }
  for (const entry of entries) {
    add(root, entry);
    if (entry.isDirectory()) {
      const dir = path.join(root, entry.name);
      for (const child of fs.readdirSync(dir, { withFileTypes: true })) add(dir, child);
    }
  }
  transcripts.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { transcripts };
}

export function buildBackfillSnapshot(scan: TranscriptScan, limit: number): BackfillSnapshot {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("limit must be a nonnegative safe integer");
  const omitted = scan.transcripts.slice(limit);
  return {
    selected: scan.transcripts.slice(0, limit).map(item => item.path),
    omitted: omitted.map(item => item.path),
    omittedAgeRange: omitted.length === 0 ? null : {
      newestMtimeMs: omitted.reduce((max, item) => Math.max(max, item.mtimeMs), -Infinity),
      oldestMtimeMs: omitted.reduce((min, item) => Math.min(min, item.mtimeMs), Infinity),
    },
    scannedAt: new Date().toISOString(),
  };
}
