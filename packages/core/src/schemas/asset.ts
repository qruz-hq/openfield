import { z } from "zod";
import {
  ASSET_KINDS,
  BULK_ACTIONS,
  DETAIL_PREVIEW_EDGE,
  EDGE_RELATIONS,
  FILE_STATES,
  THUMB_RUNGS,
} from "../constants";
import {
  cursorSchema,
  hexColorSchema,
  modalitySchema,
  modelIdSchema,
  opSchema,
  outputFormatSchema,
  providerIdSchema,
  queryFlagSchema,
  queryLimitSchema,
  sha256Schema,
  timestampSchema,
  ulidSchema,
  usdSchema,
} from "./common";
import { jobSetSchema } from "./job";

// Assets on the wire (§0.7, §8.3). Paths never leave the server; URLs do.

export const assetKindSchema = z.enum(ASSET_KINDS);

/** One feed or library tile. */
export const assetListItemSchema = z.object({
  id: ulidSchema,
  kind: assetKindSchema,
  jobSetId: ulidSchema.nullable(),
  jobId: ulidSchema.nullable(),
  width: z.int().positive(),
  height: z.int().positive(),
  mime: z.string(),
  sha256: sha256Schema,
  /** "local" for crop, grade and overlay. */
  providerId: z.string().nullable(),
  modelId: modelIdSchema.nullable(),
  prompt: z.string(),
  approximate: z.boolean(),
  isFavourite: z.boolean(),
  createdAt: timestampSchema,
  thumbUrl: z.string(),
  fileUrl: z.string(),
});

export const assetSchema = assetListItemSchema.extend({
  modality: modalitySchema,
  bytes: z.int().nonnegative(),
  seed: z.int().nullable(),
  /** The exact settings that made it. */
  params: z.record(z.string(), z.unknown()).nullable(),
  /** Space-separated. */
  tags: z.string(),
  costUsd: usdSchema.nullable(),
  parentAssetId: ulidSchema.nullable(),
  rootAssetId: ulidSchema,
  op: opSchema.nullable(),
  opParams: z.record(z.string(), z.unknown()).nullable(),
  maskAssetId: ulidSchema.nullable(),
  generative: z.boolean(),
  approximateReason: z.string().nullable(),
  fileState: z.enum(FILE_STATES),
  updatedAt: timestampSchema,
  deletedAt: timestampSchema.nullable(),
});

export const folderSchema = z.object({
  id: ulidSchema,
  name: z.string().min(1).max(200),
  color: hexColorSchema.nullable(),
  parentId: ulidSchema.nullable(),
  sortOrder: z.int(),
  /** Live assets in the folder. */
  count: z.int().nonnegative(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

/** GET /api/assets */
export const assetsListQuerySchema = z.object({
  cursor: cursorSchema.optional(),
  limit: queryLimitSchema.optional(),
  folder: ulidSchema.optional(),
  favourite: queryFlagSchema.optional(),
  q: z.string().max(500).optional(),
  model: modelIdSchema.optional(),
  provider: providerIdSchema.optional(),
  kind: assetKindSchema.optional(),
  from: timestampSchema.optional(),
  to: timestampSchema.optional(),
  modality: modalitySchema.optional(),
});
export const assetsListResponseSchema = z.object({
  items: z.array(assetListItemSchema),
  nextCursor: cursorSchema.nullable(),
});

/** GET /api/assets/:id */
export const assetDetailResponseSchema = z.object({
  asset: assetSchema,
  jobSet: jobSetSchema.nullable(),
  params: z.record(z.string(), z.unknown()).nullable(),
  references: z.array(assetSchema),
  lineage: z.object({ ancestors: z.array(assetSchema), children: z.array(assetSchema) }),
  folders: z.array(folderSchema),
  isFavourite: z.boolean(),
});

/** PATCH /api/assets/:id */
export const assetPatchBodySchema = z.strictObject({ tags: z.string().max(2000).optional() });

/** DELETE /api/assets/:id */
export const assetDeleteQuerySchema = z.object({ hard: queryFlagSchema.optional() });

/** PUT/DELETE /api/assets/:id/favourite */
export const favouriteResponseSchema = z.object({ isFavourite: z.boolean() });

/** PUT/DELETE /api/assets/:id/folders/:folderId */
export const assetFoldersResponseSchema = z.object({ folders: z.array(folderSchema) });

/** POST /api/assets/bulk */
export const assetBulkBodySchema = z
  .object({
    ids: z.array(ulidSchema).min(1).max(5000),
    action: z.enum(BULK_ACTIONS),
    folderId: ulidSchema.optional(),
  })
  .refine(
    (b) => (b.action === "addFolder" || b.action === "removeFolder" ? b.folderId !== undefined : true),
    {
      message: "folderId is required for folder actions",
      path: ["folderId"],
    },
  );
export const assetBulkResponseSchema = z.object({ affected: z.int().nonnegative() });

/** GET /api/assets/:id/lineage: the multi-parent reference graph. */
export const lineageResponseSchema = z.object({
  nodes: z.array(assetSchema.extend({ depth: z.int().nonnegative() })),
  edges: z.array(
    z.object({
      parentAssetId: ulidSchema,
      childAssetId: ulidSchema,
      relation: z.enum(EDGE_RELATIONS),
      ordinal: z.int().nonnegative(),
    }),
  ),
});

/** POST /api/uploads and POST /api/masks */
export const uploadResponseSchema = z.object({
  asset: assetSchema,
  /** The same bytes were already in the library. */
  duplicate: z.boolean(),
});

/** GET /api/assets/:id/export */
export const assetExportQuerySchema = z.object({
  format: outputFormatSchema.optional(),
  metadata: queryFlagSchema.optional(),
  sidecar: queryFlagSchema.optional(),
});

/** GET /files/thumb/:id. The server rounds h up to the nearest rung. */
export const thumbQuerySchema = z.object({
  h: z.coerce
    .number()
    .int()
    .min(1)
    .max(THUMB_RUNGS[THUMB_RUNGS.length - 1]!)
    .optional(),
  dpr: z.enum(["1", "2"]).optional(),
  p: z.literal(String(DETAIL_PREVIEW_EDGE)).optional(),
});

/** POST /api/folders */
export const folderCreateBodySchema = z.object({
  name: z.string().trim().min(1).max(200),
  parentId: ulidSchema.optional(),
  color: hexColorSchema.optional(),
});
/** PATCH /api/folders/:id */
export const folderPatchBodySchema = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  parentId: ulidSchema.nullable().optional(),
  color: hexColorSchema.nullable().optional(),
  sortOrder: z.int().optional(),
});
export const foldersListResponseSchema = z.array(folderSchema);

export type AssetListItem = z.infer<typeof assetListItemSchema>;
export type Asset = z.infer<typeof assetSchema>;
export type Folder = z.infer<typeof folderSchema>;
export type AssetsListQuery = z.infer<typeof assetsListQuerySchema>;
export type AssetsListResponse = z.infer<typeof assetsListResponseSchema>;
export type AssetDetailResponse = z.infer<typeof assetDetailResponseSchema>;
export type AssetBulkBody = z.infer<typeof assetBulkBodySchema>;
export type LineageResponse = z.infer<typeof lineageResponseSchema>;
export type UploadResponse = z.infer<typeof uploadResponseSchema>;
