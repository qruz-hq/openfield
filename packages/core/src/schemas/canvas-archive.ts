import { z } from "zod";
import {
  ASSET_KINDS,
  CANVAS_ARCHIVE_FORMAT,
  CANVAS_ARCHIVE_JOB_KINDS,
  CANVAS_ARCHIVE_JOB_STATES,
  EDGE_RELATIONS,
  MODALITIES,
} from "../constants";
import { opSchema, sha256Schema, timestampSchema, ulidSchema, usdSchema } from "./common";
import { apiErrorCodeSchema } from "./errors";

// Canvas archives (§7.8): <name>.ofcanvas.zip holds canvas.json (the document as saved),
// manifest.json (below) and assets/<id>.<ext>, the originals byte for byte, plus a poster beside
// each video. The same files unzipped into a folder import the same way. Exports and imports run
// as jobs the event stream follows (canvas_archive.updated), since a big one outlasts a request.

/** A file's place inside an archive: relative, forward slashes, never climbing out. */
export const archivePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path.includes("\0") &&
      !/^[A-Za-z]:/.test(path) &&
      path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "Not a path inside the archive",
  );

/** One image in manifest.json: its library row, minus what only meant something where it was made. */
export const canvasArchiveAssetSchema = z.object({
  id: ulidSchema,
  /** "assets/<id>.<ext>" */
  file: archivePathSchema,
  /** Videos: the still their thumbnails are made from. */
  poster: archivePathSchema.optional(),
  sha256: sha256Schema,
  bytes: z.int().nonnegative(),
  mime: z.string().min(1).max(100),
  width: z.int().nonnegative(),
  height: z.int().nonnegative(),
  modality: z.enum(MODALITIES).catch("image"),
  /** A kind this build doesn't know reads as imported. */
  kind: z.enum(ASSET_KINDS).catch("imported"),
  seed: z.number().nullable().default(null),
  providerId: z.string().max(200).nullable().default(null),
  modelId: z.string().max(200).nullable().default(null),
  prompt: z.string().default(""),
  params: z.record(z.string(), z.unknown()).nullable().default(null),
  tags: z.string().default(""),
  /** What it cost where it was made. Kept for the record; an import never counts it as spend. */
  costUsd: usdSchema.nullable().default(null),
  parentAssetId: ulidSchema.nullable().default(null),
  rootAssetId: ulidSchema.nullable().default(null),
  op: opSchema.nullable().catch(null).default(null),
  opParams: z.record(z.string(), z.unknown()).nullable().default(null),
  maskAssetId: ulidSchema.nullable().default(null),
  generative: z.boolean().default(true),
  approximate: z.boolean().default(false),
  approximateReason: z.string().nullable().default(null),
  durationMs: z.int().nonnegative().nullable().default(null),
  hasAudio: z.boolean().nullable().default(null),
  createdAt: timestampSchema,
  favourite: z.boolean().default(false),
});

/** A reference or "made from" link between two images (asset_edges), kept where both are there. */
export const canvasArchiveEdgeSchema = z.object({
  parentAssetId: ulidSchema,
  childAssetId: ulidSchema,
  relation: z.enum(EDGE_RELATIONS),
  ordinal: z.int().nonnegative().default(0),
});

export const canvasArchiveManifestSchema = z.object({
  format: z.literal(CANVAS_ARCHIVE_FORMAT),
  appVersion: z.string().max(64).optional(),
  exportedAt: timestampSchema,
  canvas: z.object({
    id: ulidSchema,
    name: z.string().max(200),
    nodeCount: z.int().nonnegative(),
    edgeCount: z.int().nonnegative(),
  }),
  assets: z.array(canvasArchiveAssetSchema),
  edges: z.array(canvasArchiveEdgeSchema).default([]),
  /** Images the canvas shows that weren't in the library to pack (in the Trash, or the file is gone). */
  missing: z.array(ulidSchema).default([]),
});

// Jobs

export const canvasArchiveExportResultSchema = z.object({
  kind: z.literal("export"),
  /** Where the archive was saved. Null for a download, which the browser saves. */
  path: z.string().nullable(),
  bytes: z.int().nonnegative(),
  /** Images packed. */
  assets: z.int().nonnegative(),
  /** Images the canvas shows that couldn't be packed. */
  missing: z.int().nonnegative(),
});

export const canvasArchiveImportResultSchema = z.object({
  kind: z.literal("import"),
  canvasId: ulidSchema,
  name: z.string(),
  /** The library folder its images were filed into, named after the canvas. Null when it shows none. */
  folderId: ulidSchema.nullable(),
  /** Images added to the library. */
  imported: z.int().nonnegative(),
  /** Images the library already had, used as they are. */
  reused: z.int().nonnegative(),
  /** Images the canvas shows that the archive didn't have, or had damaged. They show as missing. */
  missing: z.int().nonnegative(),
});

/** GET /api/canvas-archive-jobs/:id, and the canvas_archive.updated frame. */
export const canvasArchiveJobSchema = z.object({
  jobId: ulidSchema,
  kind: z.enum(CANVAS_ARCHIVE_JOB_KINDS),
  state: z.enum(CANVAS_ARCHIVE_JOB_STATES),
  /** The canvas being exported, or the one an import made, once it exists. */
  canvasId: ulidSchema.nullable(),
  /** The canvas's name, once it's known. */
  name: z.string().nullable(),
  /** Bytes copied so far, out of `total`. 0 of 0 until the size is known. */
  done: z.number().nonnegative(),
  total: z.number().nonnegative(),
  /** Files copied so far, out of total: every file of an export, or the images an import brings in. */
  files: z.object({ done: z.int().nonnegative(), total: z.int().nonnegative() }),
  startedAt: timestampSchema,
  finishedAt: timestampSchema.nullable(),
  result: z
    .discriminatedUnion("kind", [canvasArchiveExportResultSchema, canvasArchiveImportResultSchema])
    .nullable(),
  error: z
    .object({ code: apiErrorCodeSchema, message: z.string(), userMessage: z.string().optional() })
    .nullable(),
});

/** POST /api/canvases/:id/export-to: the desktop app's save dialog picked a place. */
export const canvasExportToBodySchema = z.object({
  /** Absolute, ending in .zip. */
  path: z.string().min(1).max(4096),
  /** Replace a file already there. The save dialog has asked the person. Default false. */
  overwrite: z.boolean().optional(),
});

/**
 * POST /api/canvas-imports: an archive, its unzipped folder or a .ofcanvas.json on this computer
 * (`path`, the desktop app's open dialog), or one the browser sent up first (`uploadId`).
 */
export const canvasImportBodySchema = z
  .object({
    path: z.string().min(1).max(4096).optional(),
    uploadId: ulidSchema.optional(),
    /** The new canvas's name. Default: the name it was exported with. */
    name: z.string().trim().min(1).max(200).optional(),
  })
  .refine((body) => (body.path === undefined) !== (body.uploadId === undefined), {
    message: "Send a path or an uploadId",
    path: ["path"],
  });

/** POST /api/canvas-imports/uploads: a staging area the browser sends an archive's files into. */
export const canvasImportUploadSchema = z.object({ uploadId: ulidSchema });

/**
 * PUT /api/canvas-imports/uploads/:uploadId/files?path=&offset=, the body the raw bytes. A zip is
 * one file; a folder sends each of its files at its path inside the folder. Files go up in pieces
 * of at most CANVAS_IMPORT_CHUNK_BYTES, each at the offset where the last one ended.
 */
export const canvasImportUploadFileQuerySchema = z.object({
  path: archivePathSchema,
  offset: z.coerce.number().int().nonnegative(),
});
export const canvasImportUploadFileResponseSchema = z.object({
  path: z.string(),
  size: z.int().nonnegative(),
});

/**
 * POST /api/canvas-imports/uploads/:uploadId/needed, once canvas.json and manifest.json are up:
 * the files of a folder the library doesn't already have, so the rest needn't be sent.
 */
export const canvasImportNeededResponseSchema = z.object({ files: z.array(z.string()) });

export type CanvasArchiveAsset = z.infer<typeof canvasArchiveAssetSchema>;
export type CanvasArchiveEdge = z.infer<typeof canvasArchiveEdgeSchema>;
export type CanvasArchiveManifest = z.infer<typeof canvasArchiveManifestSchema>;
export type CanvasArchiveExportResult = z.infer<typeof canvasArchiveExportResultSchema>;
export type CanvasArchiveImportResult = z.infer<typeof canvasArchiveImportResultSchema>;
export type CanvasArchiveJob = z.infer<typeof canvasArchiveJobSchema>;
export type CanvasExportToBody = z.infer<typeof canvasExportToBodySchema>;
export type CanvasImportBody = z.infer<typeof canvasImportBodySchema>;
export type CanvasImportUpload = z.infer<typeof canvasImportUploadSchema>;
export type CanvasImportUploadFileQuery = z.infer<typeof canvasImportUploadFileQuerySchema>;
export type CanvasImportUploadFileResponse = z.infer<typeof canvasImportUploadFileResponseSchema>;
export type CanvasImportNeededResponse = z.infer<typeof canvasImportNeededResponseSchema>;
