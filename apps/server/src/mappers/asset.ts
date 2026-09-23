import {
  type Asset,
  type AssetListItem,
  assetFileUrl,
  assetThumbUrl,
  type Modality,
  type ModelKey,
} from "@openfield/core";
import type { AssetRow } from "@openfield/db";

// Asset rows to wire shapes (§0.16). Paths stay on the server; the browser gets URLs.

/** The feed's default rung (§0.10). The client picks others through the same route. */
const FEED_THUMB = { h: 456 } as const;

export function toAssetListItem(row: AssetRow, isFavourite: boolean): AssetListItem {
  return {
    id: row.id,
    kind: row.kind,
    jobSetId: row.jobSetId,
    jobId: row.jobId,
    width: row.width,
    height: row.height,
    mime: row.mime,
    sha256: row.sha256,
    providerId: row.providerId,
    modelId: row.modelId,
    prompt: row.prompt,
    approximate: row.approximate,
    isFavourite,
    createdAt: row.createdAt,
    thumbUrl: assetThumbUrl(row.id, FEED_THUMB),
    fileUrl: assetFileUrl(row.id),
  };
}

export function toAsset(row: AssetRow, isFavourite: boolean): Asset {
  return {
    ...toAssetListItem(row, isFavourite),
    modality: row.modality as Modality,
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

export const modelKeyOf = (providerId: string, modelId: string): ModelKey => `${providerId}:${modelId}`;
