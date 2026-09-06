import fs from "node:fs";

/**
 * Filesystem-permission contract: `~/.terum/` is 0700; the db and every sidecar
 * it owns (WAL/SHM, byte-offset sidecars) are 0600. Raw prompts/responses and
 * ratification quotes live in these files — visibility is the machine boundary,
 * and that holds only if the OS boundary does. Every entrypoint repairs looser
 * modes and warns; a `~/.terum` owned by another OS user is a hard error.
 * On Windows the user-profile ACL is the boundary; mode bits are not enforced.
 */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export type WarnFn = (message: string) => void;

export function ensureTerumDir(dir: string, warn: WarnFn = console.warn): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    return;
  }
  if (!stat.isDirectory()) {
    throw new Error(`${dir} exists and is not a directory`);
  }
  if (process.platform === "win32") return;
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(
      `${dir} is owned by another OS user (uid ${stat.uid}, we are ${uid}); refusing to use it`,
    );
  }
  if ((stat.mode & 0o777) !== DIR_MODE) {
    fs.chmodSync(dir, DIR_MODE);
    warn(`terum-memory: repaired permissions on ${dir} to 0700`);
  }
}

/** Enforce 0600 on files that exist; missing files are skipped, not errors. */
export function enforceFileModes(files: string[], warn: WarnFn = console.warn): void {
  if (process.platform === "win32") return;
  for (const file of files) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if ((stat.mode & 0o777) !== FILE_MODE) {
      fs.chmodSync(file, FILE_MODE);
      warn(`terum-memory: repaired permissions on ${file} to 0600`);
    }
  }
}
