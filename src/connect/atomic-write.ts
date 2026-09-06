import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { terumHome } from "../db/paths.js";
import { enforceFileModes, ensureTerumDir } from "../db/permissions.js";

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/** Synchronous same-directory replacement, with durable contents before rename. */
export function atomicWrite(file: string, contents: string, mode = 0o600): void {
  const dir = path.dirname(file);
  const home = path.resolve(terumHome());
  const relative = path.relative(home, path.resolve(dir));
  const underTerum = relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  if (underTerum) ensureTerumDir(dir);
  else if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `.${path.basename(file)}.${randomUUID()}.tmp`);
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    try {
      fs.writeFileSync(fd, contents, "utf8");
      fs.fchmodSync(fd, underTerum ? 0o600 : mode);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (underTerum) enforceFileModes([temp]);
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
