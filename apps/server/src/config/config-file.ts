import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { newId } from "@openfield/core";
import { z } from "zod";
import { isPosix, keepPrivate } from "./home";

// config.json holds secrets and boot-time values only (§8.1). Everything else is a setting in
// the database. The file is 0600 and its mode is checked after every write (§6.11).

const providerEntrySchema = z.record(z.string(), z.string().nullable());

export const configSchema = z.looseObject({
  version: z.literal(1).default(1),
  port: z.int().min(1).max(65535).optional(),
  providers: z.record(z.string(), providerEntrySchema).default({}),
});

export type ConfigData = z.infer<typeof configSchema>;
export type ProviderConfig = z.infer<typeof providerEntrySchema>;

export class ConfigFileError extends Error {
  override readonly name = "ConfigFileError";
  constructor(
    message: string,
    /** "private": the folder can't keep the file to this user; "write": saving failed. */
    readonly reason: "private" | "write" = "write",
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

const FILE_MODE = 0o600;

export class ConfigStore {
  #data: ConfigData;

  /** Called when a save finds the library folder open to other users and closes it again. */
  onRootFixed: (() => void) | undefined;

  private constructor(
    readonly file: string,
    readonly backup: string,
    data: ConfigData,
    /** True when boot found the file readable by others and fixed it. */
    readonly modeFixed: boolean,
  ) {
    this.#data = data;
  }

  /** Reads the file, or starts empty. A file we can't parse stops boot rather than being overwritten. */
  static open(file: string, backup: string): ConfigStore {
    removeStaleTemps(file);
    // The backup can hold a key too, so it gets the same check.
    const backupFixed = existsSync(backup) && fixMode(backup);
    if (!existsSync(file)) return new ConfigStore(file, backup, configSchema.parse({}), backupFixed);

    const modeFixed = fixMode(file) || backupFixed;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      throw new ConfigFileError(`${file} isn't valid JSON. Fix it or move it aside, then start again.`);
    }
    const parsed = configSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ConfigFileError(`${file} has an unexpected value at "${issue?.path.join(".")}".`);
    }
    return new ConfigStore(file, backup, parsed.data, modeFixed);
  }

  get data(): Readonly<ConfigData> {
    return this.#data;
  }

  provider(id: string): ProviderConfig {
    return { ...this.#data.providers[id] };
  }

  /**
   * Applies a change and writes it out. The previous file is kept as config.json.bak, minus any key
   * this change removed or replaced: a removed key must not live on in the backup.
   */
  update(change: (draft: ConfigData) => void): void {
    const next = structuredClone(this.#data);
    change(next);
    this.#write(configSchema.parse(next));
  }

  #write(next: ConfigData): void {
    // Every other private file depends on the folder's mode, so it's checked on every write (§6.11).
    if (keepPrivate(dirname(this.file))) this.onRootFixed?.();
    if (existsSync(this.file)) writePrivate(this.backup, keptSecrets(this.#data, next));
    writePrivate(this.file, next);
    this.#data = next;
  }
}

/** `previous` with only the provider values that `next` still holds. */
function keptSecrets(previous: ConfigData, next: ConfigData): ConfigData {
  const providers: ConfigData["providers"] = {};
  for (const [id, fields] of Object.entries(previous.providers)) {
    const kept = Object.entries(fields).filter(([name, value]) => next.providers[id]?.[name] === value);
    if (kept.length) providers[id] = Object.fromEntries(kept);
  }
  return { ...previous, providers };
}

/**
 * Written beside the target with 0600 from the start, then renamed, so a crash can't leave a
 * half-written or briefly world-readable file.
 */
function writePrivate(file: string, data: ConfigData): void {
  const tmp = `${file}.${newId()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: FILE_MODE });
    protect(tmp);
    renameSync(tmp, file);
    protect(file);
  } catch (error) {
    // The temp file may hold a key, so it never outlives a failed save.
    rmSync(tmp, { force: true });
    if (error instanceof ConfigFileError) throw error;
    throw new ConfigFileError(`Couldn't save ${file}: ${(error as Error).message}`, "write", {
      cause: error,
    });
  }
}

/** Temp files a crash left mid-write. They may hold a key. */
function removeStaleTemps(file: string): void {
  const prefix = `${basename(file)}.`;
  let names: string[];
  try {
    names = readdirSync(dirname(file));
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith(prefix) && name.endsWith(".tmp")) rmSync(join(dirname(file), name), { force: true });
  }
}

/** Makes a file 0600. True when it wasn't. */
function fixMode(file: string): boolean {
  if (!isPosix || (statSync(file).mode & 0o777) === FILE_MODE) return false;
  chmodSync(file, FILE_MODE);
  return true;
}

/** chmod 0600, then read the mode back: a filesystem that ignores chmod must not hold keys silently. */
function protect(file: string): void {
  if (!isPosix) return;
  chmodSync(file, FILE_MODE);
  const mode = statSync(file).mode & 0o777;
  if (mode !== FILE_MODE) {
    throw new ConfigFileError(`Couldn't make ${file} private (mode ${mode.toString(8)}).`, "private");
  }
}
