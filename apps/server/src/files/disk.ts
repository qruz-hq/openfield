import { existsSync, statfsSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

// Sizes for Settings > Storage (§8.6).

export const fileSize = (file: string): number => (existsSync(file) ? statSync(file).size : 0);

export async function directorySize(dir: string): Promise<number> {
  let total = 0;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += await directorySize(path);
    else if (entry.isFile()) total += (await stat(path).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

/** Free space on the library's disk, or null when the platform won't say. */
export function freeSpace(dir: string): number | null {
  try {
    const fs = statfsSync(dir);
    return Number(fs.bavail) * Number(fs.bsize);
  } catch {
    return null;
  }
}
