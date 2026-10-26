import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import { t } from "@openfield/core";
import { normalName, ZipArchive, ZipError, type ZipFileEntry } from "../files/unzip";
import { ApiFailure } from "../http/errors";

// What an import reads from (§7.8): a .ofcanvas.zip, the same files unzipped into a folder, or a
// plain .ofcanvas.json with the document alone. Each is read by name, "canvas.json" or
// "assets/<id>.png", from the archive's root: the folder holding canvas.json, which may sit one
// level down when the zip or the folder wraps everything in a folder of its own.

export const CANVAS_FILE = "canvas.json";
export const MANIFEST_FILE = "manifest.json";

export interface ArchiveSource {
  readonly kind: "zip" | "folder" | "json";
  /**
   * Everything above the archive's root, "Lighthouse.ofcanvas/" or "", so names can be given back
   * as the folder that was picked has them.
   */
  readonly prefix: string;
  /** A file's size in bytes, or null when the archive doesn't have it. */
  size(name: string): number | null;
  /** A file's text, or null when the archive doesn't have it. Past `maxBytes` it's refused. */
  text(name: string, maxBytes: number): Promise<string | null>;
  /** A file's bytes. Fails for a file the archive doesn't have. */
  open(name: string): Promise<ReadableStream<Uint8Array>>;
}

export const notArchive = (detail: string) =>
  new ApiFailure(400, "bad_request", detail, { userMessage: t("canvas.archive.errors.notArchive") });

/** Opens whatever is at `path`: a folder, a .json document, or a zip. */
export async function openArchiveSource(path: string): Promise<ArchiveSource> {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    throw new ApiFailure(404, "not_found", `Nothing at ${path}`, {
      userMessage: t("canvas.archive.errors.notFound", { path }),
    });
  }
  if (stat.isDirectory()) return folderSource(path);
  if (!stat.isFile()) throw notArchive(`${path} isn't a file or a folder`);
  if (await looksLikeZip(path)) return zipSource(path);
  if (path.toLowerCase().endsWith(".json")) return jsonSource(path, stat.size);
  throw notArchive(`${path} isn't a zip or a .json file`);
}

/** Zips start with a local header, or an end record when empty. */
async function looksLikeZip(path: string): Promise<boolean> {
  const file = await open(path, "r");
  try {
    const head = new Uint8Array(4);
    const { bytesRead } = await file.read(head, 0, 4, 0);
    return bytesRead === 4 && head[0] === 0x50 && head[1] === 0x4b && (head[2] === 3 || head[2] === 5);
  } finally {
    await file.close();
  }
}

/**
 * Where the archive's root is among `names`: "" when canvas.json is at the top, or the one folder
 * that holds it one level down. Null when there's no single canvas.json to be found.
 */
export function archiveRoot(names: Iterable<string>): string | null {
  const tops: string[] = [];
  for (const name of names) {
    if (name === CANVAS_FILE) return "";
    const parts = name.split("/");
    if (parts.length === 2 && parts[1] === CANVAS_FILE) tops.push(`${parts[0]}/`);
  }
  return tops.length === 1 ? tops[0]! : null;
}

async function zipSource(path: string): Promise<ArchiveSource> {
  let zip: ZipArchive;
  try {
    zip = await ZipArchive.open(path);
  } catch (error) {
    if (error instanceof ZipError) throw notArchive(error.message);
    throw error;
  }
  const prefix = archiveRoot(zip.entries.map((e) => e.name));
  if (prefix === null) throw notArchive(`${basename(path)} has no ${CANVAS_FILE}`);
  const entries = new Map<string, ZipFileEntry>();
  for (const entry of zip.entries) {
    if (entry.name.startsWith(prefix)) entries.set(entry.name.slice(prefix.length), entry);
  }
  const entry = (name: string) => {
    const found = entries.get(name);
    if (!found) throw notArchive(`The archive has no ${name}`);
    return found;
  };
  return {
    kind: "zip",
    prefix,
    size: (name) => entries.get(name)?.size ?? null,
    text: async (name, maxBytes) => {
      const found = entries.get(name);
      if (!found) return null;
      if (found.size > maxBytes) throw tooBig(name);
      return readText(await zip.open(found));
    },
    open: (name) => zip.open(entry(name)),
  };
}

function folderSource(dir: string): ArchiveSource {
  const real = realpathSync(dir);
  const prefix = archiveRoot(topNames(real));
  if (prefix === null) throw notArchive(`${dir} has no ${CANVAS_FILE}`);
  const root = join(real, prefix);
  /** The file a name stands for, never outside the folder, never through a link out of it. */
  const fileOf = (name: string): string | null => {
    let clean: string | null;
    try {
      clean = normalName(name);
    } catch {
      return null;
    }
    if (clean === null || clean !== name) return null;
    const full = join(root, ...name.split("/"));
    try {
      const resolved = realpathSync(full);
      if (!resolved.startsWith(real + sep)) return null;
      return statSync(resolved).isFile() ? resolved : null;
    } catch {
      return null;
    }
  };
  return {
    kind: "folder",
    prefix,
    size: (name) => {
      const file = fileOf(name);
      return file ? statSync(file).size : null;
    },
    text: async (name, maxBytes) => {
      const file = fileOf(name);
      if (!file) return null;
      if (statSync(file).size > maxBytes) throw tooBig(name);
      return Bun.file(file).text();
    },
    open: async (name) => {
      const file = fileOf(name);
      if (!file) throw notArchive(`The folder has no ${name}`);
      return Bun.file(file).stream();
    },
  };
}

/** canvas.json and the folders at the top that might hold it, without walking the whole tree. */
function topNames(dir: string): string[] {
  const names: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name === CANVAS_FILE) return [CANVAS_FILE];
    if (!entry.isDirectory() || entry.name === "__MACOSX") continue;
    try {
      if (lstatSync(join(dir, entry.name, CANVAS_FILE)).isFile()) names.push(`${entry.name}/${CANVAS_FILE}`);
    } catch {
      // Not this one.
    }
  }
  return names;
}

/** A .ofcanvas.json: the document and nothing else, so its images show as missing unless they're here. */
function jsonSource(path: string, bytes: number): ArchiveSource {
  return {
    kind: "json",
    prefix: "",
    size: (name) => (name === CANVAS_FILE ? bytes : null),
    text: async (name, maxBytes) => {
      if (name !== CANVAS_FILE) return null;
      if (bytes > maxBytes) throw tooBig(name);
      return Bun.file(path).text();
    },
    open: async (name) => {
      if (name !== CANVAS_FILE) throw notArchive(`A canvas file has no ${name}`);
      return Bun.file(path).stream();
    },
  };
}

function tooBig(name: string): ApiFailure {
  return new ApiFailure(400, "payload_too_large", `${name} is too big`, {
    userMessage: t("canvas.archive.errors.tooBig"),
  });
}

async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
  try {
    return await new Response(stream).text();
  } catch (error) {
    if (error instanceof ZipError) throw notArchive(error.message);
    throw error;
  }
}
