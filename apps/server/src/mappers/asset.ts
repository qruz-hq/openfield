import {
  type Asset,
  type AssetListItem,
  assetFileUrl,
  assetPosterUrl,
  assetThumbUrl,
  type Folder,
  type Modality,
  type ModelKey,
} from "@openfield/core";
import type { AssetRow, FolderWithCount } from "@openfield/db";

// Asset rows to wire shapes (§0.16). Paths stay on the server; the browser gets URLs.

/** The feed's default rung (§0.10). The client picks others through the same route. */
const FEED_THUMB = { h: 456 } as const;

/**
 * `rerun`: the job that made it ran again after a restart (jobs.rerun_at, §0.4). An image in the
 * Trash gets `?trash=1` on its URLs, since the file routes only serve it when asked that way, and
 * its deletedAt, which the Trash groups and pages by.
 */
export function toAssetListItem(row: AssetRow, isFavourite: boolean, rerun: boolean): AssetListItem {
  const trashed = row.deletedAt !== null;
  const video = row.modality === "video";
  return {
    id: row.id,
    kind: row.kind,
    jobSetId: row.jobSetId,
    jobId: row.jobId,
    modality: row.modality as Modality,
    width: row.width,
    height: row.height,
    mime: row.mime,
    // A video's own fields; an image leaves them out, so image payloads read as they always did.
    ...(video && {
      durationMs: row.durationMs,
      hasAudio: row.hasAudio,
      posterUrl: row.posterPath ? assetPosterUrl(row.id) + (trashed ? "?trash=1" : "") : null,
    }),
    sha256: row.sha256,
    providerId: row.providerId,
    modelId: row.modelId,
    prompt: row.prompt,
    approximate: row.approximate,
    isFavourite,
    rerun,
    createdAt: row.createdAt,
    ...(trashed && { deletedAt: row.deletedAt! }),
    thumbUrl: assetThumbUrl(row.id, FEED_THUMB) + (trashed ? "&trash=1" : ""),
    fileUrl: assetFileUrl(row.id) + (trashed ? "?trash=1" : ""),
  };
}

export function toAsset(row: AssetRow, isFavourite: boolean, rerun: boolean): Asset {
  return {
    ...toAssetListItem(row, isFavourite, rerun),
    bytes: row.bytes,
    seed: row.seed,
    params: row.params,
    tags: row.tags,
    costUsd: row.costUsd,
    parentAssetId: row.parentAssetId,
    rootAssetId: row.rootAssetId,
    op: row.op,
    opParams: row.opParams,
    maskAssetId: row.maskAssetId,
    generative: row.generative,
    approximateReason: row.approximateReason,
    fileState: row.fileState,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

/** GET /api/folders stays flat (§8.3): the client counts subfolders from parentId. */
export function toFolder(row: FolderWithCount): Folder {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    parentId: row.parentId,
    sortOrder: row.sortOrder,
    count: row.count,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const modelKeyOf = (providerId: string, modelId: string): ModelKey => `${providerId}:${modelId}`;
