import { chmodSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

// Everything Openfield owns lives under one folder, OPENFIELD_HOME (§8.1).

export interface HomePaths {
  root: string;
  config: string;
  configBackup: string;
  db: string;
  assets: string;
  uploads: string;
  thumbs: string;
  logs: string;
  tmp: string;
  /** The person's own model list (§6.4). */
  modelsJson: string;
  /** Held by the running server so a second one can't share the library. */
  lock: string;
}

/** Subfolders created at boot. Missing ones are made again, never an error. */
const LAYOUT = [
  "assets",
  "uploads",
  "thumbs",
  "presets/exported",
  "presets/imported",
  "canvases/exports",
  "canvases/templates",
  "canvases/previews",
  "logs",
  "backups",
  "tmp/orphans",
];

export const isPosix = process.platform !== "win32";

export function resolveHome(env: Record<string, string | undefined>): string {
  const raw = env.OPENFIELD_HOME?.trim();
  if (!raw) return join(homedir(), ".openfield");
  const expanded = raw === "~" || raw.startsWith("~/") ? join(homedir(), raw.slice(1)) : raw;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

export function homePaths(root: string): HomePaths {
  return {
    root,
    config: join(root, "config.json"),
    configBackup: join(root, "config.json.bak"),
    db: join(root, "openfield.db"),
    assets: join(root, "assets"),
    uploads: join(root, "uploads"),
    thumbs: join(root, "thumbs"),
    logs: join(root, "logs"),
    tmp: join(root, "tmp"),
    modelsJson: join(root, "models.json"),
    lock: join(root, "openfield.lock"),
  };
}

/**
 * Creates the folder tree and keeps the root at 0700 (§6.11). Returns true when the root's mode
 * had drifted and was fixed, so boot can say so in the log.
 */
export function ensureLayout(paths: HomePaths): { rootModeFixed: boolean } {
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  for (const dir of LAYOUT) mkdirSync(join(paths.root, dir), { recursive: true });
  return { rootModeFixed: keepPrivate(paths.root) };
}

/** Puts the library folder back to 0700. True when its mode had drifted and the fix held. */
export function keepPrivate(root: string): boolean {
  if (!isPosix) return false;
  const modeOf = () => statSync(root).mode & 0o777;
  if (modeOf() === 0o700) return false;
  chmodSync(root, 0o700);
  // Some drives ignore chmod. Saving a key there fails on its own, with its own message.
  return modeOf() === 0o700;
}

/** Makes existing files 0600. Best effort: a drive that ignores modes keeps its own. */
export function keepFilePrivate(...files: string[]): void {
  if (!isPosix) return;
  for (const file of files) {
    try {
      chmodSync(file, 0o600);
    } catch {
      // Not there yet, or the drive doesn't do modes.
    }
  }
}

/** A path stored in the database: relative to the root, forward slashes (§0.2). */
export const absolutePath = (paths: HomePaths, relative: string): string =>
  join(paths.root, ...relative.split("/"));
