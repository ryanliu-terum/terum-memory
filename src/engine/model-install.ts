import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { modelsDir as defaultModelsDir } from "../db/paths.js";
import { enforceFileModes, ensureTerumDir } from "../db/permissions.js";
import type { EmbedderManifest } from "./models.js";

const SIDECARS = ["config.json", "tokenizer.json", "tokenizer_config.json"];

function safeRelativePath(value: string): boolean {
  return value.split("/").every((part) => /^[\w.-]+$/.test(part) && part !== "." && part !== "..");
}

async function atomicFile(file: string, write: (handle: FileHandle) => Promise<void>): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, "wx", 0o600);
    try {
      enforceFileModes([temp]);
      await write(handle);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
  } catch (error) {
    try {
      await rm(temp, { force: true });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `Failed to write and clean up ${file}`);
    }
    throw error;
  }
}

export async function ensureModelInstalled(
  manifest: EmbedderManifest,
  opts: { fetchImpl?: typeof fetch; modelsDir?: string; onProgress?: (msg: string) => void } = {},
): Promise<string> {
  if (!manifest.revision || !manifest.sha256) {
    throw new Error(`embedder "${manifest.id}" artifact pin is an unmeasured placeholder (revision/sha256 missing)`);
  }
  if (!/^[a-fA-F0-9]{64}$/.test(manifest.sha256)) {
    throw new Error(`Invalid sha256 pin for embedder "${manifest.id}"`);
  }
  if (!safeRelativePath(manifest.id) || manifest.id.includes("/") ||
      !safeRelativePath(manifest.hfRepo) || !safeRelativePath(manifest.onnxFile) ||
      !manifest.onnxFile.endsWith(".onnx")) {
    throw new Error(`Invalid model id, repository, or ONNX relative path for "${manifest.id}"`);
  }

  const root = path.resolve(opts.modelsDir ?? defaultModelsDir());
  if (opts.modelsDir === undefined) ensureTerumDir(path.dirname(root));
  ensureTerumDir(root);
  const directory = path.join(root, manifest.id);
  ensureTerumDir(directory);
  const files = [...SIDECARS, manifest.onnxFile];
  for (const file of files) {
    let parent = directory;
    for (const part of file.split("/").slice(0, -1)) {
      parent = path.join(parent, part);
      ensureTerumDir(parent);
    }
  }
  const markerPath = path.join(directory, ".installed.json");
  enforceFileModes([...files.map((file) => path.join(directory, file)), markerPath]);
  let markerText: string | undefined;
  try {
    markerText = await readFile(markerPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (markerText !== undefined) {
    const marker: unknown = JSON.parse(markerText);
    if (typeof marker !== "object" || marker === null ||
        !("revision" in marker) || !("sha256" in marker)) {
      throw new Error(`Invalid install marker for "${manifest.id}"; use reembed to repair it`);
    }
    if (marker.revision !== manifest.revision || marker.sha256 !== manifest.sha256) {
      throw new Error(
        `Model "${manifest.id}" installed pin revision=${String(marker.revision)} sha256=${String(marker.sha256)} ` +
        `disagrees with requested pin revision=${manifest.revision} sha256=${manifest.sha256}; use reembed`,
      );
    }
    return directory;
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  for (const file of files) {
    opts.onProgress?.(`Downloading ${manifest.id}/${file}`);
    const url = `https://huggingface.co/${manifest.hfRepo}/resolve/${encodeURIComponent(manifest.revision)}/${file}`;
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Download ${file} failed: HTTP ${response.status}`);
    if (!response.body) throw new Error(`Download ${file} returned no body`);
    await atomicFile(path.join(directory, file), async (handle) => {
      const hash = createHash("sha256");
      const reader = response.body!.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          hash.update(value);
          await handle.writeFile(value);
        }
      } finally {
        reader.releaseLock();
      }
      const actual = hash.digest("hex");
      if (file === manifest.onnxFile && actual !== manifest.sha256) {
        throw new Error(`Checksum mismatch for ${file}: expected ${manifest.sha256}, got ${actual}`);
      }
    });
  }
  await atomicFile(markerPath, async (handle) => {
    await handle.writeFile(JSON.stringify({
      id: manifest.id,
      revision: manifest.revision,
      sha256: manifest.sha256,
      installedAt: new Date().toISOString(),
    }));
  });
  return directory;
}
