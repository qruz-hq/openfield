import { statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { documentAssetRefs } from "@openfield/canvas";
import {
  CANVAS_ARCHIVE_FORMAT,
  type CanvasArchiveAsset,
  type CanvasArchiveManifest,
  t,
} from "@openfield/core";
import type { CanvasDocument } from "@openfield/core/canvas";
import { type AssetRow, type Db, edgesInto, getAsset, getCanvas, isFavourite } from "@openfield/db";
import { absolutePath, type HomePaths } from "../config/home";
import { archiveFileName, extensionOf } from "../files/names";
import { planZip, type ZipOptions, type ZipPlan, zipStream } from "../files/zip";
import { ApiFailure } from "../http/errors";
import { CANVAS_FILE, MANIFEST_FILE } from "./archive-source";
import { documentCounts, readDocument } from "./documents";

// Packing a canvas (§7.8): canvas.json as saved, manifest.json with each image's details, and the
// originals byte for byte, as one stored zip whose length is known before the first byte goes out.
// Only what the canvas shows goes in: the images nodes were given and their runs made. Images a
// run read that are no longer on the canvas, versions and spend stay behind.

export interface ArchiveFile {
  /** The name inside the archive. */
  name: string;
  size: number;
  read: () => Promise<Uint8Array>;
}

export interface ArchivePlan {
  canvasId: string;
  /** The canvas's name. */
  name: string;
  /** "<name>.ofcanvas.zip" */
  fileName: string;
  /** Images packed. */
  assets: number;
  /** Images the canvas shows that couldn't be packed. */
  missing: number;
  files: ArchiveFile[];
  zip: ZipPlan;
}

const encoder = new TextEncoder();

/** The archive for a canvas as it's saved now. With `graphVersion`, a canvas changed since is a 409. */
export function planExport(
  deps: { db: Db; paths: HomePaths; version: string },
  canvasId: string,
  opts: { graphVersion?: number; zip?: ZipOptions } = {},
): ArchivePlan {
  const { db, paths } = deps;
  const row = getCanvas(db, canvasId);
  if (!row) throw new ApiFailure(404, "not_found", "That canvas doesn't exist", { field: "id" });
  if (opts.graphVersion !== undefined && opts.graphVersion !== row.graphVersion) {
    throw new ApiFailure(409, "conflict", `graphVersion is ${row.graphVersion}`, {
      field: "graphVersion",
      userMessage: t("errors.transport.conflict"),
    });
  }
  // A preview path means nothing in another library; the index card falls back to the cover.
  const saved = readDocument(row.graph);
  const doc: CanvasDocument = { ...saved, name: row.name, meta: { ...saved.meta, previewPath: null } };

  const files: ArchiveFile[] = [];
  const assets: CanvasArchiveAsset[] = [];
  const missing: string[] = [];
  for (const id of documentAssetRefs(doc).shown) {
    // Images in the Trash show as missing on the canvas, so they stay missing in its archive.
    const asset = getAsset(db, id);
    const file = asset?.fileState === "ok" ? fileIn(paths, asset.path) : null;
    if (!asset || !file) {
      missing.push(id);
      continue;
    }
    const name = `assets/${asset.id}.${extensionOf(asset.mime)}`;
    files.push({ name, size: file.size, read: () => Bun.file(file.path).bytes() });
    const posterFile = asset.posterPath ? fileIn(paths, asset.posterPath) : null;
    let poster: string | undefined;
    if (posterFile) {
      poster = `assets/${asset.id}.poster.${asset.posterPath!.split(".").at(-1)!.toLowerCase()}`;
      files.push({ name: poster, size: posterFile.size, read: () => Bun.file(posterFile.path).bytes() });
    }
    assets.push(manifestAsset(asset, name, poster, isFavourite(db, asset.id)));
  }

  const packed = new Set(assets.map((a) => a.id));
  const { nodeCount, edgeCount } = documentCounts(doc);
  const manifest: CanvasArchiveManifest = {
    format: CANVAS_ARCHIVE_FORMAT,
    appVersion: deps.version,
    exportedAt: new Date().toISOString(),
    canvas: { id: row.id, name: row.name, nodeCount, edgeCount },
    assets,
    // What each image was made from, wherever that is: the importing library keeps the links whose
    // other end it has.
    edges: edgesInto(db, [...packed]).map((e) => ({
      parentAssetId: e.parentAssetId,
      childAssetId: e.childAssetId,
      relation: e.relation,
      ordinal: e.ordinal,
    })),
    missing,
  };
  const canvasJson = encoder.encode(`${JSON.stringify(doc, null, 2)}\n`);
  const manifestJson = encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`);
  // The document and manifest first, so a reader streaming the zip knows what follows.
  files.unshift(
    { name: CANVAS_FILE, size: canvasJson.byteLength, read: async () => canvasJson },
    { name: MANIFEST_FILE, size: manifestJson.byteLength, read: async () => manifestJson },
  );
  const at = new Date();
  const zip = planZip(
    files.map((f) => ({ name: f.name, size: f.size, modifiedAt: at })),
    opts.zip,
  );
  return {
    canvasId: row.id,
    name: row.name,
    fileName: archiveFileName(row.name, t("canvas.names.untitled")),
    assets: assets.length,
    missing: missing.length,
    files,
    zip,
  };
}

/** The archive's bytes. A file that changed size since it was planned stops the stream. */
export function archiveStream(
  plan: ArchivePlan,
  onError?: (error: unknown) => void,
): ReadableStream<Uint8Array> {
  return zipStream(plan.zip, (index) => plan.files[index]!.read(), onError);
}

function manifestAsset(
  row: AssetRow,
  file: string,
  poster: string | undefined,
  favourite: boolean,
): CanvasArchiveAsset {
  return {
    id: row.id,
    file,
    ...(poster && { poster }),
    sha256: row.sha256,
    bytes: row.bytes,
    mime: row.mime,
    width: row.width,
    height: row.height,
    modality: row.modality as CanvasArchiveAsset["modality"],
    kind: row.kind,
    seed: row.seed,
    providerId: row.providerId,
    modelId: row.modelId,
    prompt: row.prompt,
    params: row.params ?? null,
    tags: row.tags,
    costUsd: row.costUsd,
    parentAssetId: row.parentAssetId,
    rootAssetId: row.rootAssetId,
    op: row.op,
    opParams: row.opParams ?? null,
    maskAssetId: row.maskAssetId,
    generative: row.generative,
    approximate: row.approximate,
    approximateReason: row.approximateReason,
    durationMs: row.durationMs,
    hasAudio: row.hasAudio,
    createdAt: row.createdAt,
    favourite,
  };
}

/** A stored file that's there, inside the library folder. Anything else is never read. */
function fileIn(paths: HomePaths, relative: string): { path: string; size: number } | null {
  const root = resolve(paths.root) + sep;
  const full = resolve(absolutePath(paths, relative));
  if (!full.startsWith(root)) return null;
  try {
    const stat = statSync(full);
    return stat.isFile() ? { path: full, size: stat.size } : null;
  } catch {
    return null;
  }
}
