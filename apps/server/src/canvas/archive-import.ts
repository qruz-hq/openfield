import {
  describeIssue,
  documentAssetRefs,
  type EngineContext,
  fromDocument,
  hasIssues,
  planFingerprints,
  remapDocumentAssets,
  remapDocumentIds,
  resolveFingerprints,
  specRegistry,
} from "@openfield/canvas";
import {
  CANVAS_ARCHIVE_FORMAT,
  type CanvasArchiveAsset,
  type CanvasArchiveEdge,
  type CanvasArchiveImportResult,
  canvasArchiveAssetSchema,
  canvasArchiveEdgeSchema,
  canvasSource,
  newId,
  parseCanvasSource,
  THUMB_RUNGS,
  t,
} from "@openfield/core";
import type { CanvasDocument } from "@openfield/core/canvas";
import {
  type AssetRow,
  addToFolder,
  createFolder,
  type Db,
  type EdgeDraft,
  type Executor,
  findLiveAssetBySha256,
  getAsset,
  getCanvas,
  insertAsset,
  insertAssetEdges,
  isFavourite,
  setFavourite,
} from "@openfield/db";
import { isProviderError } from "@openfield/providers/server";
import { z } from "zod";
import type { EventHub } from "../events/hub";
import { type Ingest, isVideoMime, type StagedFile } from "../files/ingest";
import { Thumbs, thumbSourceOf } from "../files/thumbs";
import { ApiFailure } from "../http/errors";
import type { Logger } from "../log/logger";
import { toAssetListItem } from "../mappers/asset";
import type { SettingsService } from "../services/settings";
import { type ArchiveSource, CANVAS_FILE, MANIFEST_FILE, notArchive } from "./archive-source";
import type { CanvasService } from "./canvases";
import { readDocument } from "./documents";

// Bringing a canvas archive into this library (§7.8). Images the library already has are used as
// they are: the same id with the same bytes, or the same bytes under another id (the canvas is
// pointed at that one, and nodes that were up to date stay so). New images come in under their
// own id, or a new one when that id is taken by an image in the Trash. Files are staged first;
// then one transaction adds the folder named after the canvas, the images, their links and the
// canvas, so a failure or a cancel leaves nothing behind. Nothing it brings counts as spend.

export interface ImportDeps {
  db: Db;
  ingest: Ingest;
  thumbs: Thumbs;
  events: EventHub;
  logger: Logger;
  settings: SettingsService;
  canvases: CanvasService;
  engineContext: () => EngineContext;
}

export interface ImportProgress {
  /** The canvas's name, once canvas.json is read. */
  named(name: string): void;
  /** How many files and bytes there are to copy, once that's known. */
  sized(files: number, bytes: number): void;
  /** Bytes copied since the last call. */
  copied(bytes: number): void;
  /** One more file done. */
  fileDone(): void;
  /** Everything is staged and the library is about to change: too late to cancel. */
  committing(): void;
}

/** canvas.json is a saved canvas, which the server caps at this (app.ts). */
export const CANVAS_JSON_MAX = 8 * 1024 * 1024;
export const MANIFEST_MAX = 64 * 1024 * 1024;
const NAME_MAX = 200;

const looseManifest = z.object({
  format: z.string(),
  canvas: z.object({ id: z.string().optional(), name: z.string().optional() }).optional(),
  assets: z.array(z.unknown()).default([]),
  edges: z.array(z.unknown()).default([]),
});

interface Manifest {
  canvasId: string | null;
  name: string | null;
  assets: CanvasArchiveAsset[];
  edges: CanvasArchiveEdge[];
}

interface Staged {
  entry: CanvasArchiveAsset;
  /** The id it gets here: its own, unless that's taken. */
  id: string;
  file: StagedFile;
  /** Videos: the poster staged beside it. */
  poster: string | null;
}

export async function importArchive(
  deps: ImportDeps,
  source: ArchiveSource,
  opts: { name?: string },
  progress: ImportProgress,
  signal: AbortSignal,
): Promise<CanvasArchiveImportResult> {
  const { db, ingest, logger } = deps;
  const original = await readArchiveDocument(source);
  const manifest = await readManifest(source);
  const name = (
    opts.name ??
    (original.name.trim() || manifest?.name?.trim() || t("canvas.names.untitled"))
  ).slice(0, NAME_MAX);
  progress.named(name);

  // What's already here, what has to come in, and what can't.
  const entries = new Map((manifest?.assets ?? []).map((a) => [a.id, a]));
  /** Archive id to library id, where they differ. */
  const moved = new Map<string, string>();
  const reused = new Set<string>();
  const missing = new Set<string>();
  const wanted: { entry: CanvasArchiveAsset; id: string }[] = [];
  /** `onCanvas`: the canvas shows it, so one that can't come in counts as missing. */
  const consider = (id: string, onCanvas: boolean) => {
    const entry = entries.get(id);
    const here = getAsset(db, id);
    if (here && (!entry || here.sha256 === entry.sha256)) {
      reused.add(id);
      return;
    }
    if (!entry) {
      if (onCanvas) missing.add(id);
      return;
    }
    const same = liveCopy(db, entry.sha256);
    if (same) {
      moved.set(id, same.id);
      reused.add(same.id);
      return;
    }
    if (source.size(entry.file) === null) {
      if (onCanvas) missing.add(id);
      return;
    }
    // The id is free unless an image in the Trash (or other bytes) holds it.
    const taken = getAsset(db, id, { includeDeleted: true });
    wanted.push({ entry, id: taken ? newId() : id });
  };
  const shown = documentAssetRefs(original).shown;
  for (const id of shown) consider(id, true);
  // The masks new edits were made with come along, so each keeps the one its details show. An
  // edit already here has its own.
  const masks = archivedMasks(
    shown,
    wanted.map((w) => w.entry),
  );
  for (const id of masks) consider(id, false);
  const sizeOf = (name: string | undefined) => (name ? (source.size(name) ?? 0) : 0);
  progress.sized(
    wanted.length,
    wanted.reduce((sum, { entry }) => sum + sizeOf(entry.file) + sizeOf(entry.poster), 0),
  );

  const staged: Staged[] = [];
  /** The first of the new images with these bytes: one more with the same bytes shares its file. */
  const bySha = new Map<string, Staged>();
  const discard = () => {
    for (const s of staged) {
      ingest.discard(s.file);
      if (s.poster && !s.file.duplicate) ingest.discardPath(s.poster);
    }
  };
  let committed: {
    folderId: string | null;
    created: ReturnType<CanvasService["insertImported"]>;
    rows: AssetRow[];
  };
  try {
    for (const want of wanted) {
      signal.throwIfAborted();
      const twin = bySha.get(want.entry.sha256);
      if (twin) {
        if (want.id !== want.entry.id) moved.set(want.entry.id, want.id);
        staged.push({
          entry: want.entry,
          id: want.id,
          file: { ...twin.file, duplicate: true },
          poster: twin.poster,
        });
        progress.copied(sizeOf(want.entry.file) + sizeOf(want.entry.poster));
        progress.fileDone();
        continue;
      }
      try {
        const file = await ingest.stage(counted(await source.open(want.entry.file), progress, signal), {
          folder: "assets",
          video: true,
        });
        // The manifest got its bytes wrong, or they arrived meanwhile: the image already here wins.
        const same = file.duplicate ? liveCopy(db, file.sha256) : undefined;
        if (same) {
          moved.set(want.entry.id, same.id);
          reused.add(same.id);
          continue;
        }
        if (want.id !== want.entry.id) moved.set(want.entry.id, want.id);
        const record: Staged = { entry: want.entry, id: want.id, file, poster: null };
        staged.push(record);
        if (isVideoMime(file.mime))
          record.poster = await stagePoster(deps, source, want.entry, file, progress, signal);
        bySha.set(file.sha256, record);
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (isProviderError(error) && error.code === "disk_full") throw error;
        // A damaged or unreadable image is left out; the canvas shows it as missing.
        logger.warn("An image in a canvas archive couldn't be read", { file: want.entry.file, error });
        missing.add(want.entry.id);
      } finally {
        progress.fileDone();
      }
    }
    signal.throwIfAborted();

    const doc = await normalise(original, moved, deps.engineContext());
    const { doc: renamed, nodeIds } = remapDocumentIds(doc);
    signal.throwIfAborted();

    progress.committing();
    const archiveCanvasId = manifest?.canvasId ?? original.id;
    const inserted = new Set(staged.map((s) => s.id));
    committed = db.transaction((tx) => {
      const filed = [...reused, ...inserted];
      const folderId = filed.length ? createFolder(tx, { id: newId(), name }).id : null;
      const canvasId = newId();
      const rows: AssetRow[] = [];
      // Masks first: an edit's row can only name its mask once the mask is a row (a foreign key).
      const ordered = [...staged].sort((a, b) => Number(isMask(b)) - Number(isMask(a)));
      for (const s of ordered) {
        rows.push(insertAsset(tx, assetRow(tx, s, moved, inserted, { archiveCanvasId, canvasId, nodeIds })));
      }
      insertAssetEdges(tx, edgesFor(tx, manifest?.edges ?? [], moved, inserted));
      setFavourite(
        tx,
        staged.filter((s) => s.entry.favourite).map((s) => s.id),
      );
      if (folderId) addToFolder(tx, folderId, filed);
      const created = deps.canvases.insertImported(tx, renamed, { name, folderId, id: canvasId });
      return { folderId, created, rows };
    });
  } catch (error) {
    // Nothing reached the library, so nothing staged for it may stay.
    discard();
    throw error;
  }
  committed.created.settle();
  announce(deps, committed.folderId, committed.rows);
  return {
    kind: "import",
    canvasId: committed.created.detail.id,
    name: committed.created.detail.name,
    folderId: committed.folderId,
    imported: staged.length,
    reused: reused.size,
    missing: missing.size,
  };
}

/** The document, current and checked, with the reasons a person can act on when it isn't. */
async function readArchiveDocument(source: ArchiveSource): Promise<CanvasDocument> {
  const text = await source.text(CANVAS_FILE, CANVAS_JSON_MAX);
  if (text === null) throw notArchive(`No ${CANVAS_FILE}`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw notArchive(`${CANVAS_FILE} isn't JSON`);
  }
  try {
    return readDocument(raw);
  } catch (error) {
    if (error instanceof ApiFailure) throw error;
    if (hasIssues(error) && error.issues[0]) {
      const issue = error.issues[0];
      throw new ApiFailure(400, "bad_request", issue.message, { userMessage: describeIssue(issue) });
    }
    throw notArchive(`${CANVAS_FILE} isn't a canvas`);
  }
}

/**
 * manifest.json, each image and link checked on its own so one this build can't read is left out
 * (it shows as missing) instead of refusing the archive. Null for a .ofcanvas.json, or a folder
 * without one.
 */
async function readManifest(source: ArchiveSource): Promise<Manifest | null> {
  if (source.kind === "json") return null;
  const text = await source.text(MANIFEST_FILE, MANIFEST_MAX);
  if (text === null) return null;
  let parsed: z.infer<typeof looseManifest>;
  try {
    parsed = looseManifest.parse(JSON.parse(text));
  } catch {
    throw notArchive(`${MANIFEST_FILE} can't be read`);
  }
  if (parsed.format !== CANVAS_ARCHIVE_FORMAT) {
    if (parsed.format.startsWith("openfield.canvas-archive/")) {
      throw new ApiFailure(409, "conflict", `Archive format ${parsed.format}`, {
        userMessage: t("canvas.errors.newerVersion"),
      });
    }
    throw notArchive(`${MANIFEST_FILE} is ${parsed.format}`);
  }
  const each = <T>(items: unknown[], schema: z.ZodType<T>): T[] =>
    items.flatMap((item) => {
      const one = schema.safeParse(item);
      return one.success ? [one.data] : [];
    });
  return {
    canvasId: parsed.canvas?.id ?? null,
    name: parsed.canvas?.name ?? null,
    assets: each(parsed.assets, canvasArchiveAssetSchema),
    edges: each(parsed.edges, canvasArchiveEdgeSchema),
  };
}

const isMask = (s: Staged) => s.entry.kind === "mask";

/**
 * The masks of images coming in that the canvas doesn't show itself: those its edits were made
 * with. The folder import asks for the same files (archive-jobs needed).
 */
export function archivedMasks(
  shown: readonly string[],
  incoming: readonly Pick<CanvasArchiveAsset, "maskAssetId">[],
): string[] {
  const onCanvas = new Set(shown);
  const masks = incoming.flatMap((entry) => (entry.maskAssetId ? [entry.maskAssetId] : []));
  return [...new Set(masks)].filter((id) => !onCanvas.has(id));
}

/** The library's own copy of these bytes, if it has one. Masks aren't images to show. */
function liveCopy(db: Executor, sha256: string): AssetRow | undefined {
  const row = findLiveAssetBySha256(db, sha256);
  return row && row.kind !== "mask" ? row : undefined;
}

/** Counts bytes as they go by, and stops when the import is canceled. */
function counted(
  stream: ReadableStream<Uint8Array>,
  progress: ImportProgress,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (signal.aborted) {
          controller.error(signal.reason);
          return;
        }
        progress.copied(chunk.byteLength);
        controller.enqueue(chunk);
      },
    }),
  );
}

/** A video's poster: the archive's own still, else its first frame when ffmpeg is here. */
async function stagePoster(
  deps: ImportDeps,
  source: ArchiveSource,
  entry: CanvasArchiveAsset,
  video: StagedFile,
  progress: ImportProgress,
  signal: AbortSignal,
): Promise<string | null> {
  let still: StagedFile | undefined;
  if (entry.poster && source.size(entry.poster) !== null) {
    try {
      still = await deps.ingest.stage(counted(await source.open(entry.poster), progress, signal), {
        folder: "assets",
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      deps.logger.warn("A video's poster in a canvas archive couldn't be read", {
        file: entry.poster,
        error,
      });
    }
  }
  return deps.ingest.poster(video, still);
}

/**
 * The document as this library will keep it: asset ids moved to the rows used here (fingerprints
 * of nodes that were up to date follow, so nothing turns stale and runs again), no spend, and no
 * run left half way.
 */
async function normalise(
  doc: CanvasDocument,
  moved: ReadonlyMap<string, string>,
  ctx: EngineContext,
): Promise<CanvasDocument> {
  let next = doc;
  if (moved.size) {
    const fingerprints = async (d: CanvasDocument) =>
      resolveFingerprints(planFingerprints(fromDocument(d).slice, specRegistry, ctx), new Map());
    const before = await fingerprints(doc);
    const fresh = new Set(
      doc.nodes
        .filter((n) => n.result?.fingerprint && n.result.fingerprint === before[n.id])
        .map((n) => n.id),
    );
    next = remapDocumentAssets(doc, moved);
    if (fresh.size) {
      const after = await fingerprints(next);
      next = {
        ...next,
        nodes: next.nodes.map((node) =>
          fresh.has(node.id) && node.result && after[node.id]
            ? { ...node, result: { ...node.result, fingerprint: after[node.id]! } }
            : node,
        ),
      };
    }
  }
  return {
    ...next,
    nodes: next.nodes.map((node) => {
      const result = node.result;
      if (!result) return node;
      // A run saved mid-way never finishes here: what it made stays, as a stopped run's would.
      const busy = result.state === "queued" || result.state === "running";
      return {
        ...node,
        result: {
          ...result,
          costUsd: null,
          jobSetId: null,
          jobSetIds: [],
          ...(busy && { state: result.assetIds.length ? ("canceled" as const) : ("idle" as const) }),
        },
      };
    }),
  };
}

/**
 * The library row for a new image: the archive's details, its links pointed at images that are
 * here (or none), "Open in Canvas" at the new canvas, and no job or cost: it can't be recreated,
 * like an upload, and never counts as spend.
 */
function assetRow(
  tx: Executor,
  s: Staged,
  moved: ReadonlyMap<string, string>,
  inserted: ReadonlySet<string>,
  canvas: { archiveCanvasId: string; canvasId: string; nodeIds: ReadonlyMap<string, string> },
): Parameters<typeof insertAsset>[1] {
  const { entry, file } = s;
  const here = (id: string | null): string | null => {
    if (!id) return null;
    const mapped = moved.get(id) ?? id;
    return inserted.has(mapped) || getAsset(tx, mapped, { includeDeleted: true }) ? mapped : null;
  };
  // The mask has a foreign key, so it must already be a row.
  const mask = entry.maskAssetId ? (moved.get(entry.maskAssetId) ?? entry.maskAssetId) : null;
  return {
    id: s.id,
    kind: entry.kind,
    modality: isVideoMime(file.mime) ? "video" : "image",
    jobId: null,
    jobSetId: null,
    path: file.path,
    mime: file.mime,
    width: file.width,
    height: file.height,
    bytes: file.bytes,
    sha256: file.sha256,
    seed: entry.seed,
    providerId: entry.providerId,
    modelId: entry.modelId,
    prompt: entry.prompt,
    params: entry.params,
    tags: entry.tags,
    costUsd: null,
    parentAssetId: here(entry.parentAssetId),
    rootAssetId: here(entry.rootAssetId) ?? s.id,
    op: entry.op,
    opParams: opParamsFor(tx, entry.opParams, canvas),
    maskAssetId: mask && getAsset(tx, mask, { includeDeleted: true }) ? mask : null,
    generative: entry.generative,
    approximate: entry.approximate,
    approximateReason: entry.approximateReason,
    ...(isVideoMime(file.mime) && {
      durationMs: file.durationMs ?? entry.durationMs,
      hasAudio: file.hasAudio ?? entry.hasAudio,
      posterPath: s.poster,
    }),
    createdAt: entry.createdAt,
  };
}

/** "Open in Canvas" follows the node to the new canvas; one pointing at a canvas not here goes. */
function opParamsFor(
  tx: Executor,
  opParams: Record<string, unknown> | null,
  canvas: { archiveCanvasId: string; canvasId: string; nodeIds: ReadonlyMap<string, string> },
): Record<string, unknown> | null {
  if (!opParams || typeof opParams.source !== "string") return opParams;
  const { source, ...rest } = opParams;
  const from = parseCanvasSource(source);
  if (from?.canvasId === canvas.archiveCanvasId) {
    const nodeId = canvas.nodeIds.get(from.nodeId);
    if (nodeId) return { ...rest, source: canvasSource(canvas.canvasId, nodeId) };
  } else if (from && getCanvas(tx, from.canvasId)) {
    return opParams;
  }
  return Object.keys(rest).length ? rest : null;
}

/** Links into the new images, where the image at the other end is here too. */
function edgesFor(
  tx: Executor,
  edges: readonly CanvasArchiveEdge[],
  moved: ReadonlyMap<string, string>,
  inserted: ReadonlySet<string>,
): EdgeDraft[] {
  const out: EdgeDraft[] = [];
  for (const edge of edges) {
    const child = moved.get(edge.childAssetId) ?? edge.childAssetId;
    if (!inserted.has(child)) continue;
    const parent = moved.get(edge.parentAssetId) ?? edge.parentAssetId;
    if (!inserted.has(parent) && !getAsset(tx, parent, { includeDeleted: true })) continue;
    out.push({ parentAssetId: parent, childAssetId: child, relation: edge.relation, ordinal: edge.ordinal });
  }
  return out;
}

/** Other tabs hear about the folder and the new images, and the feed's thumbnails start. */
function announce(deps: ImportDeps, folderId: string | null, rows: readonly AssetRow[]): void {
  if (folderId) deps.events.publish("folder.updated", { folderId, deleted: false });
  const rung = THUMB_RUNGS[deps.settings.get().feedZoom] ?? 456;
  for (const row of rows) {
    const current = getAsset(deps.db, row.id) ?? row;
    deps.events.publish("asset.updated", {
      asset: toAssetListItem(current, isFavourite(deps.db, row.id), false),
    });
    const source = thumbSourceOf(current);
    if (source) deps.thumbs.warm(source, Thumbs.sizeFor({ h: rung }));
  }
}
